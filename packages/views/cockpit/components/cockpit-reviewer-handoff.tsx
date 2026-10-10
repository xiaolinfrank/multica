"use client";

import { useId, useRef, useState } from "react";
import { ApiError } from "@multica/core/api";
import {
  acknowledgeCockpitCompactReviewerHandoff, CockpitUnconfirmedWriteError,
  EMPTY_COCKPIT_REVIEWER_HANDOFF_DRAFT, prepareCockpitReviewerHandoff, rejectCockpitReviewerHandoff,
  setCockpitReviewerHandoffDraft, useCockpitReviewerHandoffDraftStore, useReassignCockpitMeetingReviewer,
} from "@multica/core/cockpit";
import type { CockpitMeetingWorkflowSummary, MemberWithUser } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { settingsHref } from "../../settings/components/settings-navigation";
import { CockpitReviewerSelect } from "./cockpit-reviewer-select";

export function CockpitReviewerHandoffControl({ wsId, workflow, members, membersLoaded, canTransfer, disabled, onReload }: {
  wsId: string;
  workflow: CockpitMeetingWorkflowSummary;
  members: MemberWithUser[];
  membersLoaded: boolean;
  canTransfer: boolean;
  disabled: boolean;
  onReload: () => void;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [observedRevision, setObservedRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const transfer = useReassignCockpitMeetingReviewer(wsId);
  const meetingId = workflow.meeting_id;
  const draft = useCockpitReviewerHandoffDraftStore((state) => state.draft.byMeeting[meetingId] ?? EMPTY_COCKPIT_REVIEWER_HANDOFF_DRAFT);
  const current = workflow.current_version;
  const candidates = members.filter((member) => member.user_id !== workflow.reviewer_id);
  const currentName = members.find((member) => member.user_id === workflow.reviewer_id)?.name || workflow.reviewer_id;
  const staleObservation = open && !draft.pending && observedRevision !== workflow.revision;
  const canConfirm = canTransfer && !disabled && !busy && (Boolean(draft.pending)
    || (!staleObservation && observedRevision !== null && membersLoaded
      && candidates.some((member) => member.user_id === draft.reviewer_id) && Boolean(draft.reason.trim())));



  async function confirm() {
    const revision = draft.pending?.expected_revision ?? observedRevision;
    if (lock.current || !canConfirm || revision === null) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const body = prepareCockpitReviewerHandoff(meetingId, revision, draft.handoff_key || crypto.randomUUID());
    try {
      const result = await transfer.mutateAsync({ meetingId, body });
      acknowledgeCockpitCompactReviewerHandoff(meetingId, result);
      setOpen(false);
    } catch (cause) {
      if (cause instanceof ApiError && [400, 403, 404, 409, 422].includes(cause.status)) rejectCockpitReviewerHandoff(meetingId);
      setError(cause instanceof CockpitUnconfirmedWriteError ? t(($) => $.workflow.unconfirmed)
        : cause instanceof Error ? cause.message : t(($) => $.workflow.command_failed));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return <div className="space-y-2">
    {draft.pending && !open && <p role="status" className="text-caption text-muted-foreground">{t(($) => $.workflow.handoff_unconfirmed)}</p>}
    <AlertDialog open={open} onOpenChange={(next) => {
      if (lock.current) return;
      setOpen(next);
      if (next) { setObservedRevision(workflow.revision); setError(""); }
    }}>
      {canTransfer && <AlertDialogTrigger render={<Button type="button" size="sm" variant="outline" disabled={disabled || (!membersLoaded && !draft.pending)} />}>
        {draft.pending ? t(($) => $.workflow.handoff_retry) : t(($) => $.workflow.handoff_action)}
      </AlertDialogTrigger>}
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] max-w-[calc(100%-2rem)] overflow-y-auto sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>{t(($) => $.workflow.handoff_action)}</AlertDialogTitle>
          <AlertDialogDescription>{draft.pending ? t(($) => $.workflow.handoff_unconfirmed)
            : current?.decision === "pending" ? t(($) => $.workflow.handoff_pending_scope, { number: current.version_number })
              : t(($) => $.workflow.handoff_future_scope)}</AlertDialogDescription>
        </AlertDialogHeader>
        <p className="break-words text-caption text-muted-foreground">{t(($) => $.workflow.reviewer_name, { name: currentName })}</p>
        {draft.pending ? <p className="break-words text-caption">{t(($) => $.workflow.handoff_target, {
          name: members.find((member) => member.user_id === draft.pending?.reviewer_id)?.name || draft.pending.reviewer_id,
        })}</p> : <CockpitReviewerSelect members={candidates} value={draft.reviewer_id}
          label={t(($) => $.workflow.handoff_new_reviewer)} disabled={busy || !canTransfer || !membersLoaded}
          onChange={(reviewer_id) => setCockpitReviewerHandoffDraft(meetingId, { reviewer_id })} />}
        {!draft.pending && membersLoaded && candidates.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.handoff_no_candidates)}{" "}
          <AppLink href={settingsHref(paths.settings(), new URLSearchParams(), "members")} target="_blank" rel="noreferrer" className="text-primary underline">{t(($) => $.workflow.open_members)}</AppLink></p>}
        <div className="space-y-1"><label htmlFor={`${id}-reason`} className="text-caption">{t(($) => $.workflow.handoff_reason)}</label>
          <Textarea id={`${id}-reason`} value={draft.reason} required rows={3} disabled={busy || Boolean(draft.pending) || !canTransfer}
            onChange={(event) => setCockpitReviewerHandoffDraft(meetingId, { reason: event.target.value })} />
        </div>
        {!canTransfer && <p role="status" className="text-caption text-muted-foreground">{t(($) => $.workflow.handoff_manager_only)}</p>}
        {staleObservation && <p role="alert" className="rounded-md bg-warning-subtle p-3 text-caption text-foreground">{t(($) => $.workflow.handoff_stale)}</p>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        {draft.pending && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onReload}>{t(($) => $.workflow.refresh_status)}</Button>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t(($) => $.binding.cancel)}</AlertDialogCancel>
          <Button type="button" disabled={!canConfirm} aria-busy={busy} onClick={() => void confirm()}>
            {busy && <Spinner />}{draft.pending ? t(($) => $.workflow.handoff_retry) : t(($) => $.workflow.handoff_confirm)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {draft.pending && !canTransfer && <Button type="button" size="sm" variant="outline" onClick={onReload}>{t(($) => $.workflow.refresh_status)}</Button>}
  </div>;
}
