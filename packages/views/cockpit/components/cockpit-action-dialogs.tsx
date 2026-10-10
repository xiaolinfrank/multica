"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import { issueDetailOptions } from "@multica/core/issues/queries";
import { useWorkspacePaths } from "@multica/core/paths";
import {
  clearCockpitActionCommand, cockpitMeetingActionOptions, cockpitPrimaryNodeOptions, cockpitMinutesVersionOptions, rememberCockpitActionCommand,
  useCockpitActionCommandStore, useCreateCockpitMeetingAction, useResolveCockpitMeetingAction, useUpdateCockpitMeetingAction, CockpitUnconfirmedWriteError,
  cockpitActionFormKey, clearCockpitActionFormDraft, saveCockpitActionFormDraft, useCockpitActionFormDraftStore, cockpitScope, cockpitSurfacePath, cockpitObjectPath,
  type CockpitActionProposalDraft, type CockpitActionDecisionDraft, useCockpitAssigneeAvailability,
} from "@multica/core/cockpit";
import type { CockpitActionResolution, CockpitMeetingAction, CockpitMeetingWorkflowSummary, CockpitMinutesVersion } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Markdown } from "@multica/ui/markdown";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { useT } from "../../i18n";
import { AppLink, useNavigation } from "../../navigation";
import { CockpitFlowError, CockpitIssueChoice, CockpitTaskRows } from "./cockpit-task-flow";
import { CockpitNodeIssuePicker, useCockpitSelectedNodeIssueOption } from "./cockpit-node-issue-picker";
import { CockpitTaskFields, cockpitTaskFieldsBody, cockpitTaskFieldsValue } from "./cockpit-task-fields";

