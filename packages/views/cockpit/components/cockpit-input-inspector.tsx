"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitInputContextPath, cockpitMeetingDetailOptions, cockpitMeetingInputReferencesOptions, cockpitAgendaInputReferencesOptions, cockpitAgendaDetailOptions, cockpitScope, cockpitDestination } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitInputDetail } from "./cockpit-input-detail";
import { CockpitInputMeetingHandoff } from "./cockpit-input-meeting-handoff";
import { CockpitInputProblem } from "./cockpit-input-problem";
import { CockpitFlowError } from "./cockpit-task-flow";
import { CockpitInputReferenceForm } from "./cockpit-input-reference-form";

/** This inspector also handles input-only URLs, with no meeting or L3 required. */
export function CockpitInputInspector({ wsId, accountId, inputsAvailable }: { wsId: string; accountId: string; inputsAvailable: boolean }) {
  const { t } = useT("cockpit");
  const navigation = useNavigation();
  const inputId = navigation.searchParams.get("input");
  const versionId = navigation.searchParams.get("input_version");
  const meetingId = navigation.searchParams.get("meeting");
  // The agenda reader lives in both stage views (preparation and recording);
  // legacy "agenda"/"workflow" spellings normalize on read, so match by view.
  const stageView = cockpitDestination(navigation.searchParams).meetingView;
  const agendaId = (stageView === "preparation" || stageView === "recording") ? navigation.searchParams.get("agenda") : null;
  const signature = JSON.stringify([wsId, accountId, inputId, versionId, meetingId, agendaId]);
  const [association, setAssociation] = useState<{ signature: string; versionId: string } | null>(null);
  const associating = association?.signature === signature ? association : null;
  const context = useQuery({ ...cockpitMeetingDetailOptions(wsId, meetingId || "", cockpitScope(navigation.searchParams)), enabled: Boolean(inputId && meetingId && inputsAvailable) });
  const agenda = useQuery({ ...cockpitAgendaDetailOptions(wsId, meetingId || "", agendaId || ""), enabled: Boolean(inputId && meetingId && agendaId && inputsAvailable) });
  const options = agendaId ? cockpitAgendaInputReferencesOptions(wsId, meetingId || "", agendaId, { pageSize: 1 }) : cockpitMeetingInputReferencesOptions(wsId, meetingId || "", { pageSize: 1 });
  const references = useQuery({ ...options, enabled: Boolean(inputId && meetingId && inputsAvailable) });
  const canAdd = inputsAvailable && references.data?.canAdd === true && !references.isError && context.data?.actor.is_human === true;
  const targetLabel = [context.data?.meeting.title, agendaId ? agenda.data?.title : null].filter(Boolean).join(" · ");
  const close = () => navigation.push(cockpitInputContextPath(navigation.pathname, navigation.searchParams, null));
  if (!inputId) return null;
  return <Dialog open onOpenChange={(open) => { if (!open) close(); }}><DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-3xl"><DialogHeader>
    <DialogTitle>{associating ? t(($) => $.input_materials.link_version) : t(($) => $.input_materials.material_detail)}</DialogTitle>
  </DialogHeader><div className="min-h-0 overflow-y-auto overscroll-contain pr-1">
    {associating && meetingId ? <CockpitInputReferenceForm key={`${signature}:${associating.versionId}`} wsId={wsId} accountId={accountId} meetingId={meetingId} agendaId={agendaId}
      versionId={associating.versionId} targetLabel={targetLabel} canAdd={canAdd} onDone={close} onCancel={() => setAssociation(null)} />
      : <CockpitInputDetail key={`${wsId}:${accountId}:${inputId}`} wsId={wsId} accountId={accountId} inputId={inputId} versionId={versionId}
        onVersionChange={(id) => navigation.push(cockpitInputContextPath(navigation.pathname, navigation.searchParams, inputId, id))}
        actions={meetingId && inputsAvailable ? (version) => <div className="space-y-2"><Button type="button" variant="outline" size="sm" disabled={!canAdd || !version.canReference || !targetLabel}
          onClick={() => setAssociation({ signature, versionId: version.id })}>{agendaId ? t(($) => $.input_materials.link_to_agenda) : t(($) => $.input_materials.link_to_meeting)}</Button>
          {context.data?.capabilities?.run_input_manifests === true && <CockpitInputMeetingHandoff key={version.id} wsId={wsId} accountId={accountId} meetingId={meetingId} versionId={version.id} disabled={!version.canReference || version.captureState !== "ready"} />}
          {references.data && <CockpitInputProblem codes={references.data.blockedReasons} />}
          {references.isError && <CockpitFlowError onRetry={() => void references.refetch()} />}
          {context.isError && <CockpitFlowError onRetry={() => void context.refetch()} />}
          {agendaId && agenda.isError && <CockpitFlowError onRetry={() => void agenda.refetch()} />}
          {!canAdd && !references.isError && references.data?.blockedReasons.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.add_unavailable)}</p>}
        </div> : undefined} />}
  </div></DialogContent></Dialog>;
}
