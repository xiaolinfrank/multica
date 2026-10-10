"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import { cockpitArtifactDraftKey, cockpitArtifactPath, EMPTY_ARTIFACT_CREATION_DRAFT, prepareCockpitArtifactCreation,
  cockpitSelectedMemberOptions, settleCockpitArtifactCreation, updateCockpitArtifactCreationDraft, useCockpitArtifactDraftStore, useCreateCockpitArtifact, type CockpitScope } from "@multica/core/cockpit";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { FilePlus2 } from "lucide-react";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitIssueChoice } from "./cockpit-task-flow";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitReviewerSelect } from "./cockpit-reviewer-select";

export function CockpitArtifactCreate({ wsId, nodeId, nodeLabel, projectId, moduleId, scope, disabled }: {
  wsId: string; nodeId: string; nodeLabel: string; projectId: string; moduleId: string; scope: CockpitScope; disabled: boolean;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation();
  const [open, setOpen] = useState(false); const [error, setError] = useState(""); const lock = useRef(false);
  const captureContext = useCockpitCommandContext(JSON.stringify([wsId, nodeId, scope]));
  const key = cockpitArtifactDraftKey(wsId, "create", nodeId);
  const draft = useCockpitArtifactDraftStore((store) => store.draft.creations[key] ?? EMPTY_ARTIFACT_CREATION_DRAFT);
  const update = (patch: Parameters<typeof updateCockpitArtifactCreationDraft>[1]) => updateCockpitArtifactCreationDraft(key, patch);
  const reviewer = useQuery({ ...cockpitSelectedMemberOptions(wsId, draft.reviewerId), enabled: Boolean(open && draft.reviewerId) });
  const selected = useQuery({ ...issueDetailOptions(wsId, draft.sourceIssueId), enabled: Boolean(open && draft.sourceIssueId) });
  const issue = selected.data ?? null;
  const mismatch = Boolean(issue && (issue.project_id !== projectId || issue.module_id !== moduleId));
  const reviewerPresent = Boolean(reviewer.data?.items.some((member) => member.id === draft.reviewerId));
  const create = useCreateCockpitArtifact(wsId);
  const valid = Boolean(draft.title.trim() && issue && !mismatch && reviewerPresent && !selected.isFetching && !selected.isError && !reviewer.isError && !reviewer.isFetching);
  async function save() {
    if (lock.current || disabled || (!draft.pending && !valid)) return;
    const stillCurrent = captureContext();
    const body = prepareCockpitArtifactCreation(key, nodeId, crypto.randomUUID());
    lock.current = true; setError("");
    try {
      const result = await create.mutateAsync(body);
      settleCockpitArtifactCreation(key, body.creation_key, true);
      if (stillCurrent()) { setOpen(false); navigation.push(cockpitArtifactPath(paths.cockpit(), result.id, scope, undefined, { nodeId, view: "artifacts" })); }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) settleCockpitArtifactCreation(key, body.creation_key, false);
      if (stillCurrent()) setError(cause instanceof ApiError ? cause.message : t(($) => $.task_flow.unconfirmed));
    } finally { lock.current = false; }
  }
  const locked = disabled || Boolean(draft.pending) || create.isPending;
  return <Dialog open={open} onOpenChange={(next) => { if (!lock.current) setOpen(next); }}>
    <DialogTrigger render={<Button type="button" size="sm" disabled={disabled} />}><FilePlus2 className="size-3.5" />{t(($) => $.artifacts.register)}</DialogTrigger>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-xl"><DialogHeader>
      <DialogTitle>{t(($) => $.artifacts.register)}</DialogTitle><DialogDescription>{t(($) => $.artifacts.register_hint)}</DialogDescription>
    </DialogHeader><div className="min-h-0 space-y-4 overflow-y-auto pr-1">
      <p className="break-words rounded-lg bg-muted p-3 text-caption">{nodeLabel}</p>
      {draft.pending && <p role="status" className="rounded-lg bg-warning-subtle p-3 text-caption">{t(($) => $.task_flow.pending_request)}</p>}
      <CockpitIssueChoice wsId={wsId} selected={issue} disabled={locked} onSelect={(item) => update({ sourceIssueId: item.id, ...(!draft.title ? { title: item.title } : {}) })} />
      {selected.isError && draft.sourceIssueId && <CockpitFlowError onRetry={() => void selected.refetch()} />}
      {mismatch && <p role="alert" className="text-caption text-destructive">{t(($) => $.artifacts.source_scope_mismatch)}</p>}
      <label className="block space-y-1 text-caption"><span>{t(($) => $.artifacts.name)}</span><Input maxLength={500} value={draft.title} disabled={locked} onChange={(event) => update({ title: event.target.value })} /></label>
      <label className="block space-y-1 text-caption"><span>{t(($) => $.artifacts.description)}</span><Textarea rows={3} value={draft.description} disabled={locked} onChange={(event) => update({ description: event.target.value })} /></label>
      <CockpitReviewerSelect wsId={wsId} value={draft.reviewerId} disabled={locked} onChange={(reviewerId) => update({ reviewerId })} />
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    </div><DialogFooter><DialogClose render={<Button type="button" variant="outline" disabled={create.isPending} />}>{t(($) => $.task_create.cancel)}</DialogClose>
      <Button type="button" disabled={disabled || create.isPending || (!draft.pending && !valid)} aria-busy={create.isPending} onClick={() => void save()}>{create.isPending && <Spinner />}{draft.pending ? t(($) => $.artifacts.retry_registration) : t(($) => $.artifacts.register)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
