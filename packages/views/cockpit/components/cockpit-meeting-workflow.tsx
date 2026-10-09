"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import {
  acknowledgeCockpitMinutesSubmission, CockpitUnconfirmedWriteError, cockpitWorkflowActions,
  EMPTY_COCKPIT_MINUTES_DRAFT, prepareCockpitMinutesSubmission, rejectCockpitMinutesSubmission,
  setCockpitMinutesDraftContent, useCockpitMinutesDraftStore,
  useEnableCockpitMeetingWorkflow, useUpdateCockpitMeetingReadiness,
  useReleaseCockpitMeetingWorkflow, useSubmitCockpitMinutesVersion,
  useReviewCockpitMinutesVersion, usePublishCockpitMinutesVersion,
} from "@multica/core/cockpit";
import type {
  CockpitMeetingWorkflow, CockpitMeetingWorkflowSetup, CockpitMeetingIssueLink,
  CockpitMinutesDecision, CockpitWorkflowIssue, MemberWithUser, IssueAssigneeType,
} from "@multica/core/types";
import { projectListOptions } from "@multica/core/projects/queries";
import { moduleListOptions } from "@multica/core/modules/queries";
import { useWorkspacePaths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { isBuiltInIssueStatus } from "@multica/core/issue-statuses";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Markdown } from "@multica/ui/markdown";
import { AppLink } from "../../navigation";
import { useLocale, useT } from "../../i18n";
import { AssigneePicker } from "../../issues/components/pickers/assignee-picker";
import { StatusIcon } from "../../issues/components/status-icon";
import { CockpitReviewerSelect } from "./cockpit-reviewer-select";
import { CockpitReviewerHandoffControl } from "./cockpit-reviewer-handoff";
import { CockpitMinutesNasCopies, CockpitMinutesPublishControl } from "./cockpit-minutes-nas";

const NEW_ISSUE = "__new_minutes_issue__";

function WorkflowIssueLink({ issue }: { issue: CockpitWorkflowIssue }) {
  const paths = useWorkspacePaths();
  const { t } = useT("cockpit");
  const { t: issueT } = useT("issues");
  const { getActorName } = useActorName();
  const statusKey = issue.status;
  const status = isBuiltInIssueStatus(statusKey) ? issueT(($) => $.status[statusKey]) : statusKey;
  const assignee = issue.assignee_id ? getActorName(issue.assignee_type, issue.assignee_id) : t(($) => $.workflow.unassigned);
  return <div className="space-y-1"><AppLink href={paths.issueDetail(issue.identifier || issue.id)} newTabTitle={issue.title}
    className="inline-flex max-w-full items-start gap-2 text-caption hover:underline">
    <StatusIcon status={issue.status} className="mt-0.5 size-3.5 shrink-0" />
    <span className="min-w-0 break-words"><span className="mr-1.5 font-mono text-muted-foreground">{issue.identifier || issue.id}</span>{" "}{issue.title}</span>
  </AppLink><p className="text-caption text-muted-foreground">{t(($) => $.workflow.issue_meta, { assignee, status })}</p></div>;
}

