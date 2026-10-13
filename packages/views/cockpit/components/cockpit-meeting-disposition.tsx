"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  cockpitMeetingPreparationDraftKey, useCockpitMeetingPreparationDraftStore, setCockpitPreparationForm, clearCockpitPreparationForm,
  useCockpitMeetingDisposition, cockpitLifecycleCommandOptions, cockpitLifecycleAcknowledged, invalidateCockpitMeetingPreparationFacts,
  cockpitMeetingContextPath, cockpitScope, type CockpitPreparationFormDraft,
} from "@multica/core/cockpit";
import type { CockpitMeetingDispositionTransition, CockpitMeetingOperationBasis } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { AppLink, useNavigation } from "../../navigation";
import { useCockpitPreparationRequest } from "./use-cockpit-preparation-request";
import { CockpitPreparationReasons } from "./cockpit-preparation-preview";
import { createSafeId } from "@multica/core/utils";

export function CockpitMeetingPendingResponsibilities({ basis }: { basis: CockpitMeetingOperationBasis }) {
  const { t } = useT("cockpit"); const navigation = useNavigation(); const paths = useWorkspacePaths();
  const href = (view: "preparation" | "recording" | "minutes_review" | "resources" | "details") => cockpitMeetingContextPath(paths.cockpit(), basis.meeting_id, cockpitScope(navigation.searchParams), navigation.searchParams, view);
  const rows = ([{ key: "minutes_review", view: "minutes_review" }, { key: "draft_actions", view: "minutes_review" }, { key: "active_preparation_issues", view: "preparation" },
    { key: "active_runs", view: "preparation" }, { key: "nas_operations", view: "minutes_review" }, { key: "preparation_operations", view: "details" }, { key: "directory_operations", view: "resources" }] as const).filter((item) => (basis.pending[item.key] ?? 0) > 0);
  return rows.length > 0 ? <section className="space-y-2 rounded-md border border-border p-3"><h3 className="text-body font-medium">{t(($) => $.meeting_disposition.remaining)}</h3><ul className="space-y-1">{rows.map((item) => <li key={item.key} className="text-caption"><AppLink target="_blank" rel="noopener noreferrer" className="text-primary underline" href={href(item.view)}>{item.key === "directory_operations" ? t(($) => $.meeting_directory.pending_directory, { count: basis.pending[item.key] ?? 0 }) : t(($) => $.meeting_disposition[item.key], { count: basis.pending[item.key] ?? 0 })} {t(($) => $.action_flow.new_tab)}</AppLink></li>)}</ul></section> : null;
}

export function CockpitMeetingDispositionForm({ wsId, basis, transition, disabled, onBusy, onDone, onRefresh }: {
  wsId: string; basis: CockpitMeetingOperationBasis; transition: CockpitMeetingDispositionTransition; disabled: boolean;
  onBusy: (busy: boolean) => void; onDone: () => void; onRefresh: () => void;
}) {
  const { t } = useT("cockpit"); const client = useQueryClient(); const key = cockpitMeetingPreparationDraftKey(wsId, "disposition", basis.meeting_id, transition);
  const request = useCockpitPreparationRequest(key); const mutation = useCockpitMeetingDisposition(wsId, basis.meeting_id);
  const pending = request.pending?.kind === "disposition" ? request.pending : null;
  const [initial] = useState<Extract<CockpitPreparationFormDraft, { kind: "disposition" }>>(() => ({ kind: "disposition", observedRevision: pending?.body.expected_revision ?? basis.lifecycle_revision ?? 0, transition, reason: pending?.body.reason ?? "" }));
  const stored = useCockpitMeetingPreparationDraftStore((state) => state.draft.forms[key]); const value = stored?.kind === "disposition" ? stored : initial;
  const changed = value.observedRevision !== basis.lifecycle_revision;
  const permitted = !disabled && basis.availability === "available" && basis[transition].state === "allowed";
  useEffect(() => { onBusy(request.busy); return () => onBusy(false); }, [request.busy, onBusy]);
  const save = async () => {
    if (request.busy || !permitted || pending && !request.canRetry || !pending && (!value.reason.trim() || changed)) return;
    setCockpitPreparationForm(key, value);
    const result = await request.run(pending ?? { kind: "disposition", meetingId: basis.meeting_id,
      body: { command_key: createSafeId(), expected_revision: value.observedRevision, transition, reason: value.reason.trim() } }, async (command) => {
      if (command.kind !== "disposition") throw new Error(t(($) => $.meeting_preparation.check_first)); return mutation.mutateAsync(command.body);
    });
    if (result) { clearCockpitPreparationForm(key, value); if (result.stillCurrent()) onDone(); }
  };
  const verify = async () => {
    const result = await request.verify(async (command) => {
      if (command.kind !== "disposition") throw new Error(t(($) => $.meeting_preparation.check_first));
      const detail = await client.fetchQuery({ ...cockpitLifecycleCommandOptions(wsId, basis.meeting_id, command.body.command_key), staleTime: 0 });
      if (!detail || !cockpitLifecycleAcknowledged(detail, command.body.transition, command.body)) throw new Error(t(($) => $.meeting_preparation.check_first));
      await invalidateCockpitMeetingPreparationFacts(client, wsId, basis.meeting_id); return detail;
    });
    if (result) { clearCockpitPreparationForm(key, value); if (result.stillCurrent()) onDone(); }
  };
  return <section className="space-y-3"><p className="text-caption text-muted-foreground">{t(($) => $.meeting_disposition[`${transition}_hint`])}</p>
    {transition === "archive" && <CockpitMeetingPendingResponsibilities basis={basis} />}
    <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.reason)}<Textarea className="max-h-56 resize-y overflow-y-auto" disabled={request.busy || Boolean(pending)} value={value.reason} onChange={(event) => setCockpitPreparationForm(key, { ...value, reason: event.target.value })} /></label>
    {!permitted && <CockpitPreparationReasons codes={basis[transition].reason_codes} targets={basis.targets} />}
    {changed && !pending && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.meeting_preparation.reason_context)}</p><Button size="sm" variant="outline" onClick={onRefresh}>{t(($) => $.meeting_lifecycle.refresh)}</Button><Button size="sm" variant="outline" disabled={!permitted} onClick={() => setCockpitPreparationForm(key, { ...value, observedRevision: basis.lifecycle_revision ?? value.observedRevision })}>{t(($) => $.meeting_lifecycle.rebase)}</Button></div>}
    {pending && <div className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.pending_hint)}</p><Button variant="outline" size="sm" disabled={request.busy} onClick={() => void verify()}>{t(($) => $.meeting_lifecycle.check_command)}</Button></div>}
    {request.error && <p role="alert" className="break-words text-caption text-destructive">{request.error}</p>}
    <Button disabled={request.busy || !permitted || Boolean(pending) && !request.canRetry || !pending && (!value.reason.trim() || changed)} onClick={() => void save()} aria-busy={request.busy}>{request.busy && <Spinner />}{pending ? t(($) => $.meeting_lifecycle.retry_command) : t(($) => $.meeting_disposition[transition])}</Button>
  </section>;
}
