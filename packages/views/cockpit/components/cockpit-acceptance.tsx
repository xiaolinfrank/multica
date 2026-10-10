"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  cockpitAcceptanceOptions, cockpitAcceptanceCriteriaOptions, cockpitAcceptanceRequestsOptions, cockpitAcceptanceRequestOptions,
  cockpitArtifactPath, cockpitArtifactDraftKey, cockpitObjectPath, useCockpitArtifactDraftStore, updateCockpitArtifactReviewDraft,
  clearCockpitArtifactReviewDraft, useReviewCockpitAcceptanceRequest, cockpitAcceptanceReviewerHandoffsOptions, type CockpitScope,
} from "@multica/core/cockpit";
import type { CockpitAcceptanceHeader, CockpitArtifactReview } from "@multica/core/types";
import { ApiError } from "@multica/core/api";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { CheckCheck, History } from "lucide-react";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { ArtifactStatus, useArtifactStatusLabel } from "./cockpit-artifact-status";
import { CockpitAcceptanceCriteriaEditor } from "./cockpit-acceptance-criteria";
import { CockpitAcceptanceRequestForm } from "./cockpit-acceptance-request";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { WorkflowIssueLink } from "./cockpit-workflow-issue-link";
import { CockpitArtifactReviewerTransfer } from "./cockpit-artifact-reviewer-transfer";
import { CockpitArtifactAvailabilityReason } from "./cockpit-artifact-availability";

const EMPTY_REVIEW: { decision: CockpitArtifactReview["decision"]; feedback: string } = { decision: "approved", feedback: "" };

