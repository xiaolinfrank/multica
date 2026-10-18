"use client";

import { useCallback, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  cockpitMeetingOperationBasisOptions, cockpitMeetingLifecycleOptions, cockpitMeetingPreparationDraftKey,
  useCockpitMeetingPreparationDraftStore, cockpitMeetingPreparationPath,
} from "@multica/core/cockpit";
import type { CockpitMeeting, CockpitMeetingDispositionTransition, CockpitMeetingOperationBasis } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Ellipsis } from "lucide-react";
import { useT } from "../../i18n";
import { AppLink, useNavigation } from "../../navigation";
import { CockpitFlowError } from "./cockpit-task-flow";
import { CockpitPreparationReasons } from "./cockpit-preparation-preview";
import { CockpitMeetingDispositionForm, CockpitMeetingPendingResponsibilities } from "./cockpit-meeting-disposition";
import { CockpitMeetingCancellation } from "./cockpit-meeting-cancellation";

type Action = "cancel" | "append_disposition" | CockpitMeetingDispositionTransition;
export function CockpitMeetingOperationsMenu({ wsId, meeting, open, onOpenChange, available, dispositionAvailable, readOnly, legacyDeleteAllowed, onDelete, onPrepared }: {
  wsId: string; meeting: CockpitMeeting; open: boolean; onOpenChange: (open: boolean) => void;
  available: boolean; dispositionAvailable: boolean; readOnly: boolean; legacyDeleteAllowed: boolean; onDelete: () => void;
  onPrepared: (id: string, autoStart: boolean) => void;
}) {
  const { t } = useT("cockpit"); const [action, setAction] = useState<Action | null>(null); const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const reportBusy = useCallback((value: boolean) => { busyRef.current = value; setBusy(value); }, []);
  const basis = useQuery({ ...cockpitMeetingOperationBasisOptions(wsId, meeting.id), enabled: available && open }); const data = basis.data;
  const lifecycle = useQuery({ ...cockpitMeetingLifecycleOptions(wsId, meeting.id), enabled: dispositionAvailable && open });
  const pending = useCockpitMeetingPreparationDraftStore((state) => state.draft.commands);
  const canRead = data?.availability === "available" && !basis.isError;
  const allowed = (action: Action) => !readOnly && canRead && data[action].state === "allowed" && (action === "cancel" ? ["unconfirmed", "scheduled"].includes(lifecycle.data?.occurrence.state ?? "") : action === "reinstate" || action === "append_disposition" ? lifecycle.data?.occurrence.state === "cancelled" : Boolean(lifecycle.data?.archive));
  const hasPending = (action: Action) => Boolean(pending[cockpitMeetingPreparationDraftKey(wsId, action === "cancel" ? "cancellation" : action === "append_disposition" ? "append_disposition" : "disposition", meeting.id, ...(action === "cancel" || action === "append_disposition" ? [] : [action]))]);
  const occurrenceChoices = (["cancel", "reinstate", "append_disposition"] as const).filter((choice) => (lifecycle.data?.occurrence.state === "cancelled" ? choice !== "cancel" : choice === "cancel") || hasPending(choice));
  const archiveChoices = (["archive", "unarchive"] as const).filter((choice) => choice === (lifecycle.data?.archive?.archived_at ? "unarchive" : "archive") || hasPending(choice));
  const close = () => { setAction(null); onOpenChange(false); };
  return <Dialog open={open} onOpenChange={(next) => { if (!busyRef.current) { if (!next) setAction(null); onOpenChange(next); } }}>
    <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t(($) => $.meeting_disposition.actions)} />}><Ellipsis /></DialogTrigger>
    {open && <DialogContent className="flex max-h-[88dvh] flex-col overflow-hidden sm:max-w-3xl"><DialogHeader><DialogTitle>{action ? t(($) => $.meeting_disposition[action]) : t(($) => $.meeting_disposition.actions)}</DialogTitle></DialogHeader>
      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain">
        {action && <Button variant="outline" size="sm" disabled={busy} onClick={() => setAction(null)}>{t(($) => $.meeting_disposition.back_actions)}</Button>}
        {available && (basis.isPending ? <Spinner /> : basis.isError || !data ? <CockpitFlowError onRetry={() => void basis.refetch()} /> : null)}
        {action && data ? (action === "cancel" || action === "append_disposition") ? <CockpitMeetingCancellation key={`${wsId}:${meeting.id}:${action}`} append={action === "append_disposition"} wsId={wsId} basis={data} disabled={readOnly || basis.isError} onBusy={reportBusy} onCreated={(id, autoStart) => { close(); onPrepared(id, autoStart); }} />
          : <CockpitMeetingDispositionForm key={`${wsId}:${meeting.id}:${action}`} wsId={wsId} basis={data} transition={action} disabled={readOnly || basis.isError} onBusy={reportBusy} onDone={close} onRefresh={() => void basis.refetch()} />
          : <>
            {dispositionAvailable && data && <>
              <CockpitMeetingPendingResponsibilities basis={data} />
              {lifecycle.isError ? <CockpitFlowError onRetry={() => void lifecycle.refetch()} /> : lifecycle.isPending ? <Spinner /> : lifecycle.data && <div className="space-y-3">
                {occurrenceChoices.map((choice) => <div key={choice} className="space-y-2"><Button variant="outline" disabled={!allowed(choice) && !hasPending(choice)} onClick={() => setAction(choice)}>{t(($) => $.meeting_disposition[choice])}</Button>
                  {data[choice].state !== "allowed" && <CockpitPreparationReasons codes={data[choice].reason_codes} targets={data.targets} />}</div>)}
                {archiveChoices.map((choice) => <div key={choice} className="space-y-2"><Button variant="outline" disabled={!allowed(choice) && !hasPending(choice)} onClick={() => setAction(choice)}>{t(($) => $.meeting_disposition[choice])}</Button>
                  {data[choice].state !== "allowed" && <CockpitPreparationReasons codes={data[choice].reason_codes} targets={data.targets} />}</div>)}
              </div>}
            </>}
            <section className="space-y-2 border-t border-border pt-3"><Button variant="ghost" className="text-destructive hover:text-destructive" disabled={readOnly || (available ? !canRead || data?.delete.state !== "allowed" : !legacyDeleteAllowed)} onClick={() => { close(); onDelete(); }}>{t(($) => $.meeting.delete, { title: meeting.title || meeting.code })}</Button>
              {available && data?.delete.state === "blocked" ? <><CockpitPreparationReasons codes={data.delete.reason_codes} targets={data.targets} /><p className="text-caption text-muted-foreground">{t(($) => $.meeting_disposition.archive_instead)}</p></>
                : available && data && (!canRead || data.delete.state === "unknown") ? <div className="space-y-2 text-caption"><p>{t(($) => $.meeting_disposition.check_required)}</p><Button variant="outline" size="sm" onClick={() => void basis.refetch()}>{t(($) => $.binding.retry)}</Button></div>
                : !available && !legacyDeleteAllowed && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.delete_protected)}</p>}
            </section>
          </>}
      </div>
    </DialogContent>}
  </Dialog>;
}

export function CockpitMeetingRetentionNotice({ meeting, basis, onManage }: { meeting: CockpitMeeting; basis?: CockpitMeetingOperationBasis | null; onManage: () => void }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation();
  if (!meeting.archived_at && meeting.occurrence_state !== "cancelled") return null;
  return <section className="space-y-2 text-caption"><p className="font-medium">{[meeting.archived_at ? t(($) => $.meeting_disposition.archived) : "", meeting.occurrence_state === "cancelled" ? t(($) => $.meeting_disposition.cancelled) : ""].filter(Boolean).join(" · ")}</p>
    <p className="text-muted-foreground">{meeting.archived_at ? t(($) => $.meeting_disposition.archive_hint) : t(($) => $.meeting_disposition.cancelled_hint)}</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={onManage}>{t(($) => $.meeting_disposition.actions)}</Button>
      {basis?.current_operation && <AppLink className="py-1 text-primary underline" href={cockpitMeetingPreparationPath(paths.cockpit(), meeting.id, basis.current_operation.id, navigation.searchParams)}>{t(($) => $.meeting_preparation.cancellation)}</AppLink>}</div>
  </section>;
}
