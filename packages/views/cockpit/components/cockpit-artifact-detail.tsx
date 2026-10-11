"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "@multica/core/api";
import {
  cockpitArtifactOptions, cockpitArtifactVersionsOptions, cockpitArtifactVersionOptions, cockpitArtifactVersionActions,
  cockpitIssueInputManifestPath, cockpitArtifactReturn, cockpitArtifactPath, cockpitObjectPath, cockpitSurfacePath, cockpitArtifactDraftKey, useCockpitArtifactDraftStore,
  clearCockpitArtifactReviewDraft, updateCockpitArtifactReviewDraft, useReviewCockpitArtifactVersion, useRetryCockpitArtifactCapture, type CockpitScope,
} from "@multica/core/cockpit";
import type { CockpitArtifactHeader, CockpitArtifactVersionMetadata, CockpitArtifactReview } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Markdown } from "@multica/ui/markdown";
import { ArrowLeft, ArrowUpRight, Download, FileCheck2, FileText, History } from "lucide-react";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitPreparationRun } from "./cockpit-preparation-run";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { ArtifactStatus, useArtifactStatusLabel } from "./cockpit-artifact-status";
import { WorkflowIssueLink } from "./cockpit-workflow-issue-link";
import { CockpitArtifactSubmitForm } from "./cockpit-artifact-submit";
import { CockpitArtifactResponsibilities } from "./cockpit-artifact-responsibilities";
import { CockpitArtifactReferences } from "./cockpit-artifact-references";
import { CockpitArtifactAvailabilityReason } from "./cockpit-artifact-availability";
import { CockpitDetailTitle } from "./cockpit-detail-title";

const EMPTY_REVIEW: { decision: CockpitArtifactReview["decision"]; feedback: string } = { decision: "approved", feedback: "" };

