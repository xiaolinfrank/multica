"use client";

import { useState } from "react";
import {
  cockpitMeetingDirectoryDraftKey, useCockpitMeetingDirectoryDraftStore, setCockpitDirectoryForm, clearCockpitDirectoryForm,
  type CockpitDirectoryFormDraft,
} from "@multica/core/cockpit";
import type { CockpitDirectoryOperationHeader } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitDirectoryReasons, knownDirectoryStates } from "./cockpit-directory-parts";
import { useCockpitDirectoryCommand } from "./use-cockpit-directory-command";

type Transition = "pause" | "resume" | "claim" | "abandon";
export function CockpitDirectoryControl({ wsId, header, transition, readOnly, refresh }: {
  wsId: string; header: CockpitDirectoryOperationHeader; transition: Transition; readOnly?: boolean; refresh: () => void;
}) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false);
  const key = cockpitMeetingDirectoryDraftKey(wsId, header.meeting_id, "control", header.id, transition);
  const request = useCockpitDirectoryCommand(wsId, header.meeting_id, key, header.id);
  const pending = request.pending?.kind === "control" ? request.pending : null;
  const [initial] = useState<Extract<CockpitDirectoryFormDraft, { kind: "control" }>>(() => ({ kind: "control", transition,
    observedRevision: pending?.body.expected_revision ?? header.revision, reason: pending?.body.reason ?? "" }));
  const stored = useCockpitMeetingDirectoryDraftStore((state) => state.draft.forms[key]); const value = stored?.kind === "control" ? stored : initial;
  const permitted = !readOnly && knownDirectoryStates.has(header.state) && !["completed", "abandoned"].includes(header.state) && header[`can_${transition}`] === true;
  const changed = value.observedRevision !== header.revision;
  const needsReason = transition === "claim" || transition === "abandon";
  const save = async () => {
    if (!permitted || request.busy || pending && !request.canRetry || !pending && (changed || needsReason && !value.reason.trim() || new TextEncoder().encode(value.reason.trim()).length > 16000)) return;
    setCockpitDirectoryForm(key, value);
    const response = await request.run(pending ?? { kind: "control", meetingId: header.meeting_id, operationId: header.id,
      body: { command_key: crypto.randomUUID(), expected_revision: value.observedRevision, transition, reason: value.reason.trim() } });
    if (response) { clearCockpitDirectoryForm(key, value); if (response.stillCurrent()) setOpen(false); }
  };
  const verify = async () => { const response = await request.verify(); if (response) { clearCockpitDirectoryForm(key, value); if (response.stillCurrent()) setOpen(false); } };
  if (!permitted && !pending && !stored) return null;
  return <Dialog open={open} onOpenChange={(next) => {
    if (request.busy) return;
    if (next && !stored && !pending) setCockpitDirectoryForm(key, { kind: "control", transition, observedRevision: header.revision, reason: "" });
    if (!next && !pending && value.reason === "") clearCockpitDirectoryForm(key, value);
    setOpen(next);
  }}><DialogTrigger render={<Button variant="outline" size="sm" />}>{t(($) => $.meeting_directory[transition])}</DialogTrigger>
    <DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{t(($) => $.meeting_directory[transition])}</DialogTitle></DialogHeader>
      <p className="text-caption text-muted-foreground">{t(($) => $.meeting_directory[`${transition}_hint`])}</p>
      <label className="block space-y-1 text-caption">{needsReason ? t(($) => $.meeting_lifecycle.reason) : t(($) => $.meeting_directory.optional_reason)}<Textarea className="max-h-48 resize-y overflow-y-auto" value={value.reason} disabled={request.busy || Boolean(pending)} onChange={(event) => setCockpitDirectoryForm(key, { ...value, reason: event.target.value })} /></label>
      {new TextEncoder().encode(value.reason.trim()).length > 16000 && <p role="alert" className="text-caption text-destructive">{t(($) => $.meeting_directory.reason_limit)}</p>}
      {!permitted && <CockpitDirectoryReasons codes={header.blocked_reasons} />}
      {changed && !pending && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.meeting_preparation.changed)}</p><Button variant="outline" size="sm" onClick={refresh}>{t(($) => $.meeting_lifecycle.refresh)}</Button><Button variant="outline" size="sm" disabled={!permitted} onClick={() => setCockpitDirectoryForm(key, { ...value, observedRevision: header.revision })}>{t(($) => $.meeting_lifecycle.rebase)}</Button></div>}
      {pending && <div className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.pending_hint)}</p><Button variant="outline" size="sm" disabled={request.busy} onClick={() => void verify()}>{t(($) => $.meeting_lifecycle.check_command)}</Button></div>}
      {request.error && <p role="alert" className="break-words text-caption text-destructive">{request.error.startsWith("directory_command_") ? t(($) => $.task_flow.unconfirmed) : request.error}</p>}
      <DialogFooter><DialogClose render={<Button variant="outline" disabled={request.busy} />}>{t(($) => $.task_create.cancel)}</DialogClose><Button variant={transition === "abandon" ? "destructive" : "default"} onClick={() => void save()}
        disabled={request.busy || !permitted || Boolean(pending) && !request.canRetry || !pending && (changed || needsReason && !value.reason.trim() || new TextEncoder().encode(value.reason.trim()).length > 16000)}>{request.busy && <Spinner />}{pending ? t(($) => $.meeting_lifecycle.retry_command) : t(($) => $.meeting_lifecycle.confirm)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