function SourceMinutes({ version, quote }: { version: CockpitMinutesVersion | undefined; quote: string }) {
  const { t } = useT("cockpit");
  return <section className="space-y-2 rounded-md bg-muted/40 p-3" aria-label={t(($) => $.meeting_actions.source)}>
    <p className="text-caption font-medium">{version ? t(($) => $.meeting_actions.source_version, { number: version.version_number }) : t(($) => $.meeting_actions.source_unavailable)}</p>
    {quote && <blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-body">{quote}</blockquote>}
    {version && <details><summary className="cursor-pointer text-caption text-muted-foreground">{t(($) => $.meeting_actions.read_source)}</summary>
      <div className="mt-2 max-h-60 min-w-0 overflow-auto break-words"><Markdown mode="full">{version.content}</Markdown></div></details>}
  </section>;
}

function ActionRepairLink({ href, children }: { href: string; children: React.ReactNode }) {
  const { t } = useT("cockpit");
  return <AppLink href={href} target="_blank" rel="noopener noreferrer" className="text-caption text-primary hover:underline">
    {children} <span className="text-muted-foreground">{t(($) => $.action_flow.new_tab)}</span>
  </AppLink>;
}

export function CockpitActionCreate({ wsId, workflow, disabled }: { wsId: string; workflow: CockpitMeetingWorkflowSummary; disabled: boolean }) {
  const { t } = useT("cockpit");
  const scope = `meeting:${workflow.meeting_id}:proposal`;
  const stored = useCockpitActionCommandStore((state) => state.draft.commands[scope]);
  const pending = stored?.kind === "proposal" ? stored : undefined;
  const formKey = cockpitActionFormKey(wsId, "proposal", workflow.meeting_id);
  const create = useCreateCockpitMeetingAction(wsId);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<CockpitActionProposalDraft>({ kind: "proposal", versionId: "", title: "", description: "", sourceQuote: "" });
  const { versionId, title, description, sourceQuote: quote } = form;
  const changeForm = (patch: Partial<CockpitActionProposalDraft>) => {
    const next = { ...form, ...patch }; setForm(next); saveCockpitActionFormDraft(formKey, next);
  };
  const [error, setError] = useState("");
  const lock = useRef(false);
  const source = useQuery({ ...cockpitMinutesVersionOptions(wsId, workflow.meeting_id, pending?.version_id ?? versionId), enabled: open && Boolean(pending?.version_id ?? versionId) });
  const version = source.data?.version;
  const sourceQuote = quote.trim() ? quote : "";
  const quoteInvalid = Boolean(sourceQuote && !version?.content.includes(sourceQuote));
  const stale = !pending && versionId !== workflow.published_version_id;
  async function save() {
    if (lock.current || disabled || stale || quoteInvalid || !version || source.isFetching || source.isError) return;
    lock.current = true; setError("");
    const command = pending ?? { kind: "proposal" as const, meeting_id: workflow.meeting_id, version_id: versionId,
      body: { proposal_key: crypto.randomUUID(), title: title.trim(), description: description.trim(), source_quote: sourceQuote } };
    rememberCockpitActionCommand(scope, command);
    try { await create.mutateAsync({ meetingId: command.meeting_id, versionId: command.version_id, body: command.body }); clearCockpitActionCommand(scope); clearCockpitActionFormDraft(formKey); setOpen(false); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) clearCockpitActionCommand(scope);
      setError(cause instanceof CockpitUnconfirmedWriteError ? t(($) => $.task_flow.unconfirmed) : cause instanceof Error ? cause.message : t(($) => $.errors.save_failed));
    } finally { lock.current = false; }
  }
  return <Dialog open={open} onOpenChange={(next) => {
    if (lock.current) return; setOpen(next);
    if (next) {
      const draft = useCockpitActionFormDraftStore.getState().draft.forms[formKey];
      setForm(pending ? { kind: "proposal", versionId: pending.version_id, title: pending.body.title, description: pending.body.description, sourceQuote: pending.body.source_quote }
        : draft?.kind === "proposal" ? draft : { kind: "proposal", versionId: workflow.published_version_id ?? "", title: "", description: "", sourceQuote: "" });
      setError("");
    }
  }}>
    <DialogTrigger render={<Button type="button" size="sm" disabled={disabled} />}>{pending ? t(($) => $.meeting_actions.retry_suggestion) : t(($) => $.meeting_actions.add)}</DialogTrigger>
    <DialogContent className="sm:max-w-xl" showCloseButton={!create.isPending}><DialogHeader><DialogTitle>{t(($) => $.meeting_actions.add)}</DialogTitle>
      <DialogDescription>{t(($) => $.meeting_actions.add_hint)}</DialogDescription></DialogHeader>
      {source.isPending ? <Spinner /> : source.isError || !version ? <CockpitFlowError onRetry={() => void source.refetch()} /> : <SourceMinutes version={version} quote="" />}
      <label className="space-y-1 text-caption">{t(($) => $.meeting_actions.title)}<Input value={title} disabled={create.isPending || Boolean(pending)} onChange={(event) => changeForm({ title: event.target.value })} /></label>
      <label className="space-y-1 text-caption">{t(($) => $.meeting_actions.description)}<Textarea value={description} rows={3} disabled={create.isPending || Boolean(pending)} onChange={(event) => changeForm({ description: event.target.value })} /></label>
      <label className="space-y-1 text-caption">{t(($) => $.meeting_actions.quote)}<Textarea value={quote} rows={3} disabled={create.isPending || Boolean(pending)} onChange={(event) => changeForm({ sourceQuote: event.target.value })} /></label>
      {quoteInvalid && <p role="alert" className="text-caption text-destructive">{t(($) => $.meeting_actions.invalid_quote)}</p>}
      {stale && <div className="space-y-2"><p role="alert" className="text-caption text-destructive">{t(($) => $.meeting_actions.source_changed)}</p>
        <Button type="button" variant="outline" size="sm" disabled={disabled || !workflow.published_version_id} onClick={() => changeForm({ versionId: workflow.published_version_id ?? "" })}>{t(($) => $.action_flow.use_current_source)}</Button></div>}
      {pending && <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.pending_request)}</p>}
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <DialogFooter><DialogClose render={<Button type="button" variant="outline" disabled={create.isPending} />}>{t(($) => $.binding.cancel)}</DialogClose>
        <Button type="button" disabled={disabled || create.isPending || !title.trim() || stale || quoteInvalid || !version || source.isFetching || source.isError} aria-busy={create.isPending} onClick={() => void save()}>
          {create.isPending && <Spinner />}{pending ? t(($) => $.meeting_actions.retry_suggestion) : t(($) => $.meeting_actions.save)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function CockpitActionDetail({ wsId, workflow, actionId, userId, readOnly, onDone, onBusyChange }: {
  wsId: string; workflow: CockpitMeetingWorkflowSummary; actionId: string; userId: string; readOnly?: boolean; onDone: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const { t } = useT("cockpit");
  const query = useQuery(cockpitMeetingActionOptions(wsId, workflow.meeting_id, actionId));
  const [busy, setBusy] = useState(false);
  return <DialogContent className="sm:max-w-2xl" showCloseButton={!busy}><DialogHeader><DialogTitle>{t(($) => $.meeting_actions.confirm)}</DialogTitle>
    <DialogDescription>{t(($) => $.meeting_actions.confirm_hint)}</DialogDescription></DialogHeader>
    {query.isPending ? <Spinner /> : query.isError || !query.data ? <CockpitFlowError onRetry={() => void query.refetch()} />
      : <ActionForm key={actionId} wsId={wsId} workflow={workflow} action={query.data} userId={userId} readOnly={readOnly} onDone={onDone}
        onBusyChange={(value) => { setBusy(value); onBusyChange(value); }} refreshing={query.isFetching} />}
    <DialogFooter><DialogClose render={<Button type="button" variant="outline" disabled={busy} />}>{t(($) => $.binding.cancel)}</DialogClose></DialogFooter>
  </DialogContent>;
}

function ActionForm({ wsId, workflow, action, userId, readOnly, onDone, onBusyChange, refreshing }: {
  wsId: string; workflow: CockpitMeetingWorkflowSummary; action: CockpitMeetingAction; userId: string; readOnly?: boolean; onDone: () => void; onBusyChange: (busy: boolean) => void; refreshing: boolean;
}) {
  const { t } = useT("cockpit");
  const scope = `action:${action.id}`;
  const saved = useCockpitActionCommandStore((state) => state.draft.commands[scope]);
  const pending = saved?.kind === "decision" ? saved : undefined;
  const source = useQuery(cockpitMinutesVersionOptions(wsId, workflow.meeting_id, action.version_id));
  const version = source.data?.version;
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const routeScope = cockpitScope(navigation.searchParams);
  const formKey = cockpitActionFormKey(wsId, "decision", action.id);
  const newForm = (): CockpitActionDecisionDraft => ({ kind: "decision", versionId: action.version_id, sourceHash: action.source_content_hash,
    revision: action.revision, editing: false, title: action.title, description: action.description, sourceQuote: action.source_quote,
    outcome: action.source_superseded ? "dismiss" : "create", nodeId: "", issueId: "", reason: "", fields: cockpitTaskFieldsValue(userId) });
  const [form, setForm] = useState<CockpitActionDecisionDraft>(() => {
    const draft = useCockpitActionFormDraftStore.getState().draft.forms[formKey];
    const base = draft?.kind === "decision" ? draft : newForm();
    return pending ? { ...base, editing: false, outcome: pending.body.outcome, nodeId: pending.body.node_id ?? "", issueId: pending.body.issue_id ?? "",
      reason: pending.body.reason ?? "", fields: cockpitTaskFieldsValue(userId, pending.body) } : base;
  });
  const changeForm = (patch: Partial<CockpitActionDecisionDraft>) => {
    const next = { ...form, ...patch }; setForm(next); saveCockpitActionFormDraft(formKey, next);
  };
  const { revision: observedRevision, editing, title, description, sourceQuote: quote, outcome, fields, reason } = form;
  const executor = useCockpitAssigneeAvailability(wsId, outcome === "create" && !pending ? fields.assigneeType : null, outcome === "create" && !pending ? fields.assigneeId : null);
  const nodeQuery = useCockpitSelectedNodeIssueOption(outcome === "dismiss" ? "" : pending?.body.node_id ?? form.nodeId);
  const node = nodeQuery.option;
  const selectedQuery = useQuery({ ...issueDetailOptions(wsId, form.issueId), enabled: outcome === "reuse" && !pending && Boolean(form.issueId) });
  const selected = selectedQuery.data?.id === form.issueId && selectedQuery.data.workspace_id === wsId ? selectedQuery.data : null;
  const primary = useQuery(cockpitPrimaryNodeOptions(wsId, outcome === "reuse" && !pending ? form.issueId : ""));
  const [error, setError] = useState("");
  const lock = useRef(false);
  const resolve = useResolveCockpitMeetingAction(wsId);
  const update = useUpdateCockpitMeetingAction(wsId);
  const busy = resolve.isPending || update.isPending;
  const stale = !pending && (action.revision !== observedRevision || action.version_id !== form.versionId || action.source_content_hash !== form.sourceHash);
  const authorized = Boolean(userId && !readOnly && (workflow.can_manage || version?.reviewer_id === userId));
  const oldSource = action.source_superseded || workflow.published_version_id !== action.version_id
    || !version?.published_at || version.decision !== "approved" || version.content_hash !== action.source_content_hash;
  const canEdit = authorized && action.status === "draft" && action.can_edit && !oldSource;
  const selectedNode = node;
  const scopeMatches = Boolean(node && selected && primary.data?.issue_id === selected.id && primary.data.project_id === node.project_id && primary.data.module_id === node.module_id);
  const reuseConflict = Boolean(node && selected && primary.data && (!scopeMatches || (primary.data.node_id && primary.data.node_id !== node.node_id)));
  const canResolve = authorized && !busy && !refreshing && !stale && (Boolean(pending) || (action.status === "draft" && action.can_resolve
    && (outcome === "dismiss" ? Boolean(reason.trim()) : !oldSource && !source.isError && !source.isFetching && Boolean(node) && !nodeQuery.isError && !nodeQuery.isFetching && !nodeQuery.isPending
      && (outcome === "create" ? executor.available : scopeMatches && primary.data?.issue_id === selected?.id && !primary.isError && !primary.isFetching && !selectedQuery.isError && !selectedQuery.isFetching && !reuseConflict))));

  useEffect(() => {
    if (pending && action.decision_key === pending.body.decision_key && action.resolution === pending.body.outcome && action.resolved_at) {
      clearCockpitActionCommand(scope); clearCockpitActionFormDraft(formKey); onDone();
    }
  }, [action, pending, scope, formKey, onDone]);

  async function confirm() {
    if (lock.current || !canResolve) return;
    lock.current = true; onBusyChange(true); setError("");
    const body: CockpitActionResolution = pending?.body ?? { expected_revision: observedRevision, decision_key: crypto.randomUUID(), outcome,
      ...(outcome === "dismiss" ? { reason: reason.trim() } : { node_id: node?.node_id,
        ...(outcome === "reuse" ? { issue_id: selected?.id } : cockpitTaskFieldsBody(fields)) }) };
    const command = pending ?? { kind: "decision" as const, meeting_id: action.meeting_id, action_id: action.id, version_id: action.version_id, source_content_hash: action.source_content_hash, body };
    rememberCockpitActionCommand(scope, command);
    try { await resolve.mutateAsync({ meetingId: command.meeting_id, action: { id: command.action_id, meeting_id: command.meeting_id, version_id: command.version_id, source_content_hash: command.source_content_hash }, body: command.body }); clearCockpitActionCommand(scope); clearCockpitActionFormDraft(formKey); onDone(); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) clearCockpitActionCommand(scope);
      setError(cause instanceof CockpitUnconfirmedWriteError ? t(($) => $.task_flow.unconfirmed) : cause instanceof Error ? cause.message : t(($) => $.errors.save_failed));
    } finally { lock.current = false; onBusyChange(false); }
  }
  return <div className="space-y-4">
    {source.isPending ? <Spinner /> : source.isError || !version ? <CockpitFlowError onRetry={() => void source.refetch()} /> : <SourceMinutes version={version} quote={action.source_quote} />}
    {!editing ? <div className="space-y-2"><h3 className="break-words text-title-sm font-medium">{action.title}</h3><p className="whitespace-pre-wrap break-words text-body">{action.description}</p>
      {canEdit && !pending && !stale && <Button type="button" variant="ghost" size="sm" onClick={() => changeForm({ editing: true })}>{t(($) => $.meeting_actions.edit)}</Button>}</div>
      : <div className="space-y-3">
        <label className="block space-y-1 text-caption">{t(($) => $.meeting_actions.title)}<Input value={title} disabled={busy} onChange={(event) => changeForm({ title: event.target.value })} /></label>
        <label className="block space-y-1 text-caption">{t(($) => $.meeting_actions.description)}<Textarea value={description} disabled={busy} onChange={(event) => changeForm({ description: event.target.value })} /></label>
        <label className="block space-y-1 text-caption">{t(($) => $.meeting_actions.quote)}<Textarea value={quote} disabled={busy} onChange={(event) => changeForm({ sourceQuote: event.target.value })} /></label>
        {quote.trim() && !version?.content.includes(quote) && <p role="alert" className="text-caption text-destructive">{t(($) => $.meeting_actions.invalid_quote)}</p>}
        {(oldSource || !action.can_edit) && <p role="status" className="text-caption text-muted-foreground">{oldSource ? t(($) => $.meeting_actions.old_source) : t(($) => $.meeting_actions.no_permission)}</p>}
        <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={busy || stale || !canEdit || !title.trim() || Boolean(quote.trim() && !version?.content.includes(quote))}
          onClick={() => { if (lock.current || !canEdit || stale) return; lock.current = true; onBusyChange(true); setError("");
            void update.mutateAsync({ meetingId: action.meeting_id, actionId: action.id, body: { expected_revision: observedRevision, title: title.trim(), description: description.trim(), source_quote: quote.trim() ? quote : "" } })
              .then(() => { clearCockpitActionFormDraft(formKey); onDone(); }).catch((cause) => setError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed))).finally(() => { lock.current = false; onBusyChange(false); }); }}>
          {update.isPending && <Spinner />}{t(($) => $.meeting_actions.save)}</Button>
          {!stale && <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => changeForm({ editing: false, title: action.title, description: action.description, sourceQuote: action.source_quote })}>{t(($) => $.action_flow.discard_edits)}</Button>}
        </div>
      </div>}
    {stale && <div className="space-y-2"><p role="alert" className="text-caption text-destructive">{t(($) => $.meeting_actions.action_changed)}</p>
      <Button type="button" size="sm" variant="outline" disabled={busy || refreshing} onClick={() => { clearCockpitActionFormDraft(formKey); setForm(newForm()); setError(""); }}>{t(($) => $.action_flow.discard_stale)}</Button></div>}
    {action.issue && <CockpitTaskRows wsId={wsId} items={[action.issue]} />}
    {action.reason && <p className="whitespace-pre-wrap break-words text-caption">{action.reason}</p>}
    {!editing && (action.status === "draft" || pending) && <>
      {oldSource && !pending && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_actions.old_source)}</p>}
      <label className="block space-y-1 text-caption">{t(($) => $.meeting_actions.outcome)}<Select value={outcome} disabled={busy || Boolean(pending) || !authorized}
        onValueChange={(value) => { if (value === "create" || value === "reuse" || value === "dismiss") changeForm({ outcome: value }); }}
        items={[{ value: "create", label: t(($) => $.meeting_actions.create) }, { value: "reuse", label: t(($) => $.meeting_actions.reuse) }, { value: "dismiss", label: t(($) => $.meeting_actions.dismiss) }]}>
        <SelectTrigger className="w-full" aria-label={t(($) => $.meeting_actions.outcome)}><SelectValue /></SelectTrigger><SelectContent>
          <SelectItem value="create" disabled={oldSource}>{t(($) => $.meeting_actions.create)}</SelectItem><SelectItem value="reuse" disabled={oldSource}>{t(($) => $.meeting_actions.reuse)}</SelectItem><SelectItem value="dismiss">{t(($) => $.meeting_actions.dismiss)}</SelectItem>
        </SelectContent></Select></label>
      {outcome !== "dismiss" && <div className="space-y-2"><p className="text-caption">{t(($) => $.meeting_actions.primary_node)}</p>
        {pending ? <p className="text-caption">{selectedNode?.label || pending.body.node_id}</p> : <CockpitNodeIssuePicker value={node} onUpdate={(value) => changeForm({ nodeId: value?.node_id ?? "" })} disabled={busy || !authorized}
          triggerRender={<Button type="button" variant="outline" size="sm" aria-label={t(($) => $.meeting_actions.primary_node)} />} />}
        {!pending && (nodeQuery.isError ? <CockpitFlowError onRetry={() => void nodeQuery.refetch()} />
          : nodeQuery.isPending ? <p role="status" className="text-caption text-muted-foreground">{t(($) => $.workflow.loading)}</p>
            : form.nodeId && !node ? <p role="alert" className="text-caption text-destructive">{t(($) => $.action_flow.node_unavailable)}</p> : null)}
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <ActionRepairLink href={cockpitSurfacePath(paths.cockpit(), "plan", routeScope, "gantt")}>{t(($) => $.action_flow.open_plan)}</ActionRepairLink>
          {(pending?.body.node_id || form.nodeId) && <ActionRepairLink href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: pending?.body.node_id || form.nodeId, view: "details" }, routeScope)}>{t(($) => $.action_flow.configure_node)}</ActionRepairLink>}
        </div>
      </div>}
      {outcome === "create" && <><CockpitTaskFields wsId={wsId} value={fields} onChange={(fields) => changeForm({ fields })} disabled={busy || Boolean(pending) || !authorized} />
        <p className="text-caption text-muted-foreground">{t(($) => $.meeting_actions.create_hint)}</p></>}
      {outcome === "reuse" && <>
        {pending ? <p className="text-caption">{t(($) => $.task_flow.selected_issue, { name: pending.body.issue_id })}</p>
          : <CockpitIssueChoice wsId={wsId} selected={selected} onSelect={(issue) => changeForm({ issueId: issue.id })} disabled={busy || !authorized} />}
        {form.issueId && !pending && (selectedQuery.isError || (!selectedQuery.isPending && !selected) || primary.isError || (!primary.isPending && !primary.data)) && <CockpitFlowError onRetry={() => { void selectedQuery.refetch(); void primary.refetch(); }} />}
        {(pending?.body.issue_id || form.issueId) && <div className="flex flex-wrap gap-x-4 gap-y-1">
          <ActionRepairLink href={paths.issueDetail(pending?.body.issue_id || selected?.identifier || form.issueId)}>{t(($) => $.action_flow.open_issue_materials)}</ActionRepairLink>
          {!pending && primary.data?.node_id && primary.data.issue_id === form.issueId && <ActionRepairLink href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: primary.data.node_id, view: "details" }, routeScope)}>{t(($) => $.action_flow.open_primary)}</ActionRepairLink>}
        </div>}
        {reuseConflict && <p role="alert" className="text-caption text-destructive">{t(($) => $.meeting_actions.reuse_conflict)}</p>}
        <p className="text-caption text-muted-foreground">{t(($) => $.meeting_actions.reuse_hint)}</p>
      </>}
      {outcome === "dismiss" && <label className="block space-y-1 text-caption">{t(($) => $.meeting_actions.reason)}<Textarea value={reason} rows={3} disabled={busy || Boolean(pending) || !authorized} onChange={(event) => changeForm({ reason: event.target.value })} /></label>}
      {pending && <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.pending_request)}</p>}
      {!authorized && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_actions.no_permission)}</p>}
      <Button type="button" disabled={!canResolve} aria-busy={resolve.isPending} onClick={() => void confirm()}>{resolve.isPending && <Spinner />}
        {pending ? t(($) => $.meeting_actions.retry_decision) : t(($) => $.meeting_actions.confirm)}</Button>
    </>}
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
  </div>;
}
