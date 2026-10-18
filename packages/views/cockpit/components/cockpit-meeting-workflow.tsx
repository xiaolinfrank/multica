"use client";

import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import {
  acknowledgeCockpitMinutesSubmission, cockpitSelectedMemberOptions, CockpitUnconfirmedWriteError, cockpitWorkflowSummaryActions, cockpitHistoryViewKey, useCockpitHistoryViewStore,
  EMPTY_COCKPIT_MINUTES_DRAFT, prepareCockpitMinutesSubmission, rejectCockpitMinutesSubmission,
  setCockpitMinutesDraftContent, useCockpitMinutesDraftStore,
  useSubmitCockpitMinutesVersion,
  useReviewCockpitMinutesVersion, usePublishCockpitMinutesVersion,
} from "@multica/core/cockpit";
import type {
  CockpitMeetingWorkflowSummary,
  CockpitMinutesDecision,
} from "@multica/core/types";
import type { CockpitMember } from "./cockpit-people";
import { Button } from "@multica/ui/components/ui/button";
import { useWorkspacePaths } from "@multica/core/paths";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { LocalPathLink } from "../../common/local-path-link";
import { CockpitReviewerHandoffControl } from "./cockpit-reviewer-handoff";
import { CockpitMinutesNasCopies, CockpitMinutesPublishControl } from "./cockpit-minutes-nas";
import { CockpitMinutesReader, useMinutesDecisionLabel } from "./cockpit-minutes-reader";
import { CockpitMeetingHistory } from "./cockpit-meeting-history";
import { WorkflowIssueLink } from "./cockpit-workflow-issue-link";
import { CockpitMeetingActions } from "./cockpit-meeting-actions";
import { CockpitFlowError } from "./cockpit-task-flow";
import { createSafeId } from "@multica/core/utils";



