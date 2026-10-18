"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { containerOperationBasisOptions, containerOperationAllowed } from "@multica/core/issues";
import { ContainerOperationRestriction } from "../../issues/components/issue-operation-restriction";
import { ApiError } from "@multica/core/api";
import {
  buildCockpitDisplayCodesFromIndex, cockpitObjectPath, cockpitScopeViewKey, cockpitContextOptions, cockpitNodeDetailOptions, cockpitNodeCodePreviewOptions, useCreateCockpitNode,
  useCockpitPlanNodeDraftStore, EMPTY_COCKPIT_PLAN_NODE_DRAFT, updateCockpitPlanNodeDraft, clearCockpitPlanNodeDraft, rejectCockpitPlanNodeDraft, getCockpitNodeBindingConflict, type CockpitScope,
} from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitScopePicker } from "./cockpit-scope-control";
import { CockpitNodeChoicePicker } from "./cockpit-node-choice";
import { CockpitFlowError } from "./cockpit-task-flow";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { createSafeId } from "@multica/core/utils";

export function CockpitPlanStructureCreate({ wsId, scope, disabled, onCreated, defaultKind = "project" }: {
  wsId: string; scope: CockpitScope; disabled?: boolean; defaultKind?: "project" | "module" | "task"; onCreated: (id: string) => void;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const key = cockpitScopeViewKey(wsId, scope);
  const empty = useMemo(() => ({ ...EMPTY_COCKPIT_PLAN_NODE_DRAFT, projectId: scope.projectId ?? "", moduleId: scope.moduleId ?? "", kind: defaultKind }), [scope.projectId, scope.moduleId, defaultKind]);
  const draft = useCockpitPlanNodeDraftStore((state) => state.draft.byScope[key] ?? empty);
  const change = (patch: Partial<typeof draft>) => { if (!draft.pending) updateCockpitPlanNodeDraft(key, { ...draft, ...patch }); };
  const [open, setOpen] = useState(false), [error, setError] = useState("");
  const [creationGone, setCreationGone] = useState(false);
  const [existingId, setExistingId] = useState<string | null>(null); const lock = useRef(false);
  const captureContext = useCockpitCommandContext(JSON.stringify([key, open]));
  const parentId = draft.kind === "project" ? null : draft.parentId || null;
  const selected = useQuery({ ...cockpitContextOptions(wsId, { projectId: draft.projectId || null, moduleId: draft.kind === "module" ? draft.moduleId || null : null }), enabled: open });
  const parent = useQuery({ ...cockpitNodeDetailOptions(wsId, parentId ?? "", scope), enabled: Boolean(open && parentId) });
  const operation = useQuery({ ...containerOperationBasisOptions(wsId, "node", parentId ?? ""), enabled: Boolean(open && parentId && !draft.pending) });
  const canAddChild = !parentId || !operation.isError && containerOperationAllowed(operation.data, "add_child");
  const code = useQuery({ ...cockpitNodeCodePreviewOptions(wsId, parentId), enabled: open && (draft.kind === "project" || Boolean(parentId)) && !draft.pending });
  const create = useCreateCockpitNode(wsId);
  const parentValid = draft.kind === "project" || Boolean(parent.data && !parent.isError && !parent.isFetching && (draft.kind === "module"
    ? parent.data.binding.project_id === draft.projectId && !parent.data.binding.module_id
    : parent.data.binding.project_id && parent.data.binding.module_id));
  const scopeValid = draft.kind === "task" ? parentValid : Boolean(selected.data && !selected.isError && !selected.isFetching && draft.projectId && (draft.kind !== "module" || draft.moduleId));
  const busy = create.isPending; const frozen = Boolean(draft.pending);
  const choices = [{ value: "project", label: t(($) => $.plan_structure.project) }, { value: "module", label: t(($) => $.plan_structure.module) }, { value: "task", label: t(($) => $.plan_structure.task) }];
  const submit = async () => {
    if (lock.current || disabled || (!draft.pending && (!parentValid || !scopeValid || !canAddChild || !draft.name.trim()))) return;
    const command = draft.pending ?? { creation_key: createSafeId(), auto_code: true as const, name: draft.name.trim(), parent_id: parentId,
      project_id: draft.kind === "task" ? null : draft.projectId || null, module_id: draft.kind === "module" ? draft.moduleId || null : null, status: "" };
    const sent = { ...draft, pending: command }; updateCockpitPlanNodeDraft(key, sent);
    const isCurrent = captureContext(); lock.current = true; setError(""); setCreationGone(false); setExistingId(null);
    try {
      const result = await create.mutateAsync(command);
      if (!result.id || result.creation_key !== command.creation_key || typeof result.replayed !== "boolean" || !result.code.trim() || result.name !== command.name || result.parent_id !== command.parent_id
        || (result.project_id ?? null) !== command.project_id || (result.module_id ?? null) !== command.module_id) throw new Error(t(($) => $.workflow.unconfirmed));
      clearCockpitPlanNodeDraft(key, sent); if (isCurrent()) { setOpen(false); onCreated(result.id); }
    } catch (cause) {
      const conflict = getCockpitNodeBindingConflict(cause, wsId, command.creation_key);
      const rejected = Boolean(conflict) || cause instanceof ApiError && [400, 403, 404, 422].includes(cause.status);
      rejectCockpitPlanNodeDraft(key, command, rejected);
      if (isCurrent()) { setError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed)); setCreationGone(cause instanceof ApiError && cause.status === 410); setExistingId(conflict?.existing_node_id ?? null); }
    } finally { lock.current = false; }
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!lock.current) { if (next && !useCockpitPlanNodeDraftStore.getState().draft.byScope[key]) updateCockpitPlanNodeDraft(key, empty); setOpen(next); } }}><DialogTrigger render={<Button type="button" size="sm" disabled={disabled} />}>{t(($) => $.plan_structure.add)}</DialogTrigger>
    <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{t(($) => $.plan_structure.add)}</DialogTitle></DialogHeader>
      <div className="space-y-4"><label className="block space-y-1 text-caption">{t(($) => $.plan_structure.kind)}<Select value={draft.kind} disabled={busy || frozen} items={choices} onValueChange={(kind) => { if (kind === "project" || kind === "module" || kind === "task") change({ kind, parentId: "", name: "" }); }}><SelectTrigger aria-label={t(($) => $.plan_structure.kind)} className="w-full"><SelectValue /></SelectTrigger><SelectContent>{choices.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></label>
      {draft.kind !== "task" && <CockpitScopePicker wsId={wsId} kind="project" projectId={null} selectedId={draft.projectId || null} selectedTitle={selected.data?.scope.project_title ?? ""} disabled={busy || frozen}
        label={t(($) => $.binding.project)} emptyLabel={t(($) => $.binding.choose_project)} emptyAction={<AppLink target="_blank" href={paths.projects()} className="text-primary underline">{t(($) => $.task_recovery.open_projects)}</AppLink>}
        onSelect={(id) => change({ projectId: id ?? "", moduleId: "", parentId: "" })} />}
      {draft.kind === "module" && <CockpitScopePicker wsId={wsId} kind="module" projectId={draft.projectId || null} selectedId={draft.moduleId || null} selectedTitle={selected.data?.scope.module_title ?? ""} disabled={busy || frozen || !draft.projectId}
        label={t(($) => $.binding.module)} emptyLabel={t(($) => $.binding.choose_module)} emptyAction={draft.projectId ? <AppLink target="_blank" href={paths.projectDetail(draft.projectId)} className="text-primary underline">{t(($) => $.task_recovery.open_project)}</AppLink> : undefined}
        onSelect={(id) => change({ moduleId: id ?? "" })} />}
      {selected.isError && <CockpitFlowError onRetry={() => void selected.refetch()} />}
      {draft.kind !== "project" && <div className="space-y-2"><CockpitNodeChoicePicker wsId={wsId} scope={{ projectId: draft.projectId || scope.projectId, moduleId: draft.kind === "task" ? scope.moduleId : null }} eligible={false}
        label={t(($) => $.plan_structure.parent)} value={parent.data ? `${buildCockpitDisplayCodesFromIndex(parent.data.node_index).get(parent.data.node.id) ?? parent.data.node.code} ${parent.data.node.name}` : draft.parentId} disabled={busy || frozen} onSelect={(node) => change({ parentId: node.id })} />
        {parent.isError && <CockpitFlowError onRetry={() => void parent.refetch()} />}{draft.parentId && !parent.isPending && !parentValid && <p role="alert" className="text-caption text-destructive">{t(($) => $.plan_structure.invalid_parent)}</p>}
        {parentId && !draft.pending && <ContainerOperationRestriction basis={operation.isError ? undefined : operation.data} operation="add_child" pending={operation.isPending} error={operation.isError} retry={() => void operation.refetch()} />}
        <p className="text-caption text-muted-foreground">{draft.kind === "module" ? t(($) => $.plan_structure.module_parent) : t(($) => $.plan_structure.task_parent)}</p></div>}
      <label className="block space-y-1 text-caption">{t(($) => $.node.name)}<Input value={draft.name} disabled={busy || frozen} onChange={(event) => change({ name: event.target.value })} /></label>
      <p className="text-caption text-muted-foreground">{t(($) => $.task_create.code)}: <span className="font-mono">{code.data?.code || "—"}</span></p>
      <p className="text-caption text-muted-foreground">{t(($) => $.plan_structure.code_preview_hint)}</p>
      {code.isError && <CockpitFlowError onRetry={() => void code.refetch()} />}
      {draft.uncertain && <p role="alert" className="text-caption text-muted-foreground">{t(($) => $.plan_structure.unknown_result)}</p>}
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      {existingId && <AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: existingId, view: "details" }, scope)} onClick={(event) => { if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) setOpen(false); }} className="text-caption text-primary underline">{t(($) => $.plan_structure.open_existing)}</AppLink>}
      {error && !draft.pending && <Button type="button" size="sm" variant="outline" disabled={code.isFetching} onClick={() => void code.refetch()}>{t(($) => $.plan_structure.refresh_code)}</Button>}
      {creationGone && draft.pending && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { updateCockpitPlanNodeDraft(key, { pending: null, uncertain: false }); setCreationGone(false); setError(""); }}>{t(($) => $.meeting_center.restart_deleted)}</Button>}
      {draft.uncertain && <div className="space-y-2"><CockpitNodeChoicePicker wsId={wsId} eligible={false} scope={scope} label={t(($) => $.plan_structure.check_existing)} onSelect={(node) => { setOpen(false); onCreated(node.id); }} />
</div>}</div>
      <DialogFooter><DialogClose render={<Button type="button" variant="outline" disabled={busy} />}>{t(($) => $.binding.cancel)}</DialogClose><Button type="button" disabled={disabled || busy || (!frozen && (!parentValid || !scopeValid || !canAddChild || !draft.name.trim()))} onClick={() => void submit()}>{busy && <Spinner />}{frozen ? t(($) => $.binding.retry) : t(($) => $.plan_structure.confirm)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