export function CockpitAcceptance({ wsId, nodeId, scope, currentUserId, readOnly = false }: {
  wsId: string; nodeId: string; scope: CockpitScope; currentUserId: string; readOnly?: boolean;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation();
  const query = useQuery(cockpitAcceptanceOptions(wsId, nodeId));
  const criteria = useQuery(cockpitAcceptanceCriteriaOptions(wsId, nodeId));
  const data = query.data; const definition = criteria.data;
  const [historyOpen, setHistoryOpen] = useState(false); const [cursors, setCursors] = useState<string[]>([""]);
  const history = useQuery({ ...cockpitAcceptanceRequestsOptions(wsId, nodeId, { page_size: 25, cursor: cursors.at(-1) || undefined }), enabled: historyOpen });
  const requestId = navigation.searchParams.get("acceptance");
  const requestHref = (id: string) => cockpitObjectPath(paths.cockpit(), { kind: "node", id: nodeId, view: "acceptance", requestId: id }, scope);
  return <section aria-label={t(($) => $.acceptance.title)} className="space-y-5">
    <div className="flex items-start gap-3"><CheckCheck className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden /><div><h2 className="text-title-sm font-semibold">{t(($) => $.acceptance.title)}</h2><p className="mt-1 text-caption text-muted-foreground">{t(($) => $.acceptance.basis)}</p></div></div>
    {query.isPending ? <div role="status" className="flex gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div> : !data ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
      {query.isError && <div className="space-y-2 rounded-lg bg-warning-subtle p-3 text-caption"><p>{t(($) => $.work_overview.refresh_failed)}</p><CockpitFlowError onRetry={() => void query.refetch()} /></div>}
      {data.needs_reacceptance && <p role="status" className="rounded-lg bg-warning-subtle p-3 text-caption">{t(($) => $.acceptance.changed_since_approval)}</p>}
      <div className="grid gap-3 sm:grid-cols-2">{([[t(($) => $.acceptance.current_request), data.current_request], [t(($) => $.acceptance.last_approved), data.last_approved_request]] as const).map(([title, request]) => <section key={title} className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label={title}>
        <h3 className="text-caption font-medium text-muted-foreground">{title}</h3>{request ? <><ArtifactStatus status={request.decision} /><p className="text-micro text-muted-foreground">{t(($) => $.acceptance.definition_revision, { revision: request.criteria_revision })}</p>
          <AppLink href={requestHref(request.id)} className="text-caption text-primary hover:underline">{t(($) => $.acceptance.read_request)}</AppLink></> : <p className="text-caption text-muted-foreground">{t(($) => $.acceptance.no_request)}</p>}
      </section>)}</div>
      <section id="cockpit-acceptance-criteria" className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label={t(($) => $.acceptance.criteria)}>
        <div className="flex flex-wrap items-center gap-3"><h3 className="mr-auto text-caption font-medium">{t(($) => $.acceptance.criteria)}</h3>
          {definition?.can_edit && <CockpitAcceptanceCriteriaEditor key={`${wsId}:${nodeId}`} wsId={wsId} definition={definition} disabled={readOnly || criteria.isFetching || criteria.isError} />}</div>
        {criteria.isPending ? <Spinner /> : criteria.isError || !definition ? <CockpitFlowError onRetry={() => void criteria.refetch()} /> : <>
          <p className="text-micro text-muted-foreground">{t(($) => $.acceptance.definition_revision, { revision: definition.revision })}</p>
          {definition.items.length ? <ol className="max-h-80 list-inside list-decimal space-y-3 overflow-y-auto">{definition.items.map((item) => <li key={item.id} className="break-words text-body"><span className="font-medium">{item.title}</span>{item.description && <p className="mt-1 whitespace-pre-wrap text-caption text-muted-foreground">{item.description}</p>}</li>)}</ol>
            : <div className="space-y-2 text-caption text-muted-foreground"><p>{t(($) => $.acceptance.no_criteria)}</p>{!definition.can_edit && <p>{t(($) => $.artifact_runtime.criteria_manager_hint)}</p>}</div>}
          {!readOnly && <CockpitAcceptanceRequestForm key={`${wsId}:${nodeId}`} wsId={wsId} header={data} definition={definition} scope={scope} currentUserId={currentUserId} disabled={query.isFetching || query.isError || criteria.isFetching} />}
        </>}
      </section>
      {requestId && <AcceptanceReader key={requestId} wsId={wsId} header={data} requestId={requestId} scope={scope} currentUserId={currentUserId} readOnly={readOnly || query.isError || query.isFetching} />}
      {data.current_request?.decision === "pending" && !data.current_request.superseded_at && <CockpitArtifactReviewerTransfer key={`${wsId}:${nodeId}:${data.current_request.id}`} wsId={wsId}
        target={{ kind: "acceptance_reviewer", nodeId, requestId: data.current_request.id }} revision={data.current_request.revision}
        signature={JSON.stringify([data.current_request.id, data.current_request.revision, data.current_request.reviewer_id, data.current_request.review_issue.id])}
        reviewerId={data.current_request.reviewer_id} hint={t(($) => $.artifact_runtime.transfer_acceptance_hint)} canTransfer={data.can_reassign_reviewer}
        disabled={readOnly || query.isError || query.isFetching} />}
      <AcceptanceReviewerHistory wsId={wsId} nodeId={nodeId} />
      <section className="space-y-3 rounded-xl border border-border bg-card p-4"><Button type="button" variant="ghost" size="sm" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><History className="size-3.5" />{t(($) => $.acceptance.history, { count: data.request_count })}</Button>
        {historyOpen && <>{history.data ? <CockpitFlowPaging page={cursors.length} shown={history.data.items.length} total={history.data.total} hasNext={Boolean(history.data.next_cursor)} busy={history.isFetching}
          onPrevious={() => { if (cursors.length > 1) setCursors(cursors.slice(0, -1)); }} onNext={() => { if (history.data?.next_cursor) setCursors([...cursors, history.data.next_cursor]); }} />
          : cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => setCursors(cursors.slice(0, -1))}>{t(($) => $.task_flow.previous)}</Button>}
          {history.isPending ? <Spinner /> : history.isError || !history.data ? <CockpitFlowError onRetry={() => void history.refetch()} /> : <ul className="max-h-80 overflow-y-auto divide-y divide-border">{history.data.items.map((request) => <li key={request.id} className="py-3">
            <AppLink href={requestHref(request.id)} className="flex flex-wrap items-center gap-3 text-caption hover:underline"><span>{t(($) => $.acceptance.definition_revision, { revision: request.criteria_revision })}</span><ArtifactStatus status={request.decision} />{request.superseded_at && <span className="text-muted-foreground">{t(($) => $.acceptance.superseded)}</span>}<span className="ml-auto text-muted-foreground">{request.created_at.slice(0, 10)}</span></AppLink>
          </li>)}</ul>}
        </>}
      </section>
    </>}
  </section>;
}

