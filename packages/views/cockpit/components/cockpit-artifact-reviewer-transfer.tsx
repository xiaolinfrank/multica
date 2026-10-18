"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isCockpitDefinitiveCommandRejection, cockpitArtifactCommandDraftKey, cockpitSelectedMemberOptions, prepareCockpitArtifactCommand, settleCockpitArtifactCommand,
  useCockpitArtifactCommandStore, useReassignCockpitArtifactReviewer, useReassignCockpitAcceptanceReviewer } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitReviewerSelect } from "./cockpit-reviewer-select";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { createSafeId } from "@multica/core/utils";

type Target = { kind: "artifact_reviewer"; artifactId: string } | { kind: "acceptance_reviewer"; nodeId: string; requestId: string };

export function CockpitArtifactReviewerTransfer({ wsId, target, revision, signature, reviewerId, hint, canTransfer, disabled }: {
  wsId: string; target: Target; revision: number; signature: string; reviewerId: string; hint: string; canTransfer: boolean; disabled: boolean;
}) {
  const { t } = useT("cockpit");
  const key = cockpitArtifactCommandDraftKey(wsId, target.kind, ...("artifactId" in target ? [target.artifactId] : [target.nodeId, target.requestId]));
  const stored = useCockpitArtifactCommandStore((state) => state.draft.pending[key]);
  const pending = stored?.kind === target.kind && "handoff_key" in stored.body ? stored : null;
  const [open, setOpen] = useState(false); const [reason, setReason] = useState(""); const [selectedId, setSelectedId] = useState(""); const [confirmed, setConfirmed] = useState(false);
  const [observed, setObserved] = useState({ revision, signature, reviewerId, hint }); const [error, setError] = useState(""); const lock = useRef(false);
  const captureContext = useCockpitCommandContext(key);
  const artifactMutation = useReassignCockpitArtifactReviewer(wsId); const acceptanceMutation = useReassignCockpitAcceptanceReviewer(wsId);
  const saving = artifactMutation.isPending || acceptanceMutation.isPending;
  const body = pending && "handoff_key" in pending.body ? pending.body : null;
  const chosen = body?.reviewer_id ?? selectedId; const text = body?.reason ?? reason;
  const member = useQuery({ ...cockpitSelectedMemberOptions(wsId, chosen), enabled: Boolean(open && chosen && !pending) });
  const previous = useQuery({ ...cockpitSelectedMemberOptions(wsId, observed.reviewerId), enabled: Boolean(open && observed.reviewerId && !pending) });
  const valid = Boolean(chosen && chosen !== observed.reviewerId && member.data?.items.some((item) => item.id === chosen) && !member.isFetching && !member.isError
    && text.trim() && new TextEncoder().encode(text.trim()).length <= 16000 && confirmed);
  const stale = !pending && (observed.signature !== signature || observed.revision !== revision);
  async function submit() {
    if (lock.current || disabled || stale || (!pending && (!canTransfer || !valid))) return;
    const input = { expected_revision: observed.revision, handoff_key: createSafeId(), reviewer_id: chosen, reason: text.trim() };
    const command = prepareCockpitArtifactCommand(key, target.kind === "artifact_reviewer"
      ? { kind: target.kind, artifactId: target.artifactId, body: input }
      : { kind: target.kind, nodeId: target.nodeId, requestId: target.requestId, body: input });
    const stillCurrent = captureContext(); lock.current = true; setError("");
    try {
      if (command.kind === "artifact_reviewer") await artifactMutation.mutateAsync({ artifactId: command.artifactId, body: command.body });
      else await acceptanceMutation.mutateAsync({ nodeId: command.nodeId, requestId: command.requestId, body: command.body });
      settleCockpitArtifactCommand(key, command.body.handoff_key);
      if (stillCurrent()) { setOpen(false); setReason(""); setSelectedId(""); setConfirmed(false); }
    } catch (cause) {
      if (isCockpitDefinitiveCommandRejection(cause)) {
        if (stillCurrent()) { setSelectedId(command.body.reviewer_id); setReason(command.body.reason); setConfirmed(false); setObserved((old) => ({ ...old, revision: command.body.expected_revision })); }
        settleCockpitArtifactCommand(key, command.body.handoff_key);
      }
      if (stillCurrent()) setError(cause instanceof Error ? cause.message : t(($) => $.task_flow.unconfirmed));
    } finally { lock.current = false; }
  }
  if (!canTransfer && !pending) return null;
  return <Dialog open={open} onOpenChange={(next) => { if (lock.current) return; if (next) { setObserved({ revision, signature, reviewerId, hint }); setConfirmed(false); setError(""); } setOpen(next); }}>
    <DialogTrigger render={<Button size="sm" variant="outline" disabled={disabled} />}>{t(($) => $.artifact_runtime.transfer_reviewer)}</DialogTrigger>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-xl"><DialogHeader><DialogTitle>{t(($) => $.artifact_runtime.transfer_reviewer)}</DialogTitle><DialogDescription>{pending ? t(($) => $.task_flow.pending_request) : observed.hint}</DialogDescription></DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto">{!pending && <p className="break-words text-caption" title={observed.reviewerId}>{t(($) => $.artifact_runtime.previous_reviewer)}: {previous.data?.items.find((item) => item.id === observed.reviewerId)?.title || observed.reviewerId}</p>}
        {stale && <p role="alert" className="text-caption text-destructive">{t(($) => $.artifact_runtime.command_changed)}</p>}
        <CockpitReviewerSelect wsId={wsId} value={chosen} label={t(($) => $.artifact_runtime.new_reviewer)} excludeId={observed.reviewerId} disabled={disabled || saving || Boolean(pending)} onChange={(id) => { setSelectedId(id); setConfirmed(false); }} />
        <label className="block space-y-1 text-caption"><span>{t(($) => $.artifact_runtime.reason)}</span><Textarea value={text} disabled={saving || Boolean(pending)} onChange={(event) => { setReason(event.target.value); setConfirmed(false); }} /></label>
        {!pending && <label className="flex items-start gap-2 text-caption"><Checkbox checked={confirmed} disabled={disabled || saving || stale} onCheckedChange={(checked) => setConfirmed(checked === true)} />{t(($) => $.artifact_runtime.confirm_responsibility)}</label>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      </div><DialogFooter><DialogClose render={<Button variant="outline" disabled={saving} />}>{t(($) => $.task_create.cancel)}</DialogClose>
        <Button disabled={disabled || saving || stale || (!pending && !valid)} aria-busy={saving} onClick={() => void submit()}>{saving && <Spinner />}{pending ? t(($) => $.artifact_runtime.retry_command) : t(($) => $.artifact_runtime.confirm_transfer)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