export function CockpitArtifactDetail({ wsId, artifactId, versionId, scope, currentUserId, readOnly }: {
  wsId: string; artifactId: string; versionId: string | null; scope: CockpitScope; currentUserId: string; readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const back = cockpitArtifactReturn(navigation.searchParams);
  const returnPath = back ? cockpitObjectPath(paths.cockpit(), { kind: "node", id: back.nodeId, view: back.view, requestId: back.requestId }, back.scope ?? scope) : cockpitSurfacePath(paths.cockpit(), "artifacts", scope);
  const query = useQuery({ ...cockpitArtifactOptions(wsId, artifactId), refetchInterval: (state) => ["queued", "running", "retry_wait"].includes(state.state.data?.current_version?.capture_status ?? "") ? 10_000 : false });
  const artifact = query.data;
  const hasSubmissionDraft = useCockpitArtifactDraftStore((state) => { const draft = state.draft.submissions[cockpitArtifactDraftKey(wsId, "submit", artifactId)]; return Boolean(draft?.pending || draft?.text || draft?.attachmentId); });
  const outside = Boolean(artifact && ((scope.projectId && artifact.project_id !== scope.projectId) || (scope.moduleId && artifact.module_id !== scope.moduleId)));
  const locked = Boolean(readOnly || outside || artifact?.archived_at);
  return <section aria-label={t(($) => $.artifacts.detail)} className="min-h-0 flex-1 overflow-y-auto p-4 lg:p-6">
    <div className="mx-auto max-w-5xl space-y-5">
      <AppLink href={returnPath} className={buttonVariants({ variant: "ghost", size: "sm" })}><ArrowLeft className="size-3.5" />{back?.view === "acceptance" ? t(($) => $.acceptance.back) : back ? t(($) => $.artifacts.back_to_work_item) : t(($) => $.artifacts.back)}</AppLink>
      {query.isPending ? <div role="status" className="flex gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div> : !artifact ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
        {query.isError && <div className="space-y-2 rounded-lg bg-warning-subtle p-3 text-caption"><p>{t(($) => $.work_overview.refresh_failed)}</p><CockpitFlowError onRetry={() => void query.refetch()} /></div>}
        {outside && <div role="status" className="space-y-2 rounded-xl border border-border bg-muted/40 p-4 text-caption"><p>{t(($) => $.shell.scope_outside)}</p>
          <AppLink href={cockpitArtifactPath(paths.cockpit(), artifact.id, { projectId: artifact.project_id, moduleId: artifact.module_id }, versionId ?? undefined, back)} className="text-primary hover:underline">{t(($) => $.shell.show_object_scope)}</AppLink></div>}
        <header className="space-y-3"><div className="flex flex-wrap items-start gap-3"><FileCheck2 className="mt-1 size-6 shrink-0 text-brand" aria-hidden /><CockpitDetailTitle key={artifact.title}>{artifact.title}</CockpitDetailTitle><ArtifactStatus status={artifact.status} /></div>
          {artifact.description && <p className="whitespace-pre-wrap break-words text-body text-muted-foreground">{artifact.description}</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-caption"><AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: artifact.node_id }, scope)} className="max-w-full break-words text-primary hover:underline">{artifact.node_label}<ArrowUpRight className="ml-1 inline size-3" /></AppLink>
            <AppLink href={paths.issueDetail(artifact.source_issue.id)} target="_blank" rel="noopener noreferrer" className="max-w-full break-words text-muted-foreground hover:underline">{t(($) => $.artifact_runtime.original_source)}: {artifact.source_issue.identifier} · {artifact.source_issue.title} {t(($) => $.action_flow.new_tab)}</AppLink></div>
          <p className="text-caption">{t(($) => $.artifact_runtime.current_producer)}: <AppLink href={paths.issueDetail(artifact.producer_issue.id)} target="_blank" rel="noopener noreferrer" className="break-words text-primary hover:underline">{artifact.producer_issue.identifier} · {artifact.producer_issue.title} {t(($) => $.action_flow.new_tab)}</AppLink></p>
        </header>
        <div className="grid gap-3 sm:grid-cols-2"><VersionPin artifact={artifact} version={artifact.current_version} label={t(($) => $.artifacts.current_version)} scope={scope} />
          <VersionPin artifact={artifact} version={artifact.approved_version} label={t(($) => $.artifacts.approved_pin)} scope={scope} /></div>
        {versionId && <ArtifactReader key={versionId} wsId={wsId} artifact={artifact} versionId={versionId} scope={scope} currentUserId={currentUserId} readOnly={locked || query.isError || query.isFetching} />}
        {(artifact.can_submit || hasSubmissionDraft) && <CockpitArtifactSubmitForm wsId={wsId} artifact={artifact} scope={scope} disabled={Boolean(readOnly || outside || query.isError || query.isFetching)} />}
        <ArtifactHistory wsId={wsId} artifact={artifact} scope={scope} />
        <CockpitArtifactResponsibilities key={`${wsId}:${artifact.id}`} wsId={wsId} artifact={artifact} scope={scope} currentUserId={currentUserId} disabled={Boolean(readOnly || outside || query.isError || query.isFetching)} />
        <CockpitArtifactReferences wsId={wsId} artifact={artifact} scope={scope} disabled={Boolean(readOnly || outside || query.isError || query.isFetching)} />
      </>}
    </div>
  </section>;
}

function VersionPin({ artifact, version, label, scope }: { artifact: CockpitArtifactHeader; version: CockpitArtifactVersionMetadata | null; label: string; scope: CockpitScope }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation(); const back = cockpitArtifactReturn(navigation.searchParams);
  return <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label={label}><h2 className="text-caption font-medium text-muted-foreground">{label}</h2>
    {version ? <><div className="flex flex-wrap items-center gap-3"><span className="text-title-sm font-semibold">{t(($) => $.artifacts.version, { number: version.version_number })}</span><ArtifactStatus status={version.decision} /></div>
      {version.capture_status !== "ready" && <ArtifactStatus status={version.capture_status} />}
      <AppLink href={cockpitArtifactPath(paths.cockpit(), artifact.id, scope, version.id, back)} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.artifacts.read_version)}<ArrowUpRight className="size-3.5" /></AppLink></>
      : <p className="text-caption text-muted-foreground">{t(($) => $.artifacts.no_version)}</p>}
  </section>;
}

