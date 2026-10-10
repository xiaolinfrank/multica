"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import {
  cockpitArtifactReturn, cockpitArtifactSelectedAttachmentOptions, cockpitArtifactDraftKey, cockpitArtifactPath, EMPTY_ARTIFACT_SUBMISSION_DRAFT, useCockpitArtifactDraftStore,
  updateCockpitArtifactSubmissionDraft, prepareCockpitArtifactSubmission, settleCockpitArtifactSubmission,
  rebaseCockpitArtifactSubmissionDraft, useSubmitCockpitArtifactVersion, type CockpitScope,
} from "@multica/core/cockpit";
import type { CockpitArtifactHeader } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { FilePlus2 } from "lucide-react";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitArtifactFilePicker } from "./cockpit-artifact-file-picker";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitFlowError } from "./cockpit-task-flow";

export function CockpitArtifactSubmitForm({ wsId, artifact, scope, disabled }: {
  wsId: string; artifact: CockpitArtifactHeader; scope: CockpitScope; disabled: boolean;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation();
  const captureContext = useCockpitCommandContext(JSON.stringify([wsId, artifact.id, scope]));
  const key = cockpitArtifactDraftKey(wsId, "submit", artifact.id);
  const draft = useCockpitArtifactDraftStore((state) => state.draft.submissions[key] ?? EMPTY_ARTIFACT_SUBMISSION_DRAFT);
  const [open, setOpen] = useState(Boolean(draft.text || draft.attachmentId || draft.pending)); const [error, setError] = useState("");
  const submit = useSubmitCockpitArtifactVersion(wsId); const lock = useRef(false);
  const stale = draft.baseRevision !== null && draft.baseRevision !== artifact.revision && !draft.pending;
  const current = artifact.current_version;
  const knownVersion = !current || current.payload_kind === "text" || current.payload_kind === "attachment";
  const canStartNewVersion = !current ? artifact.status === "draft" : current.capture_status === "ready" && ["approved", "changes_requested", "rejected"].includes(current.decision)
    || current.capture_status === "needs_attention" && current.decision === "not_requested";
  const canSubmit = Boolean(draft.pending || (artifact.can_submit && !artifact.archived_at && knownVersion && ["draft", "approved", "changes_requested", "rejected", "needs_attention"].includes(artifact.status) && canStartNewVersion));
  const selectedFile = useQuery({ ...cockpitArtifactSelectedAttachmentOptions(wsId, artifact.id, artifact.source_issue.id, draft.attachmentId), enabled: Boolean(open && draft.kind === "attachment" && draft.attachmentId) });
  const valid = draft.kind === "text" ? Boolean(draft.text.trim()) && new TextEncoder().encode(draft.text).length <= 128 * 1024
    : Boolean(selectedFile.data?.id === draft.attachmentId && !selectedFile.isFetching && !selectedFile.isError);
  async function save() {
    if (lock.current || disabled || stale || !canSubmit || (!draft.pending && !valid)) return;
    const stillCurrent = captureContext();
    const body = prepareCockpitArtifactSubmission(key, artifact.revision, crypto.randomUUID());
    lock.current = true; setError("");
    try {
      const result = await submit.mutateAsync({ artifactId: artifact.id, body });
      settleCockpitArtifactSubmission(key, body.submission_key, true);
      if (stillCurrent()) { setOpen(false); navigation.push(cockpitArtifactPath(paths.cockpit(), artifact.id, scope, result.version.version.id, cockpitArtifactReturn(navigation.searchParams))); }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) settleCockpitArtifactSubmission(key, body.submission_key, false);
      if (stillCurrent()) setError(cause instanceof ApiError ? cause.message : t(($) => $.task_flow.unconfirmed));
    } finally { lock.current = false; }
  }
  return <section className="space-y-3 rounded-xl border border-border bg-card p-4">
    <Button type="button" variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}><FilePlus2 className="size-3.5" />{t(($) => $.artifacts.new_version)}</Button>
    {open && <div className="space-y-3">
      {draft.pending && <p role="status" className="rounded-lg bg-warning-subtle p-3 text-caption">{t(($) => $.task_flow.pending_request)}</p>}
      {stale && <div role="status" className="space-y-2 rounded-lg bg-warning-subtle p-3 text-caption"><p>{t(($) => $.artifacts.draft_changed)}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => rebaseCockpitArtifactSubmissionDraft(key, artifact.revision)}>{t(($) => $.artifacts.rebase_draft)}</Button></div>}
      <div role="group" aria-label={t(($) => $.artifacts.content_kind)} className="flex flex-wrap gap-2">
        {(["text", "attachment"] as const).map((kind) => <Button key={kind} type="button" size="sm" variant={draft.kind === kind ? "secondary" : "outline"}
          aria-pressed={draft.kind === kind} disabled={disabled || Boolean(draft.pending)} onClick={() => updateCockpitArtifactSubmissionDraft(key, artifact.revision, { kind })}>
          {kind === "text" ? t(($) => $.artifacts.text_kind) : t(($) => $.artifacts.file_kind)}</Button>)}
      </div>
      {draft.kind === "text" ? <label className="block space-y-2 text-caption"><span>{t(($) => $.artifacts.version_text)}</span><Textarea rows={10} value={draft.text} disabled={disabled || Boolean(draft.pending)}
        onChange={(event) => updateCockpitArtifactSubmissionDraft(key, artifact.revision, { text: event.target.value })} /></label>
        : <><CockpitArtifactFilePicker wsId={wsId} artifactId={artifact.id} sourceIssueId={artifact.source_issue.id} selectedId={draft.attachmentId} selected={selectedFile.data ?? null}
          disabled={disabled || Boolean(draft.pending)} onSelect={(attachmentId) => updateCockpitArtifactSubmissionDraft(key, artifact.revision, { attachmentId })} />
          {selectedFile.isError && <CockpitFlowError onRetry={() => void selectedFile.refetch()} />}</>}
      <p className="text-caption text-muted-foreground">{draft.kind === "text" ? t(($) => $.artifacts.version_hint) : t(($) => $.artifacts.file_version_hint)}</p>
      {!canSubmit && <p role="status" className="text-caption text-muted-foreground">{knownVersion ? t(($) => $.artifacts.review_first) : t(($) => $.artifacts.unsupported_version)}</p>}
      {draft.kind === "text" && draft.text && !valid && <p className="text-caption text-destructive">{t(($) => $.artifacts.text_limit)}</p>}
      <Button type="button" disabled={disabled || stale || !canSubmit || (!draft.pending && !valid) || submit.isPending} aria-busy={submit.isPending} onClick={() => void save()}>{submit.isPending && <Spinner />}{draft.pending ? t(($) => $.workflow.retry_submission) : t(($) => $.artifacts.submit_version)}</Button>
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    </div>}
  </section>;
}
