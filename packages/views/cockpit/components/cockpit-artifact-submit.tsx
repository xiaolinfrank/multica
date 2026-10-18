"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import { isCockpitDefinitiveCommandRejection,
  cockpitContextOptions, cockpitInputManifestVersionOptions, cockpitArtifactReturn, cockpitArtifactSelectedAttachmentOptions, cockpitArtifactDraftKey, cockpitArtifactPath, EMPTY_ARTIFACT_SUBMISSION_DRAFT, useCockpitArtifactDraftStore,
  updateCockpitArtifactSubmissionDraft, prepareCockpitArtifactSubmission, settleCockpitArtifactSubmission, cockpitArtifactSubmissionNeedsRebase,
  rebaseCockpitArtifactSubmissionDraft, useSubmitCockpitArtifactVersion, type CockpitScope,
} from "@multica/core/cockpit";
import type { CockpitArtifactHeader } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { FilePlus2 } from "lucide-react";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitArtifactFilePicker } from "./cockpit-artifact-file-picker";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitFlowError } from "./cockpit-task-flow";
import { CockpitArtifactInputManifest } from "./cockpit-artifact-input-manifest";
import { CockpitArtifactSourceMeeting } from "./cockpit-artifact-source-meeting";
import { CockpitArtifactAvailabilityReason } from "./cockpit-artifact-availability";
import { createSafeId } from "@multica/core/utils";