function ArtifactReader({ wsId, artifact, versionId, scope, currentUserId, readOnly }: { wsId: string; artifact: CockpitArtifactHeader; versionId: string; scope: CockpitScope; currentUserId: string; readOnly: boolean }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation(); const back = cockpitArtifactReturn(navigation.searchParams); const statusLabel = useArtifactStatusLabel();
  const query = useQuery({ ...cockpitArtifactVersionOptions(wsId, artifact.id, versionId), refetchInterval: (state) => ["queued", "running", "retry_wait"].includes(state.state.data?.version.capture_status ?? "") ? 10_000 : false });
  const detail = query.data; const version = detail?.version;
  const observedReview = useRef<string | null>(null);
  const [, setReviewContext] = useState(0);
  const identity = version ? cockpitArtifactDraftKey(wsId, "review", artifact.id, version.id, version.review_issue?.id ?? "", version.reviewer_id) : "";
  if (identity && !observedReview.current) observedReview.current = identity;
  const reviewKey = observedReview.current ?? "";
  const draft = useCockpitArtifactDraftStore((state) => state.draft.reviews[reviewKey] ?? EMPTY_REVIEW);
  const [fileRead, setFileRead] = useState(false); const [downloadReady, setDownloadReady] = useState(false); const [downloading, setDownloading] = useState(false); const [error, setError] = useState(""); const lock = useRef(false);
  const review = useReviewCockpitArtifactVersion(wsId); const retry = useRetryCockpitArtifactCapture(wsId);
  const currentPin = artifact.current_version?.id === versionId ? artifact.current_version : null;
  const approvedPin = artifact.approved_version?.id === versionId ? artifact.approved_version : null;
  const staleVersion = Boolean(version && [currentPin, approvedPin].some((pin) => pin && (pin.revision > version.revision
    || pin.revision === version.revision && (pin.reviewer_id !== version.reviewer_id || pin.review_issue?.id !== version.review_issue?.id || pin.decision !== version.decision))));
  const actions = cockpitArtifactVersionActions(version, currentUserId, readOnly || staleVersion || identity !== reviewKey || query.isError || query.isFetching);
  const current = artifact.current_version?.id === versionId;
  const bodyReady = Boolean(detail?.content_available && version?.capture_status === "ready" && (version.payload_kind === "text" ? detail.content !== null : version.payload_kind === "attachment" && downloadReady && fileRead));
  async function downloadFixedFile() {
    if (lock.current || !detail?.content_available || version?.capture_status !== "ready" || version.payload_kind !== "attachment") return;
    lock.current = true; setDownloading(true); setError("");
    try {
      const fresh = await api.getCockpitArtifactDownloadLink(wsId, artifact.id, versionId);
      const address = fresh ? resolvePublicFileUrl(fresh.url) : null;
      if (!address) throw new Error("unavailable");
      const url = new URL(address, window.location.href);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unavailable");
      const anchor = document.createElement("a"); anchor.href = url.toString(); anchor.download = version.filename; anchor.rel = "noopener";
      document.body.append(anchor); anchor.click(); anchor.remove(); setDownloadReady(true);
    } catch { setError(t(($) => $.artifacts.download_failed)); }
    finally { lock.current = false; setDownloading(false); }
  }
  const feedbackValid = new TextEncoder().encode(draft.feedback.trim()).length <= 16000 && (draft.decision === "approved" || Boolean(draft.feedback.trim()));
  async function submitReview() {
    if (lock.current || !version || !current || !actions.canReview || (draft.decision === "approved" && !bodyReady) || !feedbackValid) return;
    lock.current = true; setError("");
    try { await review.mutateAsync({ artifactId: artifact.id, versionId, body: { expected_revision: version.revision, decision: draft.decision, feedback: draft.feedback.trim() } }); clearCockpitArtifactReviewDraft(reviewKey, draft); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : t(($) => $.errors.save_failed)); }
    finally { lock.current = false; }
  }
  return <section aria-label={t(($) => $.artifacts.reader)} className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6">
    <div className="flex items-center gap-2"><FileText className="size-4 text-muted-foreground" aria-hidden /><h2 className="text-title-sm font-semibold">{version ? t(($) => $.artifacts.version, { number: version.version_number }) : t(($) => $.artifacts.read_version)}</h2></div>
    <p className="text-caption text-muted-foreground">{t(($) => $.artifacts.immutable)}</p>
    {query.isPending ? <div role="status" className="flex gap-2"><Spinner />{t(($) => $.workflow.loading)}</div> : !detail || !version ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
      {query.isError && <CockpitFlowError onRetry={() => void query.refetch()} />}
      {!current && artifact.current_version && <p role="status" className="rounded-lg bg-muted p-3 text-caption">{t(($) => $.artifacts.historical, { number: artifact.current_version.version_number })} <AppLink href={cockpitArtifactPath(paths.cockpit(), artifact.id, scope, artifact.current_version.id, back)} className="text-primary hover:underline">{t(($) => $.artifacts.read_current)}</AppLink></p>}
      <div className="flex flex-wrap gap-2"><ArtifactStatus status={version.decision} /><ArtifactStatus status={version.capture_status} /></div>
      <dl className="space-y-2 text-caption"><div><dt className="text-muted-foreground">{t(($) => $.artifact_runtime.version_producer)}</dt><dd><AppLink href={paths.issueDetail(version.producer_issue_id)} target="_blank" rel="noopener noreferrer" className="break-words text-primary hover:underline">{version.producer_issue_identifier} · {version.producer_issue_title || version.producer_issue_id}</AppLink></dd></div>
        {version.source_meeting_id && <div><dt className="text-muted-foreground">{t(($) => $.artifact_runtime.meeting_source)}</dt><dd><AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: version.source_meeting_id }, scope)} target="_blank" rel="noopener noreferrer" className="break-words text-primary hover:underline">{version.source_meeting_title || version.source_meeting_id}</AppLink>{version.source_minutes_version_number !== null && <span> · {t(($) => $.workflow.version, { number: version.source_minutes_version_number })}</span>}</dd></div>}
        {version.producer_run_id && <div><dt className="text-muted-foreground">{t(($) => $.artifact_runtime.producer_run)}</dt><dd><CockpitPreparationRun key={version.producer_run_id} wsId={wsId} issueId={version.producer_issue_id} runId={version.producer_run_id} context="source" /></dd></div>}
        {version.input_manifest_version_id && <div><dt className="text-muted-foreground">{t(($) => $.input_materials.artifact_manifest_record)}</dt><dd>{version.input_manifest_issue_id ? <AppLink href={cockpitIssueInputManifestPath(paths.issueDetail(version.input_manifest_issue_id), new URLSearchParams(), version.input_manifest_version_id)} target="_blank" rel="noopener noreferrer" className="break-words text-primary underline">{t(($) => $.input_materials.artifact_view_manifest)}{version.input_manifest_version_number != null && <> · {t(($) => $.workflow.version, { number: version.input_manifest_version_number })}</>} · {t(($) => $.action_flow.new_tab)}</AppLink> : <span className="space-y-2"><span className="block">{t(($) => $.input_materials.artifact_manifest_location_missing)}</span><Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>{t(($) => $.input_materials.refresh_version)}</Button></span>}</dd></div>}
      </dl>
      {staleVersion && <div role="status" className="space-y-2 rounded-lg bg-warning-subtle p-3 text-caption"><p>{t(($) => $.artifact_runtime.version_changed)}</p><Button size="sm" variant="outline" onClick={() => void query.refetch()}>{t(($) => $.artifact_runtime.recheck)}</Button></div>}
      {current && identity !== reviewKey && !staleVersion && <div className="space-y-2 text-caption"><p>{t(($) => $.artifact_runtime.review_changed)}</p>{!readOnly && version.can_review && version.reviewer_id === currentUserId && <Button size="sm" variant="outline" onClick={() => { observedReview.current = identity; setReviewContext((old) => old + 1); }}>{t(($) => $.artifact_runtime.use_current_review)}</Button>}</div>}
      {!detail.content_available && <div role="alert" className="space-y-2 rounded-lg bg-warning-subtle p-3 text-caption"><p>{t(($) => $.artifact_runtime.content_missing)}</p><CockpitArtifactAvailabilityReason reason={detail.content_unavailable_reason} />
        {actions.canReview && current && <p>{t(($) => $.artifact_runtime.return_hint)}</p>}
        <div className="flex flex-wrap gap-3"><Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{t(($) => $.artifact_runtime.recheck)}</Button>
          {artifact.can_submit && <AppLink href={paths.issueDetail(artifact.producer_issue.id)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t(($) => $.artifact_runtime.open_producer)} {t(($) => $.action_flow.new_tab)}</AppLink>}</div></div>}
      {version.review_issue && <WorkflowIssueLink wsId={wsId} issue={version.review_issue} />}
      {version.capture_error && <p role="alert" className="whitespace-pre-wrap break-words rounded-lg bg-destructive/5 p-3 text-caption text-destructive">{version.capture_error}</p>}
      {actions.canRetryCapture && <Button type="button" variant="outline" size="sm" disabled={retry.isPending} onClick={() => { setError(""); void retry.mutateAsync({ artifactId: artifact.id, versionId, body: { expected_revision: version.revision } }).catch(() => setError(t(($) => $.errors.save_failed))); }}>{retry.isPending && <Spinner />}{t(($) => $.artifacts.retry_capture)}</Button>}
      {detail.content_available && version.payload_kind === "text" && detail.content !== null ? <div className="max-h-[65vh] min-w-0 overflow-auto break-words"><Markdown mode="full">{detail.content}</Markdown></div>
        : detail.content_available && version.payload_kind === "attachment" && version.capture_status === "ready" ? <div className="space-y-3 rounded-lg bg-muted/40 p-4"><p className="break-words text-body font-medium">{version.filename}</p>
          <Button type="button" variant="outline" size="sm" disabled={downloading} aria-busy={downloading} onClick={() => void downloadFixedFile()}>{downloading ? <Spinner /> : <Download className="size-3.5" />}{t(($) => $.artifacts.download_fixed)}</Button>
          {actions.canReview && current && <label className="flex items-start gap-2 text-caption"><Checkbox disabled={!downloadReady} checked={fileRead} onCheckedChange={(checked) => setFileRead(checked === true)} />{t(($) => $.artifacts.file_reviewed)}</label>}</div>
          : <p className="text-caption text-muted-foreground">{t(($) => $.artifacts.content_unavailable)}</p>}
      {detail.feedback && <div className="space-y-2 border-t border-border pt-4"><h3 className="text-caption font-medium">{t(($) => $.workflow.feedback)}</h3><p className="whitespace-pre-wrap break-words text-body">{detail.feedback}</p></div>}
      {current && actions.canReview ? <div className="space-y-3 border-t border-border pt-4"><label className="block text-caption">{t(($) => $.workflow.decision)}
        <Select disabled={review.isPending} value={draft.decision} items={["approved", "changes_requested", "rejected"].map((value) => ({ value, label: statusLabel(value) }))} onValueChange={(value) => { if (value === "approved" || value === "changes_requested" || value === "rejected") updateCockpitArtifactReviewDraft(reviewKey, { decision: value }); }}>
          <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger><SelectContent>{["approved", "changes_requested", "rejected"].map((value) => <SelectItem key={value} value={value}>{statusLabel(value)}</SelectItem>)}</SelectContent></Select></label>
        <label className="block text-caption">{t(($) => $.workflow.feedback)}<Textarea className="mt-1" value={draft.feedback} disabled={review.isPending} onChange={(event) => updateCockpitArtifactReviewDraft(reviewKey, { feedback: event.target.value })} /></label>
        {!feedbackValid && <p className="text-caption text-destructive">{t(($) => $.artifacts.feedback_required)}</p>}
        <Button type="button" disabled={(draft.decision === "approved" && !bodyReady) || !feedbackValid || review.isPending} aria-busy={review.isPending} onClick={() => void submitReview()}>{review.isPending && <Spinner />}{t(($) => $.workflow.submit_review)}</Button>
      </div> : draft.feedback && <div className="space-y-2 border-t border-border pt-4"><h3 className="text-caption font-medium">{t(($) => $.artifacts.review_draft)}</h3><p className="whitespace-pre-wrap break-words text-body">{draft.feedback}</p></div>}
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      {version.content_hash && <details className="text-micro text-muted-foreground"><summary className="cursor-pointer">{t(($) => $.artifacts.identity)}</summary><p className="mt-2 break-all font-mono">{version.content_hash}</p></details>}
    </>}
  </section>;
}

