"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import {
  cockpitNodeTasksOptions, cockpitPrimaryNodeOptions, useCreateCockpitNodeTask, useSetCockpitPrimaryNode,
  clearCockpitActionCommand, rememberCockpitActionCommand, useCockpitActionCommandStore, CockpitUnconfirmedWriteError,
  cockpitTaskViewKey, EMPTY_COCKPIT_TASK_VIEW, useCockpitTaskViewStore, useAppendCockpitNodeIssue, useDeleteCockpitNodeIssue,
  cockpitObjectPath, cockpitScope, useCockpitAssigneeAvailability,
} from "@multica/core/cockpit";
import type { CockpitNode, CockpitTaskCreate, Issue } from "@multica/core/types";
import { issueOperationAllowed, useIssueOperationBasis } from "@multica/core/issues";
import { IssueOperationRestriction } from "../../issues/components/issue-operation-restriction";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { useStatusLabel } from "../../issues/utils/status-label";
import { useNavigation, AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, CockpitIssueChoice, CockpitTaskRows, useCockpitSearch } from "./cockpit-task-flow";
import { CockpitTaskFields, cockpitTaskFieldsBody, cockpitTaskFieldsValue } from "./cockpit-task-fields";
import { createSafeId } from "@multica/core/utils";

function NodeTaskCreate({ wsId, node, userId, disabled }: { wsId: string; node: CockpitNode; userId: string; disabled: boolean }) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const scope = `node:${node.id}:task`;
  const saved = useCockpitActionCommandStore((state) => state.draft.commands[scope]);
  const pending = saved?.kind === "task" ? saved : undefined;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState(() => cockpitTaskFieldsValue(userId));
  const executor = useCockpitAssigneeAvailability(wsId, fields.assigneeType, fields.assigneeId);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const create = useCreateCockpitNodeTask(wsId);
  async function submit() {
    if (lock.current || disabled || (!pending && (!executor.available || !fields.assigneeId || !title.trim()))) return;
    const body: CockpitTaskCreate = pending?.body ?? { creation_key: createSafeId(), title: title.trim(), description: description.trim(), ...cockpitTaskFieldsBody(fields) };
    rememberCockpitActionCommand(scope, { kind: "task", node_id: node.id, body });
    lock.current = true; setError("");
    try { await create.mutateAsync({ nodeId: node.id, body }); clearCockpitActionCommand(scope); setOpen(false); }
    catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) clearCockpitActionCommand(scope);
      setError(cause instanceof CockpitUnconfirmedWriteError ? t(($) => $.task_flow.unconfirmed) : cause instanceof Error ? cause.message : t(($) => $.errors.save_failed));
    } finally { lock.current = false; }
  }
  return <div className="space-y-1"><Dialog open={open} onOpenChange={(next) => {
    if (lock.current) return; setOpen(next);
    if (next) { setError(""); setTitle(pending?.body.title ?? ""); setDescription(pending?.body.description ?? ""); setFields(cockpitTaskFieldsValue(userId, pending?.body)); }
  }}>
    <DialogTrigger render={<Button type="button" size="sm" disabled={disabled} />}>{pending ? t(($) => $.task_flow.retry_creation) : t(($) => $.task_flow.create)}</DialogTrigger>
    <DialogContent className="sm:max-w-lg" showCloseButton={!create.isPending}>
      <DialogHeader><DialogTitle>{t(($) => $.task_flow.create)}</DialogTitle><DialogDescription>{t(($) => $.task_flow.create_hint, { name: node.name })}</DialogDescription></DialogHeader>
      <label className="space-y-1 text-caption">{t(($) => $.task_flow.title)}<Input value={title} disabled={create.isPending || Boolean(pending)} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="space-y-1 text-caption">{t(($) => $.task_flow.description)}<Textarea value={description} rows={3} disabled={create.isPending || Boolean(pending)} onChange={(event) => setDescription(event.target.value)} /></label>
      <CockpitTaskFields wsId={wsId} value={fields} onChange={setFields} disabled={create.isPending || Boolean(pending)} />
      {pending && <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.pending_request)}</p>}
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <DialogFooter><DialogClose render={<Button type="button" variant="outline" disabled={create.isPending} />}>{t(($) => $.binding.cancel)}</DialogClose>
        <Button type="button" disabled={disabled || create.isPending || !title.trim() || (!pending && (!fields.assigneeId || !executor.available))} aria-busy={create.isPending} onClick={() => void submit()}>
          {create.isPending && <Spinner />}{pending ? t(($) => $.task_flow.retry_creation) : t(($) => $.task_flow.create)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>{create.data && !open && <p className="text-caption"><AppLink href={paths.issueDetail(create.data.id)} newTabTitle={create.data.title} className="hover:underline">
    {t(($) => $.task_flow.request_confirmed, { name: create.data.identifier })}</AppLink></p>}</div>;
}