export function CockpitMeetingWorkflowPanel({
  wsId, meetingId, currentUserId, members, membersLoaded, issueLinks, workflow,
  loading, loadError, onReload, defaultPlacement, defaultAssigneeType, defaultAssigneeId, readOnly,
}: {
  wsId: string;
  meetingId: string;
  currentUserId: string;
  members: MemberWithUser[];
  membersLoaded: boolean;
  issueLinks: CockpitMeetingIssueLink[];
  workflow: CockpitMeetingWorkflow | undefined;
  loading: boolean;
  loadError: boolean;
  onReload: () => void;
  defaultPlacement: { project_id: string | null; module_id: string | null; node_id: string | null };
  defaultAssigneeType: string | null;
  defaultAssigneeId: string | null;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const id = useId();
  const locale = useLocale();
  const [reviewerId, setReviewerId] = useState(currentUserId);
  const [projectId, setProjectId] = useState(defaultPlacement.project_id || "");
  const [moduleId, setModuleId] = useState(defaultPlacement.module_id || "");
  const [existingIssueId, setExistingIssueId] = useState(NEW_ISSUE);
  const [assigneeType, setAssigneeType] = useState<IssueAssigneeType | null>((defaultAssigneeType || "member") as IssueAssigneeType);
  const [assigneeId, setAssigneeId] = useState(defaultAssigneeId || currentUserId);
  const [decision, setDecision] = useState<CockpitMinutesDecision>("approved");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const commandLock = useRef(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const projects = useQuery({ ...projectListOptions(wsId), enabled: Boolean(workflow && !workflow.enabled && wsId && existingIssueId === NEW_ISSUE) });
  const modules = useQuery({ ...moduleListOptions(wsId, projectId || undefined), enabled: Boolean(workflow && !workflow.enabled && wsId && projectId && existingIssueId === NEW_ISSUE) });
  const enable = useEnableCockpitMeetingWorkflow(wsId);
  const readiness = useUpdateCockpitMeetingReadiness(wsId);
  const release = useReleaseCockpitMeetingWorkflow(wsId);
  const submit = useSubmitCockpitMinutesVersion(wsId);
  const review = useReviewCockpitMinutesVersion(wsId);
  const publish = usePublishCockpitMinutesVersion(wsId);
  const draft = useCockpitMinutesDraftStore((state) => state.draft.byMeeting[meetingId] ?? EMPTY_COCKPIT_MINUTES_DRAFT);
  const fixedReview = workflow?.versions.find((version) => version.id === workflow.current_version_id);

  useEffect(() => {
    if (workflow?.meeting_id === meetingId) acknowledgeCockpitMinutesSubmission(meetingId, workflow.versions);
  }, [meetingId, workflow]);

  useEffect(() => {
    setDecision("approved");
    setFeedback("");
  }, [workflow?.current_version_id, fixedReview?.review_issue.id, fixedReview?.reviewer_id]);

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
  </div>;

  if (!workflow.enabled) {
    const setup = async () => {
      const body: CockpitMeetingWorkflowSetup = { reviewer_id: reviewerId };
      if (existingIssueId !== NEW_ISSUE) body.existing_issue_id = existingIssueId;
      else {
        body.project_id = projectId || undefined;
        body.module_id = moduleId || undefined;
        body.node_id = projectId === defaultPlacement.project_id && moduleId === defaultPlacement.module_id ? defaultPlacement.node_id || undefined : undefined;
        body.assignee_type = assigneeType || "member";
        body.assignee_id = assigneeId || currentUserId;
      }
      await enable.mutateAsync({ meetingId, body });
    };
    return <section className="space-y-4" aria-label={t(($) => $.workflow.title)}>
      <div className="space-y-1"><h3 className="text-title-sm font-medium">{t(($) => $.workflow.setup_title)}</h3>
        <p className="text-caption text-muted-foreground">{t(($) => $.workflow.setup_hint)}</p></div>
      {loadError && <div role="alert" className="space-y-2 text-caption text-destructive">
        <p>{t(($) => $.workflow.refresh_failed)}</p>
        <Button type="button" variant="outline" size="sm" onClick={onReload}>{t(($) => $.binding.retry)}</Button>
      </div>}
      {!readOnly && <>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {existingIssueId === NEW_ISSUE && <>
          <div className="space-y-1"><label htmlFor={`${id}-project`} className="text-caption">{t(($) => $.binding.project)}</label>
            <Select value={projectId || null} disabled={commandBusy || projects.isPending}
              items={(projects.data ?? []).map((entry) => ({ value: entry.id, label: entry.title }))}
              onValueChange={(value) => { setProjectId(value || ""); setModuleId(""); }}>
              <SelectTrigger id={`${id}-project`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{(projects.data ?? []).map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.title}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1"><label htmlFor={`${id}-module`} className="text-caption">{t(($) => $.binding.module)}</label>
            <Select value={moduleId || null} disabled={commandBusy || !projectId || modules.isPending}
              items={(modules.data ?? []).map((entry) => ({ value: entry.id, label: entry.title }))}
              onValueChange={(value) => setModuleId(value || "")}>
              <SelectTrigger id={`${id}-module`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{(modules.data ?? []).map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.title}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          </>}
          <CockpitReviewerSelect members={members} value={reviewerId} onChange={setReviewerId} disabled={commandBusy} />
          <div className="space-y-1"><label htmlFor={`${id}-existing`} className="text-caption">{t(($) => $.workflow.existing_issue)}</label>
            <Select value={existingIssueId} disabled={commandBusy} onValueChange={(value) => setExistingIssueId(value || NEW_ISSUE)}
              items={[{ value: NEW_ISSUE, label: t(($) => $.workflow.new_issue) }, ...issueLinks.map((link) => ({ value: link.issue_id, label: `${link.issue_identifier} ${link.issue_title}` }))]}>
              <SelectTrigger id={`${id}-existing`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NEW_ISSUE}>{t(($) => $.workflow.new_issue)}</SelectItem>
                {issueLinks.map((link) => <SelectItem key={link.issue_id} value={link.issue_id} disabled={link.issue_status !== "backlog"}>
                  {link.issue_identifier} {link.issue_title}
                </SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        {existingIssueId === NEW_ISSUE ? <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption">{t(($) => $.workflow.writer)}</span>
          <AssigneePicker assigneeType={assigneeType} assigneeId={assigneeId || null}
            open={commandBusy ? false : undefined}
            triggerRender={<Button type="button" variant="outline" size="sm" disabled={commandBusy} />}
            onUpdate={(update) => {
            if (commandBusy) return;
            setAssigneeType(update.assignee_type ?? "member"); setAssigneeId(update.assignee_id ?? currentUserId);
          }} />
        </div> : <p className="text-caption text-muted-foreground">{t(($) => $.workflow.adopt_hint)}</p>}
        {issueLinks.length > 0 && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.legacy_hint)}</p>}
        {existingIssueId === NEW_ISSUE && (projects.isError || modules.isError) && <div role="alert" className="space-y-2 text-caption text-destructive">
          <p>{t(($) => $.workflow.placement_failed)}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => { void projects.refetch(); if (projectId) void modules.refetch(); }}>{t(($) => $.binding.retry)}</Button>
        </div>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <Button type="button" size="sm" disabled={commandBusy || loadError || !currentUserId || !reviewerId
          || (existingIssueId === NEW_ISSUE && (!projectId || !moduleId || projects.isError || modules.isError))}
          aria-busy={commandBusy} onClick={() => void runCommand(setup)}>{commandBusy && <Spinner />}{t(($) => $.workflow.enable)}</Button>
      </>}
    </section>;
  }

  const actions = cockpitWorkflowActions(workflow, currentUserId);
  const current = actions.current;
  if (!actions.valid) return <div role="alert" className="space-y-3">
    <p className="text-caption text-destructive">{t(($) => $.workflow.incomplete)}</p>
    <Button type="button" variant="outline" size="sm" onClick={onReload}>{t(($) => $.binding.retry)}</Button>
  </div>;
  const memberName = (userId: string | null) => members.find((member) => member.user_id === userId)?.name
    || members.find((member) => member.user_id === userId)?.email || userId;
  const reviewerName = memberName(workflow.reviewer_id);
  const reviewerMissing = membersLoaded && Boolean(workflow.reviewer_id)
    && !members.some((member) => member.user_id === workflow.reviewer_id);
  const currentReviewerMissing = membersLoaded && Boolean(current)
    && !members.some((member) => member.user_id === current?.reviewer_id);
  const pendingReviewerMissing = current?.decision === "pending" && currentReviewerMissing;
  const decisionLabel = (value: string) => {
    switch (value) {
      case "pending": return t(($) => $.workflow.pending_review);
      case "approved": return t(($) => $.workflow.approved);
      case "changes_requested": return t(($) => $.workflow.changes_requested);
      case "rejected": return t(($) => $.workflow.rejected);
      default: return t(($) => $.workflow.unknown_decision, { decision: value });
    }
  };
  const submitVersion = async () => {
    const body = prepareCockpitMinutesSubmission(meetingId, workflow.revision, draft.submission_key || crypto.randomUUID());
    const result = await submit.mutateAsync({ meetingId, body });
    acknowledgeCockpitMinutesSubmission(meetingId, result.versions);
  };
  return <div className="space-y-5">
    {(pendingReviewerMissing || reviewerMissing) && <div role="status" className="space-y-1 rounded-md bg-warning-subtle p-3 text-caption text-foreground">
      <p>{pendingReviewerMissing ? t(($) => $.workflow.current_reviewer_unavailable) : t(($) => $.workflow.reviewer_unavailable)}</p>
      <p>{actions.canReassignReviewer && !readOnly ? t(($) => $.workflow.handoff_recovery) : t(($) => $.workflow.handoff_manager_only)}</p>
    </div>}
    <div className="space-y-2">
      {current?.decision !== "pending" && <p className="break-words text-caption text-muted-foreground">{t(($) => $.workflow.future_reviewer, { name: reviewerName })}</p>}
      <CockpitReviewerHandoffControl wsId={wsId} workflow={workflow} members={members} membersLoaded={membersLoaded}
        canTransfer={actions.canReassignReviewer && !readOnly} disabled={commandBusy || loadError} onReload={onReload} />
    </div>
    {loadError && <div role="alert" className="space-y-2 text-caption text-destructive">
      <p>{t(($) => $.workflow.refresh_failed)}</p>
      <Button type="button" variant="outline" size="sm" onClick={onReload}>{t(($) => $.binding.retry)}</Button>
    </div>}
    <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t(($) => $.workflow.readiness)}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-title-sm font-medium">{t(($) => $.workflow.readiness)}</h3>
        <span className="text-caption text-muted-foreground">{workflow.released_at ? t(($) => $.workflow.released) : t(($) => $.workflow.awaiting_release)}</span></div>
      <div className="flex flex-wrap items-center gap-3">
        {workflow.ended_at ? <span className="text-caption">{t(($) => $.workflow.ended)}</span>
          : <Button type="button" size="sm" variant="outline" disabled={readOnly || !actions.canManage || commandBusy}
            onClick={() => void runCommand(() => readiness.mutateAsync({ meetingId, body: { expected_revision: workflow.revision, ended: true } }))}>
            {t(($) => $.workflow.mark_ended)}</Button>}
        <label className="flex items-center gap-2 text-caption"><Checkbox checked={workflow.materials_ready}
          disabled={readOnly || !actions.canManage || commandBusy || Boolean(workflow.released_at)}
          onCheckedChange={(checked) => void runCommand(() => readiness.mutateAsync({ meetingId, body: { expected_revision: workflow.revision, materials_ready: checked === true } }))} />
          {t(($) => $.workflow.materials_ready)}</label>
      </div>
      {!workflow.released_at && <>
        <p className="text-caption text-muted-foreground">{workflow.minutes_issue?.status !== "backlog" ? t(($) => $.workflow.need_backlog)
          : !workflow.ended_at ? t(($) => $.workflow.need_ended)
          : !workflow.materials_ready ? t(($) => $.workflow.need_materials) : t(($) => $.workflow.ready_hint)}</p>
        <Button type="button" size="sm" disabled={readOnly || !actions.canRelease || commandBusy} aria-busy={release.isPending}
          onClick={() => void runCommand(() => release.mutateAsync({ meetingId, revision: workflow.revision }))}>
          {release.isPending && <Spinner />}{t(($) => $.workflow.release)}</Button>
      </>}
      <div className="space-y-1"><p className="text-caption font-medium">{t(($) => $.workflow.minutes_issue)}</p>
        {workflow.minutes_issue && <WorkflowIssueLink issue={workflow.minutes_issue} />}</div>
    </section>
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    {current && <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t(($) => $.workflow.current_version)}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-title-sm font-medium">{t(($) => $.workflow.version, { number: current.version_number })}</h3>
        <div className="flex flex-wrap gap-2 text-caption"><span>{decisionLabel(current.decision)}</span>
          <span className="text-muted-foreground">{current.published_at ? t(($) => $.workflow.published) : t(($) => $.workflow.unpublished)}</span></div></div>
      <p className="text-caption text-muted-foreground">{t(($) => $.workflow.review_issue)}</p>
      <p className="text-caption text-muted-foreground">{t(($) => $.workflow.reviewer_name, {
        name: members.find((member) => member.user_id === current.reviewer_id)?.name || current.reviewer_id,
      })}</p>
      <WorkflowIssueLink issue={current.review_issue} />
      <div className="min-w-0 max-w-full overflow-x-auto break-words">
        <Markdown mode="full">{current.content}</Markdown>
      </div>
      {current.feedback && <div className="space-y-1 border-t pt-3"><h4 className="text-caption font-medium">{t(($) => $.workflow.feedback)}</h4><p className="whitespace-pre-wrap break-words text-body">{current.feedback}</p></div>}
      {actions.canReview && !readOnly && !currentReviewerMissing && <div className="space-y-3 border-t pt-3">
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
          onClick={() => void runCommand(() => review.mutateAsync({ meetingId, versionId: current.id,
            body: { expected_revision: workflow.revision, decision, feedback: feedback.trim() } }))}>
          {review.isPending && <Spinner />}{t(($) => $.workflow.submit_review)}</Button>
      </div>}
      {current.decision === "pending" && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.formal_review_hint)}</p>}
      {current.decision === "changes_requested" && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.revision_hint)}</p>}
      {current.decision === "approved" && !current.published_at && <CockpitMinutesPublishControl key={current.id} workflow={workflow}
        disabled={Boolean(readOnly || !actions.canPublish || commandBusy)} pending={publish.isPending}
        onPublish={(nasExport) => void runCommand(() => publish.mutateAsync({ meetingId, versionId: current.id, revision: workflow.revision, nasExport }))} />}
    </section>}
    <CockpitMinutesNasCopies wsId={wsId} workflow={workflow} userId={currentUserId} readOnly={readOnly}
      disabled={commandBusy || loadError} onReload={onReload} />
    {workflow.released_at && !readOnly && (actions.canSubmit || draft.pending) && <section className="space-y-3 rounded-lg border border-border p-4">
      <label htmlFor={`${id}-draft`} className="block text-title-sm font-medium">{t(($) => $.workflow.draft)}</label>
      <Textarea id={`${id}-draft`} value={draft.content} rows={8} disabled={commandBusy || Boolean(draft.pending)}
        onChange={(event) => setCockpitMinutesDraftContent(meetingId, event.target.value)} />
      <p className="text-caption text-muted-foreground">{draft.pending ? t(($) => $.workflow.submission_pending) : t(($) => $.workflow.draft_hint)}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={commandBusy || !draft.content.trim() || (!actions.canSubmit && !draft.pending) || (reviewerMissing && !draft.pending)} aria-busy={submit.isPending}
          onClick={() => void runCommand(submitVersion, true)}>{submit.isPending && <Spinner />}{draft.pending ? t(($) => $.workflow.retry_submission) : t(($) => $.workflow.submit_version)}</Button>
        {draft.pending && <Button type="button" size="sm" variant="outline" disabled={commandBusy} onClick={onReload}>{t(($) => $.workflow.refresh_status)}</Button>}
      </div>
    </section>}
    {workflow.versions.length > 1 && <section className="space-y-2"><h3 className="text-title-sm font-medium">{t(($) => $.workflow.version_history)}</h3>
      {workflow.versions.filter((version) => version.id !== current?.id).map((version) => <details key={version.id} className="rounded-md border border-border p-3">
        <summary className="text-caption">{t(($) => $.workflow.version, { number: version.version_number })} · {decisionLabel(version.decision)}{version.published_at ? ` · ${t(($) => $.workflow.published)}` : ""}</summary>
        <div className="mt-3 space-y-2"><WorkflowIssueLink issue={version.review_issue} />
          <div className="min-w-0 max-w-full overflow-x-auto break-words"><Markdown mode="full">{version.content}</Markdown></div>
          {version.feedback && <p className="whitespace-pre-wrap break-words text-caption text-muted-foreground">{version.feedback}</p>}</div>
      </details>)}
    </section>}
    {workflow.reviewer_handoffs.length > 0 && <section className="space-y-3" aria-label={t(($) => $.workflow.handoff_history)}>
      <h3 className="text-title-sm font-medium">{t(($) => $.workflow.handoff_history)}</h3>
      {[...workflow.reviewer_handoffs].sort((a, b) => b.revision - a.revision).map((handoff) => {
        const version = workflow.versions.find((entry) => entry.id === handoff.version_id);
        const date = new Date(handoff.created_at);
        return <article key={handoff.id} className="space-y-2 rounded-md border border-border p-3">
          <p className="break-words text-caption font-medium">{t(($) => $.workflow.handoff_people, {
            from: handoff.from_reviewer_name?.trim() || memberName(handoff.from_reviewer_id),
            to: handoff.to_reviewer_name?.trim() || memberName(handoff.to_reviewer_id),
          })}</p>
          <p className="text-caption text-muted-foreground">{t(($) => $.workflow.handoff_by, { name: handoff.created_by_name?.trim() || memberName(handoff.created_by) })}{" · "}
            <time dateTime={handoff.created_at}>{Number.isNaN(date.getTime()) ? handoff.created_at : date.toLocaleString(locale)}</time></p>
          <p className="text-caption text-muted-foreground">{version ? t(($) => $.workflow.handoff_history_version, { number: version.version_number }) : t(($) => $.workflow.handoff_history_future)}</p>
          <p className="whitespace-pre-wrap break-words text-body">{handoff.reason}</p>
          {handoff.from_review_issue && <div className="space-y-1"><p className="text-caption text-muted-foreground">{t(($) => $.workflow.handoff_previous_issue)}</p><WorkflowIssueLink issue={handoff.from_review_issue} /></div>}
          {handoff.to_review_issue && <div className="space-y-1"><p className="text-caption text-muted-foreground">{t(($) => $.workflow.handoff_replacement_issue)}</p><WorkflowIssueLink issue={handoff.to_review_issue} /></div>}
        </article>;
      })}
    </section>}
  </div>;
}
