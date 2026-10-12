"use client";

import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import { issueDetailOptions } from "@multica/core/issues/queries";
import {
  acknowledgeCockpitMinutesSubmission, cockpitContextOptions, cockpitSelectedMemberOptions, CockpitUnconfirmedWriteError, cockpitWorkflowSummaryActions, cockpitHistoryViewKey, useCockpitHistoryViewStore,
  EMPTY_COCKPIT_MINUTES_DRAFT, prepareCockpitMinutesSubmission, rejectCockpitMinutesSubmission,
  setCockpitMinutesDraftContent, useCockpitMinutesDraftStore,
  useEnableCockpitMeetingWorkflow, useUpdateCockpitMeetingReadiness,
  useReleaseCockpitMeetingWorkflow, useSubmitCockpitMinutesVersion,
  useBindCockpitMinutesIssue, useUnbindCockpitMinutesIssue, useFocusCockpitMinutesIssue,
  useReviewCockpitMinutesVersion, usePublishCockpitMinutesVersion, useCockpitAssigneeAvailability,
} from "@multica/core/cockpit";
import type {
  CockpitMeetingWorkflowSummary, CockpitMeetingWorkflowSetup, CockpitMeetingIssueLink,
  CockpitMinutesDecision, IssueAssigneeType,
} from "@multica/core/types";
import type { CockpitMember } from "./cockpit-people";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { useWorkspacePaths } from "@multica/core/paths";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { CockpitAssigneePicker } from "./cockpit-assignee-picker";
import { CockpitReviewerSelect } from "./cockpit-reviewer-select";
import { CockpitScopePicker } from "./cockpit-scope-control";
import { CockpitReviewerHandoffControl } from "./cockpit-reviewer-handoff";
import { CockpitMinutesNasCopies, CockpitMinutesPublishControl } from "./cockpit-minutes-nas";
import { CockpitMinutesReader, useMinutesDecisionLabel } from "./cockpit-minutes-reader";
import { CockpitMeetingHistory } from "./cockpit-meeting-history";
import { WorkflowIssueLink } from "./cockpit-workflow-issue-link";
import { CockpitMeetingActions } from "./cockpit-meeting-actions";
import { CockpitFlowError, CockpitIssueChoice } from "./cockpit-task-flow";
import { createSafeId } from "@multica/core/utils";

const NEW_ISSUE = "__new_minutes_issue__";
const ADOPT_ISSUE = "__adopt_minutes_issue__";