function NodePrimaryAssign({ wsId, node, projectId, moduleId, disabled, reference = false }: { wsId: string; node: CockpitNode; projectId: string | null; moduleId: string | null; disabled: boolean; reference?: boolean }) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Issue | null>(null);
  const [observed, setObserved] = useState<{ issueId: string; revision: number } | null>(null);
  const [error, setError] = useState("");
  const primary = useQuery(cockpitPrimaryNodeOptions(wsId, open && !reference ? selected?.id ?? "" : ""));
  const policy = useIssueOperationBasis(wsId, open && !reference && selected ? [selected.id] : []);
  const observation = { basis: selected ? policy.byIssue.get(selected.id) : undefined, pending: policy.isPending, error: policy.isError, retry: () => { void policy.refetch(); } };
  const primaryAllowed = reference || issueOperationAllowed(observation.basis, "primary");
  const assign = useSetCockpitPrimaryNode(wsId);
  const link = useAppendCockpitNodeIssue(wsId);
  const working = assign.isPending || link.isPending;
  useEffect(() => {
    if (!reference && selected && primary.data?.issue_id === selected.id && !observed) setObserved({ issueId: selected.id, revision: primary.data.revision });
  }, [reference, selected, primary.data, observed]);
  const stale = Boolean(!reference && observed && primary.data && primary.data.revision !== observed.revision);
  const valid = selected && (reference || (primary.data?.issue_id === selected.id && primary.data.project_id === projectId && primary.data.module_id === moduleId));
  const moving = primary.data?.node_id && primary.data.node_id !== node.id;
  return <Dialog open={open} onOpenChange={(next) => { if (!working) { setOpen(next); if (next) { setSelected(null); setObserved(null); setError(""); } } }}>
    <DialogTrigger render={<Button type="button" size="sm" variant="outline" disabled={disabled} />}>{reference ? t(($) => $.task_flow.link_reference) : t(($) => $.task_flow.assign_existing)}</DialogTrigger>
    <DialogContent className="sm:max-w-lg" showCloseButton={!working}><DialogHeader><DialogTitle>{reference ? t(($) => $.task_flow.link_reference) : t(($) => $.task_flow.assign_existing)}</DialogTitle>
      <DialogDescription>{reference ? t(($) => $.task_flow.reference_write_hint) : t(($) => $.task_flow.assign_hint, { name: node.name })}</DialogDescription></DialogHeader>
      <CockpitIssueChoice wsId={wsId} selected={selected} onSelect={(issue) => { setSelected(issue); setObserved(null); setError(""); }} disabled={working} />
      {selected && !reference && primary.isPending && <Spinner />}
      {selected && !reference && (primary.isError || (!primary.isPending && !primary.data)) && <CockpitFlowError onRetry={() => void primary.refetch()} />}
      {selected && !reference && <IssueOperationRestriction observation={observation} operation="primary" />}
      {selected && primary.data && !valid && <p role="alert" className="text-caption text-destructive">{t(($) => $.task_flow.scope_mismatch)}</p>}
      {moving && <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.move_primary, { from: primary.data?.node_name || primary.data?.node_code || primary.data?.node_id, to: node.name })}</p>}
      {stale && <p role="alert" className="text-caption text-destructive">{t(($) => $.task_flow.primary_changed)}</p>}
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <DialogFooter><DialogClose render={<Button type="button" variant="outline" disabled={working} />}>{t(($) => $.binding.cancel)}</DialogClose>
        <Button type="button" disabled={disabled || working || stale || !primaryAllowed || (!reference && (!observed || primary.isFetching)) || !valid || (!reference && primary.data?.node_id === node.id)} aria-busy={working}
          onClick={() => { if (!selected || !primaryAllowed || working || disabled || stale) return;
            const work = reference ? link.mutateAsync({ nodeId: node.id, issueId: selected.id }) : primary.data && observed ? assign.mutateAsync({ issueId: selected.id, nodeId: node.id, revision: observed.revision }) : Promise.reject(new CockpitUnconfirmedWriteError());
            void work.then(() => setOpen(false)).catch((cause) => setError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed))); }}>
          {working && <Spinner />}{reference ? t(($) => $.task_flow.link_reference) : t(($) => $.task_flow.confirm_primary)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function CockpitNodeTasks({ wsId, node, userId, readOnly, referenceOnly = false, onCreateReference }: { wsId: string; node: CockpitNode; userId: string; readOnly?: boolean; referenceOnly?: boolean; onCreateReference?: () => void }) {
  const { t } = useT("cockpit");
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const eligibilityReason = (reason: string) => {
    switch (reason) {
      case "module_binding_required": return t(($) => $.task_recovery.eligibility_module_required);
      case "binding_conflict": return t(($) => $.task_recovery.eligibility_binding_conflict);
      case "structural_node": return t(($) => $.task_recovery.eligibility_structural);
      case "not_leaf": return t(($) => $.task_recovery.eligibility_not_leaf);
      case "invalid_ancestry": return t(($) => $.task_recovery.eligibility_ancestry);
      default: return t(($) => $.task_flow.ineligible);
    }
  };
  const label = useStatusLabel(wsId);
  const viewKey = cockpitTaskViewKey(wsId, "node", node.id) + (referenceOnly ? ":references" : "");
  const view = useCockpitTaskViewStore((state) => state.views[viewKey] ?? EMPTY_COCKPIT_TASK_VIEW);
  const setView = (patch: Partial<typeof view>) => useCockpitTaskViewStore.getState().update(viewKey, patch);
  const { text, category, status } = view;
  const relation = referenceOnly ? "reference" : view.relation;
  const setText = (text: string) => setView({ text });
  const setRelation = (relation: "primary" | "reference") => setView({ relation });
  const setCategory = (category: string) => setView({ category });
  const setStatus = (status: string) => setView({ status, ...(status ? { category: "" } : {}) });
  const q = useCockpitSearch(text);
  const filterKey = JSON.stringify([node.id, q, relation, category, status]);
  const cursors = view.cursorKey === filterKey ? view.cursors : [""];
  const setPagination = (next: { key: string; cursors: string[] }) => setView({ cursorKey: next.key, cursors: next.cursors });
  const unlink = useDeleteCockpitNodeIssue(wsId);
  const [unlinkError, setUnlinkError] = useState("");
  const query = useQuery(cockpitNodeTasksOptions(wsId, node.id, { q, relation, category, status, cursor: cursors.at(-1) || undefined }));
  const data = query.data;
  const statusChoices: Array<{ value: string; label: string; count: number | null }> = [{ value: "__all__", label: t(($) => $.task_flow.all_statuses), count: null },
    ...(data?.summary.by_status ?? []).map((entry) => ({ value: entry.status, label: label(entry.status), count: entry.count }))];
  if (status && !statusChoices.some((entry) => entry.value === status)) statusChoices.push({ value: status, label: label(status), count: null });
  const blocked = Boolean(readOnly || !userId || !data?.eligibility.eligible || query.isFetching);
  const categoryLabels = { unstarted: t(($) => $.task_flow.unstarted), started: t(($) => $.task_flow.started), done: t(($) => $.task_flow.done), closed: t(($) => $.task_flow.closed), unknown: t(($) => $.task_flow.unknown) };
  return <section aria-label={t(($) => $.task_flow.region)} className="space-y-4">
    {!referenceOnly && <div className="flex flex-wrap items-center gap-2"><NodeTaskCreate wsId={wsId} node={node} userId={userId} disabled={blocked} />
      <NodePrimaryAssign wsId={wsId} node={node} projectId={data?.eligibility.project_id ?? null} moduleId={data?.eligibility.module_id ?? null} disabled={blocked} /></div>}
    {referenceOnly && onCreateReference && <Button type="button" variant="outline" size="sm" disabled={readOnly} onClick={onCreateReference}>{t(($) => $.issues.create)}</Button>}
    {relation === "reference" && <NodePrimaryAssign wsId={wsId} node={node} projectId={null} moduleId={null} disabled={Boolean(readOnly || !userId)} reference />}
    <label className="block space-y-1 text-caption">{t(($) => $.task_flow.search)}<Input value={text} onChange={(event) => setText(event.target.value)} /></label>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {!referenceOnly && <label className="space-y-1 text-caption">{t(($) => $.task_flow.relationship)}<Select value={relation} onValueChange={(value) => { if (value === "primary" || value === "reference") setRelation(value); }}
        items={[{ value: "primary", label: t(($) => $.task_flow.primary) }, { value: "reference", label: t(($) => $.task_flow.reference) }]}>
        <SelectTrigger className="w-full" aria-label={t(($) => $.task_flow.relationship)}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="primary">{t(($) => $.task_flow.primary)}</SelectItem><SelectItem value="reference">{t(($) => $.task_flow.reference)}</SelectItem></SelectContent>
      </Select></label>}
      <label className="space-y-1 text-caption">{t(($) => $.task_flow.status)}<Select value={status || "__all__"} onValueChange={(value) => { if (typeof value === "string") setStatus(value !== "__all__" ? value : ""); }}
        items={statusChoices}>
        <SelectTrigger className="w-full" aria-label={t(($) => $.task_flow.status)}><SelectValue /></SelectTrigger><SelectContent>
          {statusChoices.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}{entry.count === null ? "" : ` (${entry.count})`}</SelectItem>)}</SelectContent>
      </Select></label>
    </div>
    {query.isPending ? <div role="status" className="flex items-center gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
      : query.isError || !data ? <div className="space-y-2"><CockpitFlowError onRetry={() => void query.refetch()} />
        {cursors.length > 1 && <Button type="button" size="sm" variant="outline" onClick={() => setPagination({ key: filterKey, cursors: [""] })}>{t(($) => $.task_flow.first_page)}</Button>}</div> : <>
        {!referenceOnly && !data.eligibility.eligible && <div role="status" className="space-y-2 rounded-md bg-muted p-3 text-caption">
          <p>{eligibilityReason(data.eligibility.reason)}</p>
          <AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: node.id, view: "details" }, cockpitScope(navigation.searchParams))}
            className="inline-flex rounded-sm font-medium text-foreground underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring">
            {t(($) => $.task_recovery.open_plan_details)}</AppLink>
        </div>}
        <p className="text-caption text-muted-foreground">{relation === "primary" ? t(($) => $.task_flow.primary_hint, { total: data.total }) : t(($) => $.task_flow.reference_hint, { total: data.total })}</p>
        <div className="flex flex-wrap gap-1.5"><Button type="button" variant={category === "active" ? "secondary" : "outline"} size="sm" aria-pressed={category === "active"} onClick={() => { setCategory("active"); setStatus(""); }}>{t(($) => $.task_flow.active)} ({data.summary.total - data.summary.done - data.summary.closed})</Button>
          <Button type="button" variant={!category ? "secondary" : "outline"} size="sm" aria-pressed={!category} onClick={() => { setCategory(""); setStatus(""); }}>{t(($) => $.task_flow.all)} ({data.summary.total})</Button>
          {Object.entries(categoryLabels).map(([key, name]) => <Button key={key} type="button" variant={category === key ? "secondary" : "outline"} size="sm" aria-pressed={category === key}
            onClick={() => { setCategory(key); setStatus(""); }}>{name} ({data.summary.by_category[key] ?? 0})</Button>)}</div>
        {unlinkError && <p role="alert" className="text-caption text-destructive">{unlinkError}</p>}
        <CockpitFlowPaging page={cursors.length} shown={data.items.length} total={data.filtered_total} hasNext={Boolean(data.next_cursor)} busy={query.isFetching || text.trim() !== q}
          onPrevious={() => setPagination({ key: filterKey, cursors: cursors.slice(0, -1) })}
          onNext={() => { if (data.next_cursor) setPagination({ key: filterKey, cursors: [...cursors, data.next_cursor] }); }} />
        {data.items.length > 0 ? <CockpitTaskRows wsId={wsId} items={data.items} trailing={relation === "reference" && !readOnly ? (issue) => <Button type="button" variant="ghost" size="xs" disabled={unlink.isPending}
          onClick={() => { setUnlinkError(""); void unlink.mutateAsync({ nodeId: node.id, issueId: issue.id }).catch((cause) => setUnlinkError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed))); }}>{t(($) => $.task_flow.unlink_reference)}</Button> : undefined} /> : <p className="py-4 text-caption text-muted-foreground">{q || category || status ? t(($) => $.task_flow.no_matches) : t(($) => $.task_flow.empty)}</p>}
      </>}
  </section>;
}