function AcceptanceReader({ wsId, header, requestId, scope, currentUserId, readOnly }: { wsId: string; header: CockpitAcceptanceHeader; requestId: string; scope: CockpitScope; currentUserId: string; readOnly: boolean }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const statusLabel = useArtifactStatusLabel();
  const query = useQuery(cockpitAcceptanceRequestOptions(wsId, header.node_id, requestId));
  const detail = query.data; const request = detail?.request;
  const observed = useRef<string | null>(null);
  const [, setReviewContext] = useState(0);
  const identity = request ? cockpitArtifactDraftKey(wsId, "review", "acceptance", header.node_id, request.id, request.review_issue.id, request.reviewer_id) : "";
  if (identity && !observed.current) observed.current = identity;
  const key = observed.current ?? "";
  const draft = useCockpitArtifactDraftStore((store) => store.draft.reviews[key] ?? EMPTY_REVIEW);
  const review = useReviewCockpitAcceptanceRequest(wsId); const lock = useRef(false); const [error, setError] = useState("");
  const pin = header.current_request;
  const stale = Boolean(request && pin?.id === request.id && (pin.revision > request.revision || pin.revision === request.revision
    && (pin.reviewer_id !== request.reviewer_id || pin.review_issue.id !== request.review_issue.id || pin.decision !== request.decision)));
  const canReview = Boolean(!readOnly && !stale && !query.isError && !query.isFetching && currentUserId && request && identity === key
    && header.current_request?.id === request.id && request.can_review && request.decision === "pending" && !request.superseded_at
    && request.reviewer_id === currentUserId);
  const canApprove = Boolean(detail?.evidence_available && !detail.definition_changed && !detail.evidence_outdated);
  const feedbackValid = new TextEncoder().encode(draft.feedback.trim()).length <= 16000 && (draft.decision === "approved" || Boolean(draft.feedback.trim()));
  async function submit() {
    if (!request || lock.current || !canReview || !feedbackValid || (draft.decision === "approved" && !canApprove)) return;
    lock.current = true; setError("");
    try { await review.mutateAsync({ nodeId: header.node_id, requestId, body: { expected_revision: request.revision, decision: draft.decision, feedback: draft.feedback.trim() } }); clearCockpitArtifactReviewDraft(key, draft); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : t(($) => $.task_flow.unconfirmed)); }
    finally { lock.current = false; }
  }
  return <section aria-label={t(($) => $.acceptance.packet)} className="space-y-4 rounded-xl border border-border bg-card p-4">
    <h3 className="text-title-sm font-semibold">{t(($) => $.acceptance.packet)}</h3>
    {query.isPending ? <Spinner /> : !detail || !request ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
      {query.isError && <CockpitFlowError onRetry={() => void query.refetch()} />}
      <div className="flex flex-wrap items-center gap-2"><ArtifactStatus status={request.decision} /><span className="text-caption text-muted-foreground">{t(($) => $.acceptance.definition_revision, { revision: request.criteria_revision })}</span></div>
      {request.superseded_at && <p role="status" className="rounded-lg bg-muted p-3 text-caption">{t(($) => $.acceptance.superseded_hint)}</p>}
      {(detail.definition_changed || detail.evidence_outdated) && <p role="status" className="rounded-lg bg-warning-subtle p-3 text-caption">{t(($) => $.acceptance.packet_changed)}</p>}
      {(stale || !detail.evidence_available) && <div role="status" className="space-y-2 rounded-lg bg-warning-subtle p-3 text-caption"><p>{stale ? t(($) => $.artifact_runtime.version_changed) : t(($) => $.artifact_runtime.evidence_missing)}</p>
        {!detail.evidence_available && <CockpitArtifactAvailabilityReason reason={detail.evidence_unavailable_reason} />}
        {canReview && <p>{t(($) => $.artifact_runtime.return_hint)}</p>}
        <Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>{t(($) => $.artifact_runtime.recheck)}</Button></div>}
      {identity !== key && !stale && <div className="space-y-2 text-caption"><p>{t(($) => $.artifact_runtime.review_changed)}</p>{!readOnly && request.can_review && request.reviewer_id === currentUserId && header.current_request?.id === request.id && <Button size="sm" variant="outline" onClick={() => { observed.current = identity; setReviewContext((old) => old + 1); }}>{t(($) => $.artifact_runtime.use_current_review)}</Button>}</div>}
      <WorkflowIssueLink wsId={wsId} issue={request.review_issue} />
      {header.current_request?.id !== request.id && <CockpitArtifactReviewerTransfer wsId={wsId} target={{ kind: "acceptance_reviewer", nodeId: header.node_id, requestId: request.id }} revision={request.revision}
        signature={JSON.stringify([request.id, request.revision, request.reviewer_id, request.review_issue.id])} reviewerId={request.reviewer_id}
        hint={t(($) => $.artifact_runtime.transfer_acceptance_hint)} canTransfer={false} disabled={readOnly} />}
      <ol className="space-y-4">{detail.evidence.map((item) => <li key={item.criterion.id} className="space-y-2 rounded-lg border border-border p-3"><h4 className="break-words text-body font-medium">{item.criterion.title}</h4>
        {item.criterion.description && <p className="whitespace-pre-wrap break-words text-caption text-muted-foreground">{item.criterion.description}</p>}
        <ul className="space-y-2">{item.versions.map((version) => <li key={version.id}><AppLink href={cockpitArtifactPath(paths.cockpit(), version.artifact_id, scope, version.id, { nodeId: header.node_id, view: "acceptance", requestId })} className="text-caption text-primary hover:underline">
          {t(($) => $.acceptance.read_evidence, { number: version.version_number })}{version.filename ? ` · ${version.filename}` : ""}</AppLink></li>)}</ul>
      </li>)}</ol>
      {detail.note && <p className="whitespace-pre-wrap break-words text-body">{detail.note}</p>}
      {detail.feedback && <div className="space-y-1 border-t border-border pt-3"><h4 className="text-caption font-medium">{t(($) => $.workflow.feedback)}</h4><p className="whitespace-pre-wrap break-words text-body">{detail.feedback}</p></div>}
      {canReview ? <div className="space-y-3 border-t border-border pt-4"><label className="block text-caption">{t(($) => $.workflow.decision)}<Select value={draft.decision} disabled={review.isPending}
        items={["approved", "changes_requested", "rejected"].map((value) => ({ value, label: statusLabel(value) }))} onValueChange={(value) => { if (value === "approved" || value === "changes_requested" || value === "rejected") updateCockpitArtifactReviewDraft(key, { decision: value }); }}>
        <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger><SelectContent>{["approved", "changes_requested", "rejected"].map((value) => <SelectItem key={value} value={value}>{statusLabel(value)}</SelectItem>)}</SelectContent></Select></label>
        <label className="block text-caption">{t(($) => $.workflow.feedback)}<Textarea className="mt-1" value={draft.feedback} disabled={review.isPending} onChange={(event) => updateCockpitArtifactReviewDraft(key, { feedback: event.target.value })} /></label>
        {!feedbackValid && <p className="text-caption text-destructive">{t(($) => $.artifacts.feedback_required)}</p>}
        <Button type="button" disabled={review.isPending || !feedbackValid || (draft.decision === "approved" && !canApprove)} aria-busy={review.isPending} onClick={() => void submit()}>{review.isPending && <Spinner />}{t(($) => $.acceptance.submit_review)}</Button>
      </div> : draft.feedback && <div className="space-y-1 border-t border-border pt-3"><h4 className="text-caption font-medium">{t(($) => $.artifacts.review_draft)}</h4><p className="whitespace-pre-wrap break-words text-body">{draft.feedback}</p></div>}
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    </>}
  </section>;
}