function ArtifactHistory({ wsId, artifact, scope }: { wsId: string; artifact: CockpitArtifactHeader; scope: CockpitScope }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation(); const back = cockpitArtifactReturn(navigation.searchParams);
  const [open, setOpen] = useState(false); const [cursors, setCursors] = useState<string[]>([""]);
  const query = useQuery({ ...cockpitArtifactVersionsOptions(wsId, artifact.id, { page_size: 25, cursor: cursors.at(-1) || undefined }), enabled: open });
  const page = query.data;
  return <section className="space-y-3 rounded-xl border border-border bg-card p-4"><Button type="button" variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}><History className="size-3.5" />{t(($) => $.artifacts.history, { count: artifact.version_count })}</Button>
    {open && <>{page ? <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching}
      onPrevious={() => { if (cursors.length > 1) setCursors(cursors.slice(0, -1)); }} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      : cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => setCursors(cursors.slice(0, -1))}>{t(($) => $.task_flow.previous)}</Button>}
      {query.isPending ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <ul className="max-h-96 overflow-y-auto divide-y divide-border">{page.items.map((version) => <li key={version.id}>
        <AppLink href={cockpitArtifactPath(paths.cockpit(), artifact.id, scope, version.id, back)} className="flex flex-wrap items-center gap-3 py-3 text-caption hover:underline"><span className="font-medium">{t(($) => $.artifacts.version, { number: version.version_number })}</span><ArtifactStatus status={version.decision} /><span className="ml-auto text-muted-foreground">{version.created_at.slice(0, 10)}</span></AppLink>
      </li>)}</ul>}
    </>}
  </section>;
}