export function CockpitArtifactSubmitForm({ wsId, artifact, scope, disabled }: {
  wsId: string; artifact: CockpitArtifactHeader; scope: CockpitScope; disabled: boolean;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation();
  const captureContext = useCockpitCommandContext(JSON.stringify([wsId, artifact.id, scope]));
  const key = cockpitArtifactDraftKey(wsId, "submit", artifact.id);
  const draft = useCockpitArtifactDraftStore((state) => state.draft.submissions[key] ?? EMPTY_ARTIFACT_SUBMISSION_DRAFT);
  const [open, setOpen] = useState(Boolean(draft.text || draft.attachmentId || draft.inputManifestVersionId || draft.inputManifestIssueId || draft.pending)); const [error, setError] = useState("");
  const submit = useSubmitCockpitArtifactVersion(wsId); const lock = useRef(false);
  const context = { revision: artifact.revision, producerIssueId: artifact.producer_issue.id };
  const stale = cockpitArtifactSubmissionNeedsRebase(draft, context);
  const producerId = draft.pending?.producer_issue_id ?? draft.producerIssueId ?? artifact.producer_issue.id;
  const inputCapabilities = useQuery({ ...cockpitContextOptions(wsId, scope), enabled: open });
  const selectedManifest = useQuery({ ...cockpitInputManifestVersionOptions(wsId, draft.inputManifestIssueId, draft.inputManifestVersionId), enabled: open && Boolean(draft.inputManifestIssueId && draft.inputManifestVersionId) });
  const inputSourceValid = !draft.inputManifestIssueId && !draft.inputManifestVersionId || Boolean(draft.inputManifestIssueId && draft.inputManifestVersionId && !selectedManifest.isError && !selectedManifest.isFetching && selectedManifest.data?.id === draft.inputManifestVersionId && selectedManifest.data.issueId === draft.inputManifestIssueId);
  const current = artifact.current_version;
  const knownVersion = !current || current.payload_kind === "text" || current.payload_kind === "attachment";
  const canStartNewVersion = !current ? artifact.status === "draft" : current.capture_status === "ready" && ["approved", "changes_requested", "rejected"].includes(current.decision)
    || current.capture_status === "needs_attention" && current.decision === "not_requested";
  const canSubmit = Boolean(draft.pending || (artifact.can_submit && !artifact.archived_at && knownVersion && ["draft", "approved", "changes_requested", "rejected", "needs_attention"].includes(artifact.status) && canStartNewVersion));
  const fileUnavailable = draft.kind === "attachment" && artifact.file_capture_available !== true;
  const selectedFile = useQuery({ ...cockpitArtifactSelectedAttachmentOptions(wsId, artifact.id, producerId, draft.attachmentId), enabled: Boolean(open && draft.kind === "attachment" && draft.attachmentId) });
  const valid = draft.kind === "text" ? Boolean(draft.text.trim()) && new TextEncoder().encode(draft.text).length <= 128 * 1024
    : Boolean(selectedFile.data?.id === draft.attachmentId && !selectedFile.isFetching && !selectedFile.isError);
  async function save() {
    if (lock.current || disabled || stale || !canSubmit || (!draft.pending && (!valid || fileUnavailable || !inputSourceValid))) return;
    const stillCurrent = captureContext();
    const body = prepareCockpitArtifactSubmission(key, context, createSafeId());
    lock.current = true; setError("");
    try {
      const result = await submit.mutateAsync({ artifactId: artifact.id, body });
      settleCockpitArtifactSubmission(key, body.submission_key, true);
      if (stillCurrent()) { setOpen(false); navigation.push(cockpitArtifactPath(paths.cockpit(), artifact.id, scope, result.version.version.id, cockpitArtifactReturn(navigation.searchParams))); }
    } catch (cause) {
      if (isCockpitDefinitiveCommandRejection(cause)) settleCockpitArtifactSubmission(key, body.submission_key, false);
      if (stillCurrent()) setError(cause instanceof ApiError ? cause.message : t(($) => $.task_flow.unconfirmed));
    } finally { lock.current = false; }
  }
  return <section className="space-y-3 rounded-xl border border-border bg-card p-4">
    <Button type="button" variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}><FilePlus2 className="size-3.5" />{t(($) => $.artifacts.new_version)}</Button>
    {open && <div className="space-y-3">
      {draft.pending && <p role="status" className="rounded-lg bg-warning-subtle p-3 text-caption">{t(($) => $.task_flow.pending_request)}</p>}
      {stale && <div role="status" className="space-y-2 rounded-lg bg-warning-subtle p-3 text-caption"><p>{t(($) => $.artifacts.draft_changed)}</p>
        <p>{t(($) => $.artifact_runtime.producer_rebase)}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => rebaseCockpitArtifactSubmissionDraft(key, context)}>{t(($) => $.artifacts.rebase_draft)}</Button></div>}
      <div role="group" aria-label={t(($) => $.artifacts.content_kind)} className="flex flex-wrap gap-2">
        {(["text", "attachment"] as const).map((kind) => <Button key={kind} type="button" size="sm" variant={draft.kind === kind ? "secondary" : "outline"}
          aria-pressed={draft.kind === kind} disabled={disabled || Boolean(draft.pending) || kind === "attachment" && artifact.file_capture_available !== true} onClick={() => updateCockpitArtifactSubmissionDraft(key, context, { kind })}>
          {kind === "text" ? t(($) => $.artifacts.text_kind) : t(($) => $.artifacts.file_kind)}</Button>)}
      </div>
      {artifact.file_capture_available !== true && !draft.pending && <div role="status" className="space-y-2 rounded-lg bg-muted p-3 text-caption"><p>{t(($) => $.artifact_runtime.private_storage_required)}</p>
        {artifact.file_capture_unavailable_reason && artifact.file_capture_unavailable_reason !== "private_storage_required" && <CockpitArtifactAvailabilityReason reason={artifact.file_capture_unavailable_reason} />}
        <AppLink href={paths.issueDetail(artifact.producer_issue.id)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t(($) => $.artifact_runtime.open_producer)} {t(($) => $.action_flow.new_tab)}</AppLink></div>}
      {draft.kind === "text" ? <label className="block space-y-2 text-caption"><span>{t(($) => $.artifacts.version_text)}</span><Textarea rows={10} value={draft.text} disabled={disabled || Boolean(draft.pending)}
        onChange={(event) => updateCockpitArtifactSubmissionDraft(key, context, { text: event.target.value })} /></label>
        : <><CockpitArtifactFilePicker key={producerId} wsId={wsId} artifactId={artifact.id} producerIssueId={producerId} selectedId={draft.attachmentId} selected={selectedFile.data ?? null}
          disabled={disabled || stale || fileUnavailable || Boolean(draft.pending)} onSelect={(attachmentId) => updateCockpitArtifactSubmissionDraft(key, context, { attachmentId })} />
          {selectedFile.isError && <CockpitFlowError onRetry={() => void selectedFile.refetch()} />}</>}
      <CockpitArtifactSourceMeeting wsId={wsId} meetingId={draft.sourceMeetingId} versionId={draft.sourceMinutesVersionId} disabled={disabled || Boolean(draft.pending)}
        onChange={(patch) => updateCockpitArtifactSubmissionDraft(key, context, patch)} />
      {(inputCapabilities.data?.capabilities?.run_input_manifests === true || draft.inputManifestIssueId || draft.inputManifestVersionId) && <CockpitArtifactInputManifest wsId={wsId} producerIssueId={producerId} selectedIssueId={draft.inputManifestIssueId} selectedVersionId={draft.inputManifestVersionId} disabled={disabled || stale || Boolean(draft.pending)} onChange={(selection) => updateCockpitArtifactSubmissionDraft(key, context, selection)} />}
      <p className="text-caption text-muted-foreground">{draft.kind === "text" ? t(($) => $.artifacts.version_hint) : t(($) => $.artifacts.file_version_hint)}</p>
      {!canSubmit && <p role="status" className="text-caption text-muted-foreground">{knownVersion ? t(($) => $.artifacts.review_first) : t(($) => $.artifacts.unsupported_version)}</p>}
      {draft.kind === "text" && draft.text && !valid && <p className="text-caption text-destructive">{t(($) => $.artifacts.text_limit)}</p>}
      <Button type="button" disabled={disabled || stale || !canSubmit || (!draft.pending && (!valid || fileUnavailable || !inputSourceValid)) || submit.isPending} aria-busy={submit.isPending} onClick={() => void save()}>{submit.isPending && <Spinner />}{draft.pending ? t(($) => $.workflow.retry_submission) : t(($) => $.artifacts.submit_version)}</Button>
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    </div>}
  </section>;
}