export function CockpitMeetingWorkflowPanel({
  wsId, meetingId, currentUserId, members, issueLinks, workflow,
  loading, loadError, onReload, resourcesHref, agendaHref, defaultPlacement, defaultAssigneeType, defaultAssigneeId, readOnly,
}: {
  wsId: string;
  meetingId: string;
  currentUserId: string;
  members: CockpitMember[];
  issueLinks: CockpitMeetingIssueLink[];
  workflow: CockpitMeetingWorkflowSummary | null | undefined;
  loading: boolean;
  loadError: boolean;
  onReload: () => void;
  resourcesHref: string;
  agendaHref?: string;
  defaultPlacement: { project_id: string | null; module_id: string | null; node_id: string | null };
  defaultAssigneeType: string | null;
  defaultAssigneeId: string | null;
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
  const [reviewerId, setReviewerId] = useState(currentUserId);
  const [projectId, setProjectId] = useState(defaultPlacement.project_id || "");
  const [moduleId, setModuleId] = useState(defaultPlacement.module_id || "");
  const [existingIssueId, setExistingIssueId] = useState(NEW_ISSUE);
  const [adoptedIssueId, setAdoptedIssueId] = useState("");
  const [assigneeType, setAssigneeType] = useState<IssueAssigneeType | null>((defaultAssigneeType || "member") as IssueAssigneeType);
  const [assigneeId, setAssigneeId] = useState(defaultAssigneeId || currentUserId);
  const [error, setError] = useState("");
  const commandLock = useRef(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const placementQuery = useQuery({ ...cockpitContextOptions(wsId, { projectId: projectId || null, moduleId: moduleId || null }),
    enabled: Boolean(workflow && !workflow.enabled && wsId && projectId && existingIssueId === NEW_ISSUE) });
  const placementConfirmed = Boolean(projectId && moduleId && !placementQuery.isError && !placementQuery.isFetching
    && placementQuery.data?.scope.project_id === projectId && placementQuery.data.scope.module_id === moduleId);
  const setupMember = useQuery(cockpitSelectedMemberOptions(wsId, workflow?.enabled === false ? reviewerId : ""));
  const futureMember = useQuery(cockpitSelectedMemberOptions(wsId, workflow?.enabled ? workflow.reviewer_id ?? "" : ""));
  const currentMember = useQuery(cockpitSelectedMemberOptions(wsId, workflow?.enabled ? workflow.current_version?.reviewer_id ?? "" : ""));
  const setupReviewerConfirmed = !setupMember.isError && !setupMember.isFetching && Boolean(setupMember.data?.items.some((entry) => entry.id === reviewerId));
  const futureReviewerConfirmed = !futureMember.isError && !futureMember.isFetching && Boolean(futureMember.data?.items.some((entry) => entry.id === workflow?.reviewer_id));
  const currentReviewerConfirmed = !currentMember.isError && !currentMember.isFetching && Boolean(currentMember.data?.items.some((entry) => entry.id === workflow?.current_version?.reviewer_id));
  const executor = useCockpitAssigneeAvailability(wsId, workflow?.enabled === false && existingIssueId === NEW_ISSUE ? assigneeType : null, workflow?.enabled === false && existingIssueId === NEW_ISSUE ? assigneeId : null);
  const minutesExecutor = useCockpitAssigneeAvailability(wsId, workflow?.enabled && !workflow.released_at ? workflow.minutes_issue?.assignee_type ?? null : null, workflow?.enabled && !workflow.released_at ? workflow.minutes_issue?.assignee_id ?? null : null);
  const adopted = useQuery({ ...issueDetailOptions(wsId, adoptedIssueId), enabled: Boolean(workflow?.enabled === false && existingIssueId === ADOPT_ISSUE && adoptedIssueId) });
  const adoptedIssue = adopted.data?.id === adoptedIssueId && adopted.data.workspace_id === wsId ? adopted.data : null;
  const adoptionConfirmed = !adopted.isError && !adopted.isFetching && adoptedIssue?.status === "backlog";
  const enable = useEnableCockpitMeetingWorkflow(wsId);
  const [bindIssueId, setBindIssueId] = useState("");
  const bindIssue = useQuery({ ...issueDetailOptions(wsId, bindIssueId), enabled: bindIssueId !== "" }).data ?? null;
  const readiness = useUpdateCockpitMeetingReadiness(wsId);
  const release = useReleaseCockpitMeetingWorkflow(wsId);
  const submit = useSubmitCockpitMinutesVersion(wsId);
  const bind = useBindCockpitMinutesIssue(wsId);
  const unbind = useUnbindCockpitMinutesIssue(wsId);
  const focus = useFocusCockpitMinutesIssue(wsId);
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
    <AppLink href={resourcesHref} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.meeting_materials.prepare)}</AppLink>
  </div>;

  if (!workflow.enabled) {
    const setup = async () => {
      if (!setupReviewerConfirmed || (existingIssueId === NEW_ISSUE ? !placementConfirmed || !executor.available : !adoptionConfirmed)) return;
      const body: CockpitMeetingWorkflowSetup = { reviewer_id: reviewerId };
      if (existingIssueId === ADOPT_ISSUE) body.existing_issue_id = adoptedIssueId;
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
          <CockpitScopePicker wsId={wsId} kind="project" projectId={null} selectedId={projectId || null} selectedTitle={placementQuery.data?.scope.project_title ?? ""}
            label={t(($) => $.binding.project)} emptyLabel={t(($) => $.binding.choose_project)} disabled={commandBusy}
            emptyAction={<AppLink href={paths.projects()} target="_blank" rel="noreferrer" className="text-primary underline">{t(($) => $.task_recovery.open_projects)}</AppLink>}
            onSelect={(value) => { setProjectId(value || ""); setModuleId(""); }} />
          <CockpitScopePicker wsId={wsId} kind="module" projectId={projectId || null} selectedId={moduleId || null} selectedTitle={placementQuery.data?.scope.module_title ?? ""}
            label={t(($) => $.binding.module)} emptyLabel={t(($) => $.binding.choose_module)} disabled={commandBusy || !projectId}
            emptyAction={projectId ? <AppLink href={paths.projectDetail(projectId)} target="_blank" rel="noreferrer" className="text-primary underline">{t(($) => $.task_recovery.open_project)}</AppLink> : undefined}
            onSelect={(value) => setModuleId(value || "")} />
          </>}
          <CockpitReviewerSelect wsId={wsId} value={reviewerId} onChange={setReviewerId} disabled={commandBusy} />
          <div className="space-y-1"><label htmlFor={`${id}-existing`} className="text-caption">{t(($) => $.workflow.existing_issue)}</label>
            <Select value={existingIssueId} disabled={commandBusy} onValueChange={(value) => setExistingIssueId(value || NEW_ISSUE)}
              items={[{ value: NEW_ISSUE, label: t(($) => $.workflow.new_issue) }, { value: ADOPT_ISSUE, label: t(($) => $.workflow.adopt_existing) }]}>
              <SelectTrigger id={`${id}-existing`} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NEW_ISSUE}>{t(($) => $.workflow.new_issue)}</SelectItem><SelectItem value={ADOPT_ISSUE}>{t(($) => $.workflow.adopt_existing)}</SelectItem></SelectContent>
            </Select>
          </div>
        </div>
        {existingIssueId === ADOPT_ISSUE && <div className="space-y-2">
          <CockpitIssueChoice wsId={wsId} selected={adoptedIssue} onSelect={(issue) => setAdoptedIssueId(issue.id)} disabled={commandBusy} />
          {adoptedIssueId && (adopted.isError || (!adopted.isPending && !adoptedIssue)) && <CockpitFlowError onRetry={() => void adopted.refetch()} />}
          {adoptedIssue && adoptedIssue.status !== "backlog" && <p role="alert" className="text-caption text-destructive">{t(($) => $.workflow.adopt_hint)}</p>}
        </div>}
        {existingIssueId === NEW_ISSUE ? <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption">{t(($) => $.workflow.writer)}</span>
          <CockpitAssigneePicker wsId={wsId} assigneeType={assigneeType} assigneeId={assigneeId || null}
            open={commandBusy ? false : undefined}
            triggerRender={<Button type="button" variant="outline" size="sm" disabled={commandBusy} />}
            onUpdate={(update) => {
            if (commandBusy) return;
            setAssigneeType(update.assignee_type ?? "member"); setAssigneeId(update.assignee_id ?? currentUserId);
          }} />
        </div> : <p className="text-caption text-muted-foreground">{t(($) => $.workflow.adopt_hint)}</p>}
        {issueLinks.length > 0 && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.legacy_hint)}</p>}
        {existingIssueId === NEW_ISSUE && (placementQuery.isError || (placementQuery.isSuccess && !placementQuery.data)) && <div role="alert" className="space-y-2 text-caption text-destructive">
          <p>{t(($) => $.workflow.placement_failed)}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void placementQuery.refetch()}>{t(($) => $.binding.retry)}</Button>
        </div>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <Button type="button" size="sm" disabled={commandBusy || loadError || !currentUserId || !reviewerId || !setupReviewerConfirmed
          || (existingIssueId === NEW_ISSUE ? !placementConfirmed || !executor.available : !adoptionConfirmed)}
          aria-busy={commandBusy} onClick={() => void runCommand(setup)}>{commandBusy && <Spinner />}{t(($) => $.workflow.enable)}</Button>
      </>}
    </section>;
  }

  const actions = cockpitWorkflowSummaryActions(workflow, currentUserId);
  const retryRelease = release.isError && release.variables?.meetingId === meetingId
    && !(release.error instanceof ApiError && [400,403,404,409,422].includes(release.error.status)) ? release.variables : null;
  const canRelease = Boolean(retryRelease) || (actions.canRelease && minutesExecutor.available);
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
    {(pendingReviewerMissing || reviewerMissing) && <div role="status" className="space-y-1 rounded-md bg-warning-subtle p-3 text-caption text-foreground">
      <p>{pendingReviewerMissing ? t(($) => $.workflow.current_reviewer_unavailable) : t(($) => $.workflow.reviewer_unavailable)}</p>
      <p>{actions.canReassignReviewer && !readOnly ? t(($) => $.workflow.handoff_recovery) : t(($) => $.workflow.handoff_manager_only)}</p>
    </div>}
    <div className="space-y-2">
      {memberReadUnconfirmed && (memberQuery.isError || (memberQuery.isSuccess && !memberQuery.data)
        ? <CockpitFlowError onRetry={() => void memberQuery.refetch()} />
        : <div role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><Spinner />{t(($) => $.workflow.loading)}</div>)}
      {current?.decision !== "pending" && <p className="break-words text-caption text-muted-foreground">{t(($) => $.workflow.future_reviewer, { name: reviewerName })}</p>}
      <CockpitReviewerHandoffControl wsId={wsId} workflow={workflow} members={members}
        canTransfer={actions.canReassignReviewer && !readOnly} disabled={commandBusy || loadError} onReload={onReload} />
    </div>
    {loadError && <div role="alert" className="space-y-2 text-caption text-destructive">
      <p>{t(($) => $.workflow.refresh_failed)}</p>
      <Button type="button" variant="outline" size="sm" onClick={onReload}>{t(($) => $.binding.retry)}</Button>
    </div>}
    {workflow.minutes_issues.length > 0 && <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t(($) => $.workflow.bindings_title)}>
      <h3 className="text-title-sm font-medium">{t(($) => $.workflow.bindings_title)}</h3>
      <ul className="space-y-2">
        {workflow.minutes_issues.map((binding) => (
          <li key={binding.issue?.id ?? "binding-unknown"} className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex min-w-0 flex-wrap items-center gap-2 text-caption">
              {binding.is_focus && <span className="rounded bg-secondary px-1.5 py-0.5 text-caption-xs text-secondary-foreground">{t(($) => $.workflow.focus_badge)}</span>}
              {binding.issue
                ? <AppLink href={paths.issueDetail(binding.issue.id)} className="truncate text-primary underline">{binding.issue.identifier} {binding.issue.title}</AppLink>
                : <span className="text-muted-foreground">{t(($) => $.workflow.binding_missing)}</span>}
              {binding.issue && <span className="text-muted-foreground">{binding.issue.status}</span>}
            </span>
            {!readOnly && actions.canManage && binding.issue && <span className="flex items-center gap-1">
              {!binding.is_focus && <Button type="button" variant="outline" size="xs" disabled={commandBusy}
                onClick={() => void runCommand(() => focus.mutateAsync({ meetingId, issueId: binding.issue!.id, revision: workflow.revision }))}>
                {t(($) => $.workflow.set_focus)}</Button>}
              <Button type="button" variant="ghost" size="xs" disabled={commandBusy}
                onClick={() => void runCommand(() => unbind.mutateAsync({ meetingId, issueId: binding.issue!.id, revision: workflow.revision }))}>
                {t(($) => $.workflow.unbind)}</Button>
            </span>}
          </li>
        ))}
      </ul>
      {!readOnly && actions.canManage && <div className="space-y-2">
        <CockpitIssueChoice wsId={wsId} selected={bindIssue} onSelect={(issue) => setBindIssueId(issue.id)} disabled={commandBusy} />
        {bindIssueId && <Button type="button" variant="outline" size="sm" disabled={commandBusy}
          onClick={() => void runCommand(async () => { await bind.mutateAsync({ meetingId, issueId: bindIssueId, revision: workflow.revision }); setBindIssueId(""); })}>
          {t(($) => $.workflow.bind_issue)}</Button>}
      </div>}
    </section>}
    <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t(($) => $.workflow.readiness)}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-title-sm font-medium">{t(($) => $.workflow.readiness)}</h3>
        <span className="text-caption text-muted-foreground">{workflow.released_at ? t(($) => $.workflow.released) : t(($) => $.workflow.awaiting_release)}</span></div>
      <div className="space-y-2 rounded-md bg-muted/40 p-3">
        <AppLink href={resourcesHref} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>{t(($) => $.meeting_materials.prepare)}</AppLink>
        {workflow.minutes_issue && <div><AppLink href={paths.issueDetail(workflow.minutes_issue.id)} target="_blank" rel="noreferrer" className="text-caption text-primary underline">{t(($) => $.meeting_materials.open_issue)}</AppLink></div>}
        <p className="text-caption text-muted-foreground">{t(($) => $.meeting_materials.confirm_hint)}</p>
      </div>
      {agendaHref ? <div className="space-y-2"><p className="text-caption">{workflow.ended_at ? t(($) => $.workflow.ended) : t(($) => $.workflow.need_ended)} · {workflow.materials_ready ? t(($) => $.workflow.materials_ready) : t(($) => $.workflow.need_materials)}</p>
        <AppLink href={agendaHref} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.meeting_lifecycle.title)}</AppLink>
      </div> : <>
      <div className="flex flex-wrap items-center gap-3">
        {workflow.ended_at ? <span className="text-caption">{t(($) => $.workflow.ended)}</span>
          : <Button type="button" size="sm" variant="outline" disabled={readOnly || !actions.canManage || commandBusy}
            onClick={() => void runCommand(() => readiness.mutateAsync({ meetingId, body: { expected_revision: workflow.revision, ended: true } }))}>
            {t(($) => $.workflow.mark_ended)}</Button>}
        <label className="flex items-center gap-2 text-caption"><Checkbox checked={workflow.materials_ready}
          disabled={readOnly || !actions.canManage || commandBusy}
          onCheckedChange={(checked) => void runCommand(() => readiness.mutateAsync({ meetingId, body: { expected_revision: workflow.revision, materials_ready: checked === true } }))} />
          {t(($) => $.workflow.materials_ready)}</label>
      </div>
      </>}
      {!workflow.released_at && !actions.canManage && <p className="text-caption text-muted-foreground">{t(($) => $.workflow.manager_required)}</p>}
      {!workflow.released_at && <>
        <ul className="space-y-1 text-caption text-muted-foreground">
          {!workflow.ended_at && <li>{t(($) => $.workflow.need_ended)}</li>}
          {!workflow.materials_ready && <li>{t(($) => $.workflow.need_materials)}</li>}
          {!actions.hasExecutor && <li>{t(($) => $.workflow.executor_required)}{" "}{workflow.minutes_issue && <AppLink href={paths.issueDetail(workflow.minutes_issue.id)} target="_blank" rel="noreferrer" className="text-primary underline">{t(($) => $.workflow.assign_executor)}</AppLink>}</li>}
          {workflow.minutes_issue?.status !== "backlog" && <li>{t(($) => $.workflow.need_backlog)}{" "}{workflow.minutes_issue && <AppLink href={paths.issueDetail(workflow.minutes_issue.id)} target="_blank" rel="noreferrer" className="text-primary underline">{t(($) => $.workflow.fix_issue_status)}</AppLink>}</li>}
          {actions.hasExecutor && !minutesExecutor.available && !retryRelease && <li>
            {minutesExecutor.isPending ? t(($) => $.workflow.executor_checking) : t(($) => $.workflow.executor_unavailable)}{" "}
            {workflow.minutes_issue && <AppLink href={paths.issueDetail(workflow.minutes_issue.id)} target="_blank" rel="noreferrer" className="text-primary underline">{t(($) => $.workflow.assign_executor)}</AppLink>}
            {minutesExecutor.isError && <Button type="button" variant="ghost" size="xs" onClick={() => void minutesExecutor.refetch()}>{t(($) => $.binding.retry)}</Button>}
          </li>}
          {actions.canRelease && minutesExecutor.available && !retryRelease && <li>{t(($) => $.workflow.ready_hint)}</li>}
        </ul>
        <Button type="button" size="sm" disabled={readOnly || !canRelease || commandBusy} aria-busy={release.isPending}
          onClick={() => { if (!readOnly && canRelease && !commandBusy) void runCommand(() => release.mutateAsync(retryRelease ?? { meetingId, revision: workflow.revision })); }}>
          {release.isPending && <Spinner />}{retryRelease ? t(($) => $.workflow.retry_release) : t(($) => $.workflow.release)}</Button>
      </>}
      <div className="space-y-1"><p className="text-caption font-medium">{t(($) => $.workflow.minutes_issue)}</p>
        {workflow.minutes_issue && <WorkflowIssueLink wsId={wsId} issue={workflow.minutes_issue} newTab />}</div>
    </section>
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
        resourcesHref={resourcesHref}
        disabled={Boolean(readOnly || !actions.canPublish || commandBusy)} pending={publish.isPending}
        onPublish={(nasExport) => void runCommand(() => publish.mutateAsync({ meetingId, versionId: current.id, revision: workflow.revision, nasExport }))} />}
    </section>}
    {workflow.published_version && workflow.published_version.id !== current?.id && <section className="space-y-3 rounded-lg border border-brand/20 bg-brand/5 p-4" aria-label={t(($) => $.minutes_history.official)}>
      <h3 className="text-title-sm font-medium">{t(($) => $.minutes_history.official)} · {t(($) => $.workflow.version, { number: workflow.published_version.version_number })}</h3>
      <DialogTrigger render={<Button type="button" size="sm" variant="outline" onClick={() => { if (workflow.published_version) setReader({ id: workflow.published_version.id, number: workflow.published_version.version_number, reviewIssueId: workflow.published_version.review_issue.id, reviewerId: workflow.published_version.reviewer_id }); }} />}>
        {t(($) => $.minutes_history.read_published)}</DialogTrigger>
    </section>}
    <CockpitMinutesNasCopies wsId={wsId} workflow={workflow} userId={currentUserId} readOnly={readOnly} resourcesHref={resourcesHref}
      disabled={commandBusy || loadError} onReload={onReload} onOpenHistory={() => {
        useCockpitHistoryViewStore.getState().update(cockpitHistoryViewKey(wsId, meetingId), { section: "exports" }); setHistoryOpen(true);
        requestAnimationFrame(() => historyElement.current?.scrollIntoView?.({ block: "start" }));
      }} />
    {workflow.published_version_id && <CockpitMeetingActions wsId={wsId} workflow={workflow} userId={currentUserId} readOnly={readOnly} />}
    {workflow.released_at && !readOnly && (actions.canSubmit || draft.pending) && <section className="space-y-3 rounded-lg border border-border p-4">
      <label htmlFor={`${id}-draft`} className="block text-title-sm font-medium">{t(($) => $.workflow.draft)}</label>
      <Textarea id={`${id}-draft`} value={draft.content} rows={8} disabled={commandBusy || Boolean(draft.pending)}
        onChange={(event) => setCockpitMinutesDraftContent(meetingId, event.target.value)} />
      <p className="text-caption text-muted-foreground">{draft.pending ? t(($) => $.workflow.submission_pending) : t(($) => $.workflow.draft_hint)}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={commandBusy || !draft.content.trim() || (!actions.canSubmit && !draft.pending) || (!futureReviewerConfirmed && !draft.pending)} aria-busy={submit.isPending}
          onClick={() => void runCommand(submitVersion, true)}>{submit.isPending && <Spinner />}{draft.pending ? t(($) => $.workflow.retry_submission) : t(($) => $.workflow.submit_version)}</Button>
        {draft.pending && <Button type="button" size="sm" variant="outline" disabled={commandBusy} onClick={onReload}>{t(($) => $.workflow.refresh_status)}</Button>}
      </div>
    </section>}
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