function AcceptanceReviewerHistory({ wsId, nodeId }: { wsId: string; nodeId: string }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const [open, setOpen] = useState(false); const [cursors, setCursors] = useState<string[]>([""]);
  const query = useQuery({ ...cockpitAcceptanceReviewerHandoffsOptions(wsId, nodeId, { cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: open }); const page = query.data;
  return <section className="space-y-3"><Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{t(($) => $.artifact_runtime.reviewer_history)}</Button>
    {open && <>{page ? <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors((old) => old.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      : cursors.length > 1 && <Button size="sm" variant="outline" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
      {query.isPending ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <ul className="max-h-80 space-y-3 overflow-y-auto">{page.items.map((item) => <li key={item.id} className="space-y-2 rounded-lg bg-muted/40 p-3 text-caption"><p className="break-all">{item.from_reviewer_name || item.from_reviewer_id} → {item.to_reviewer_name || item.to_reviewer_id}</p><div className="flex flex-wrap gap-3">
        <AppLink href={paths.issueDetail(item.from_review_issue_id)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t(($) => $.artifact_runtime.previous_review_task)}</AppLink>
        <AppLink href={paths.issueDetail(item.to_review_issue_id)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t(($) => $.artifact_runtime.current_review_task)}</AppLink></div>
        <p className="whitespace-pre-wrap break-words">{item.reason}</p><p className="break-all text-micro text-muted-foreground">{item.created_by_name || item.created_by} · <time dateTime={item.created_at}>{item.created_at}</time></p></li>)}</ul>}</>}
  </section>;
}