/** Compact minutes-task summary: where the minutes issue stands. */
export function CockpitMinutesTaskCard({ workflow }: { workflow: CockpitMeetingWorkflowSummary }) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const issue = workflow.minutes_issue;
  return <section className="space-y-2 rounded-lg border border-border p-3" aria-label={t(($) => $.workflow.minutes_task)}>
    <h3 className="text-title-sm font-medium">{t(($) => $.workflow.minutes_task)}</h3>
    {issue ? <div className="space-y-1 text-caption">
      <AppLink href={paths.issueDetail(issue.identifier || issue.id)} target="_blank" rel="noreferrer" className="text-primary underline">
        <span className="mr-1.5 font-mono text-muted-foreground">{issue.identifier || issue.id}</span>{issue.title}
      </AppLink>
      <p className="text-muted-foreground">{issue.status}</p>
    </div> : <p className="text-caption text-muted-foreground">{t(($) => $.workflow.no_minutes_issue)}</p>}
  </section>;
}
export function CockpitMeetingWorkflowPanel({
  wsId, meetingId, currentUserId, members, workflow,
  loading, loadError, onReload, nasDir, recordingHref, readOnly,
}: {
  wsId: string;
  meetingId: string;
  currentUserId: string;
  members: CockpitMember[];
  workflow: CockpitMeetingWorkflowSummary | null | undefined;
  loading: boolean;
  loadError: boolean;
  onReload: () => void;
  /** The meeting NAS directory: the panel's "open directory" hands off to the OS. */
  nasDir: string;
  /** Where to open the minutes task when the workflow is not enabled yet. */
  recordingHref?: string;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const id = useId();
  const decisionLabel = useMinutesDecisionLabel();
  const [reader, setReader] = useState<{ id: string; number: number; reviewIssueId: string; reviewerId: string } | null>(null);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, { decision: CockpitMinutesDecision; feedback: string }>>({});
  const reviewKey = reader ? JSON.stringify([reader.id, reader.reviewIssueId, reader.reviewerId]) : "";
  const reviewDraft = reviewDrafts[reviewKey] ?? { decision: "approved", feedback: "" };
  const { decision, feedback } = reviewDraft;
  const setDecision = (decision: CockpitMinutesDecision) => setReviewDrafts((drafts) => ({ ...drafts, [reviewKey]: { ...(drafts[reviewKey] ?? { decision: "approved", feedback: "" }), decision } }));
  const setFeedback = (feedback: string) => setReviewDrafts((drafts) => ({ ...drafts, [reviewKey]: { ...(drafts[reviewKey] ?? { decision: "approved", feedback: "" }), feedback } }));
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyElement = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const commandLock = useRef(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const futureMember = useQuery(cockpitSelectedMemberOptions(wsId, workflow?.enabled ? workflow.reviewer_id ?? "" : ""));
  const currentMember = useQuery(cockpitSelectedMemberOptions(wsId, workflow?.enabled ? workflow.current_version?.reviewer_id ?? "" : ""));
  const futureReviewerConfirmed = !futureMember.isError && !futureMember.isFetching && Boolean(futureMember.data?.items.some((entry) => entry.id === workflow?.reviewer_id));
  const currentReviewerConfirmed = !currentMember.isError && !currentMember.isFetching && Boolean(currentMember.data?.items.some((entry) => entry.id === workflow?.current_version?.reviewer_id));
  const submit = useSubmitCockpitMinutesVersion(wsId);
  const review = useReviewCockpitMinutesVersion(wsId);
  const publish = usePublishCockpitMinutesVersion(wsId);
  const draft = useCockpitMinutesDraftStore((state) => state.draft.byMeeting[meetingId] ?? EMPTY_COCKPIT_MINUTES_DRAFT);

  async function runCommand(command: () => Promise<unknown>, submission = false) {
    if (commandLock.current) return;
    commandLock.current = true;
    setCommandBusy(true);
    setError("");
    try {
      await command();
    } catch (cause) {
      if (submission && cause instanceof ApiError && [400, 403, 404, 409, 422].includes(cause.status)) {
        rejectCockpitMinutesSubmission(meetingId);
      }
      setError(cause instanceof CockpitUnconfirmedWriteError
        ? t(($) => $.workflow.unconfirmed)
        : cause instanceof Error ? cause.message : t(($) => $.workflow.command_failed));
    } finally {
      commandLock.current = false;
      setCommandBusy(false);
    }
  }

  if (loading) return <div className="flex items-center gap-2 py-5 text-caption text-muted-foreground"><Spinner />{t(($) => $.workflow.loading)}</div>;
  if (!workflow || workflow.meeting_id !== meetingId) return <div role="alert" className="space-y-3">
    <p className="text-caption text-destructive">{t(($) => $.workflow.load_failed)}</p>
    <Button type="button" size="sm" variant="outline" onClick={onReload}>{t(($) => $.binding.retry)}</Button>
    {nasDir ? <LocalPathLink path={nasDir} className="text-caption">{t(($) => $.meeting_lifecycle.open_directory)}</LocalPathLink> : null}
  </div>;

  if (!workflow.enabled) {
    return <div className="space-y-2 text-caption"><p>{t(($) => $.workflow.create_minutes_first)}</p>
      {recordingHref && <AppLink href={recordingHref} className="text-primary underline">{t(($) => $.meeting_stage.recording)}</AppLink>}</div>;
  }

  const actions = cockpitWorkflowSummaryActions(workflow, currentUserId);
  const current = actions.current;
  if (!actions.valid) return <div role="alert" className="space-y-3">
    <p className="text-caption text-destructive">{t(($) => $.workflow.incomplete)}</p>
    <Button type="button" variant="outline" size="sm" onClick={onReload}>{t(($) => $.binding.retry)}</Button>
  </div>;
  const memberName = (userId: string | null) => futureMember.data?.items.find((member) => member.id === userId)?.title
    || currentMember.data?.items.find((member) => member.id === userId)?.title
    || members.find((member) => member.user_id === userId)?.name || userId;
  const reviewerName = futureMember.data?.items.find((entry) => entry.id === workflow.reviewer_id)?.title || memberName(workflow.reviewer_id);
  const reviewerMissing = Boolean(workflow.reviewer_id && futureMember.data && !futureMember.isError && !futureMember.isFetching && !futureReviewerConfirmed);
  const currentReviewerMissing = Boolean(current && currentMember.data && !currentMember.isError && !currentMember.isFetching && !currentReviewerConfirmed);
  const memberQuery = current?.decision === "pending" ? currentMember : futureMember;
  const memberReadUnconfirmed = memberQuery.isPending || memberQuery.isFetching || memberQuery.isError || !memberQuery.data;
  const pendingReviewerMissing = current?.decision === "pending" && currentReviewerMissing;
  const submitVersion = async () => {
    const body = prepareCockpitMinutesSubmission(meetingId, workflow.revision, draft.submission_key || createSafeId());
    const result = await submit.mutateAsync({ meetingId, body });
    if (result.receipt.version) acknowledgeCockpitMinutesSubmission(meetingId, [result.receipt.version]);
  };
  return <Dialog open={Boolean(reader)} onOpenChange={(open) => { if (!open && !commandBusy) setReader(null); }}><div className="space-y-5">
    <CockpitMinutesTaskCard workflow={workflow} />
    {(pendingReviewerMissing || reviewerMissing) && <div role="status" className="space-y-1 rounded-md bg-warning-subtle p-3 text-caption text-foreground">
      <p>{pendingReviewerMissing ? t(($) => $.workflow.current_reviewer_unavailable) : t(($) => $.workflow.reviewer_unavailable)}</p>
      <p>{actions.canReassignReviewer && !readOnly ? t(($) => $.workflow.handoff_recovery) : t(($) => $.workflow.handoff_manager_only)}</p>
    </div>}
    <details className="space-y-2"><summary className="cursor-pointer text-caption text-muted-foreground">{t(($) => $.workflow.review_settings)}</summary>
      {memberReadUnconfirmed && (memberQuery.isError || (memberQuery.isSuccess && !memberQuery.data)
        ? <CockpitFlowError onRetry={() => void memberQuery.refetch()} />
        : <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><Spinner />{t(($) => $.workflow.loading)}</div>)}
      {current?.decision !== "pending" && <p className="break-words text-caption text-muted-foreground">{t(($) => $.workflow.future_reviewer, { name: reviewerName })}</p>}
      <CockpitReviewerHandoffControl wsId={wsId} workflow={workflow} members={members}
        canTransfer={actions.canReassignReviewer && !readOnly} disabled={commandBusy || loadError} onReload={onReload} />
    </details>
    {loadError && <div role="alert" className="space-y-2 text-caption text-destructive">
      <p>{t(($) => $.workflow.refresh_failed)}</p>
      <Button type="button" variant="outline" size="sm" onClick={onReload}>{t(($) => $.binding.retry)}</Button>
    </div>}
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    {current && <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t(($) => $.workflow.current_version)}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-title-sm font-medium">{t(($) => $.minutes_history.current)} · {t(($) => $.workflow.version, { number: current.version_number })}</h3>
        <div className="flex flex-wrap gap-2 text-caption"><span>{decisionLabel(current.decision)}</span>
          <span className="text-muted-foreground">{current.published_at ? t(($) => $.workflow.published) : t(($) => $.workflow.unpublished)}</span></div></div>
      <p className="text-caption text-muted-foreground">{t(($) => $.workflow.review_issue)}</p>
      <p className="text-caption text-muted-foreground">{t(($) => $.workflow.reviewer_name, {
        name: memberName(current.reviewer_id),
      })}</p>
      <WorkflowIssueLink wsId={wsId} issue={current.review_issue} />
      <DialogTrigger render={<Button type="button" size="sm" variant={actions.canReview && !readOnly ? "default" : "outline"} onClick={() => setReader({ id: current.id, number: current.version_number, reviewIssueId: current.review_issue.id, reviewerId: current.reviewer_id })} />}>
        {actions.canReview && !readOnly ? t(($) => $.workflow.read_and_review) : t(($) => $.minutes_history.read_current)}</DialogTrigger>
      {current.has_feedback && <p className="text-caption text-muted-foreground">{t(($) => $.minutes_history.has_feedback)}</p>}
      {current.decision === "pending" && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.formal_review_hint)}</p>}
      {current.decision === "changes_requested" && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.revision_hint)}{" "}{workflow.minutes_issue && <AppLink href={paths.issueDetail(workflow.minutes_issue.id)} target="_blank" rel="noreferrer" className="text-primary underline">{t(($) => $.workflow.revise_issue)}</AppLink>}</p>}
      {current.decision === "approved" && !current.published_at && !actions.canPublish && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.publisher_required)}</p>}
      {current.decision === "approved" && !current.published_at && <CockpitMinutesPublishControl key={current.id} workflow={workflow}
        disabled={Boolean(readOnly || !actions.canPublish || commandBusy)} pending={publish.isPending}
        onPublish={(nasExport) => void runCommand(() => publish.mutateAsync({ meetingId, versionId: current.id, revision: workflow.revision, nasExport }))} />}
    </section>}
    {workflow.published_version && workflow.published_version.id !== current?.id && <section className="space-y-3 rounded-lg border border-brand/20 bg-brand/5 p-4" aria-label={t(($) => $.minutes_history.official)}>
      <h3 className="text-title-sm font-medium">{t(($) => $.minutes_history.official)} · {t(($) => $.workflow.version, { number: workflow.published_version.version_number })}</h3>
      <DialogTrigger render={<Button type="button" size="sm" variant="outline" onClick={() => { if (workflow.published_version) setReader({ id: workflow.published_version.id, number: workflow.published_version.version_number, reviewIssueId: workflow.published_version.review_issue.id, reviewerId: workflow.published_version.reviewer_id }); }} />}>
        {t(($) => $.minutes_history.read_published)}</DialogTrigger>
    </section>}
    <CockpitMinutesNasCopies wsId={wsId} workflow={workflow} userId={currentUserId} readOnly={readOnly}
      disabled={commandBusy || loadError} onReload={onReload} onOpenHistory={() => {
        useCockpitHistoryViewStore.getState().update(cockpitHistoryViewKey(wsId, meetingId), { section: "exports" }); setHistoryOpen(true);
        requestAnimationFrame(() => historyElement.current?.scrollIntoView?.({ block: "start" }));
      }} />
    {workflow.published_version_id && <CockpitMeetingActions wsId={wsId} workflow={workflow} userId={currentUserId} readOnly={readOnly} />}
    {!readOnly && (actions.canSubmit || draft.pending) && <details className="space-y-3 rounded-lg border border-border p-4"><summary className="cursor-pointer text-caption text-muted-foreground">{t(($) => $.workflow.manual_submission)}</summary>
      <label htmlFor={`${id}-draft`} className="block text-title-sm font-medium">{t(($) => $.workflow.draft)}</label>
      <Textarea id={`${id}-draft`} value={draft.content} rows={8} disabled={commandBusy || Boolean(draft.pending)}
        onChange={(event) => setCockpitMinutesDraftContent(meetingId, event.target.value)} />
      <p className="text-caption text-muted-foreground">{draft.pending ? t(($) => $.workflow.submission_pending) : t(($) => $.workflow.draft_hint)}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={commandBusy || !draft.content.trim() || (!actions.canSubmit && !draft.pending) || (!futureReviewerConfirmed && !draft.pending)} aria-busy={submit.isPending}
          onClick={() => void runCommand(submitVersion, true)}>{submit.isPending && <Spinner />}{draft.pending ? t(($) => $.workflow.retry_submission) : t(($) => $.workflow.submit_version)}</Button>
        {draft.pending && <Button type="button" size="sm" variant="outline" disabled={commandBusy} onClick={onReload}>{t(($) => $.workflow.refresh_status)}</Button>}
      </div>
    </details>}
    <div ref={historyElement}><CockpitMeetingHistory wsId={wsId} workflow={workflow} members={members} userId={currentUserId} readOnly={readOnly}
      disabled={commandBusy || loadError} open={historyOpen} onOpenChange={setHistoryOpen} onRead={(version) => setReader({ id: version.id, number: version.version_number, reviewIssueId: version.review_issue.id, reviewerId: version.reviewer_id })} /></div>
    {reader && <CockpitMinutesReader wsId={wsId} workflow={workflow} versionId={reader.id} versionNumber={reader.number} busy={commandBusy}>
      {(detail) => current && reader.id === current.id && reader.reviewIssueId === current.review_issue.id && reader.reviewerId === current.reviewer_id && detail.version.id === current.id && detail.version.content_hash === current.content_hash
        && detail.version.review_issue.id === current.review_issue.id && detail.version.reviewer_id === current.reviewer_id
        && detail.version.decision === current.decision
        && detail.can_review && actions.canReview && !readOnly && currentReviewerConfirmed && !loadError
        ? <>{error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <div className="space-y-3 border-t pt-3">
        <div className="space-y-1"><label htmlFor={`${id}-decision`} className="text-caption">{t(($) => $.workflow.decision)}</label>
          <Select value={decision} disabled={commandBusy} onValueChange={(value) => {
            if (value === "approved" || value === "changes_requested" || value === "rejected") setDecision(value);
          }} items={[
            { value: "approved", label: t(($) => $.workflow.approve) },
            { value: "changes_requested", label: t(($) => $.workflow.request_changes) },
            { value: "rejected", label: t(($) => $.workflow.reject) },
          ]}>
            <SelectTrigger id={`${id}-decision`} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="approved">{t(($) => $.workflow.approve)}</SelectItem>
              <SelectItem value="changes_requested">{t(($) => $.workflow.request_changes)}</SelectItem>
              <SelectItem value="rejected">{t(($) => $.workflow.reject)}</SelectItem></SelectContent>
          </Select>
        </div>
        <label htmlFor={`${id}-feedback`} className="block text-caption">{t(($) => $.workflow.feedback)}</label>
        <Textarea id={`${id}-feedback`} value={feedback} disabled={commandBusy} onChange={(event) => setFeedback(event.target.value)} rows={3} />
        {decision !== "approved" && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.feedback_required)}</p>}
        <Button type="button" size="sm" disabled={commandBusy || (decision !== "approved" && !feedback.trim())} aria-busy={review.isPending}
          onClick={() => void runCommand(async () => { await review.mutateAsync({ meetingId, versionId: current.id,
            body: { expected_revision: workflow.revision, decision, feedback: feedback.trim() } }); setReviewDrafts((drafts) => { const next = { ...drafts }; delete next[reviewKey]; return next; }); setReader(null); })}>
          {review.isPending && <Spinner />}{t(($) => $.workflow.submit_review)}</Button>
      </div>
          </> : feedback || decision !== "approved" ? <section className="space-y-2 rounded-md bg-muted p-3" aria-label={t(($) => $.minutes_history.review_draft)}>
            <h3 className="text-caption font-medium">{t(($) => $.minutes_history.review_draft)}</h3>
            <p className="text-caption text-muted-foreground">{t(($) => $.minutes_history.review_draft_scope)}</p>
            <p className="text-caption">{t(($) => $.workflow.decision)} · {decision === "approved" ? t(($) => $.workflow.approve) : decision === "changes_requested" ? t(($) => $.workflow.request_changes) : t(($) => $.workflow.reject)}</p>
            <Textarea aria-label={t(($) => $.minutes_history.review_draft)} value={feedback} readOnly rows={4} />
          </section> : null}
    </CockpitMinutesReader>}
  </div></Dialog>;
}
