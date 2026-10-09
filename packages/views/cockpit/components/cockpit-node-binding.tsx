"use client";

import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { projectListOptions } from "@multica/core/projects/queries";
import { CockpitUnconfirmedWriteError, resolveCockpitNodeBinding } from "@multica/core/cockpit";
import type { CockpitNode, Module } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { LoaderCircle } from "lucide-react";
import { useT } from "../../i18n";

const NONE = "__unbound__";

export function CockpitNodeBindingField({ node, nodes, modules, modulesLoading, modulesError, onRetryModules, onSave, onOpenNode, readOnly }: {
  node: CockpitNode;
  nodes: ReadonlyMap<string, CockpitNode>;
  modules: Module[];
  modulesLoading?: boolean;
  modulesError?: boolean;
  onRetryModules?: () => void;
  onSave: (binding: { project_id: string | null; module_id: string | null }) => Promise<unknown>;
  onOpenNode: (id: string) => void;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const wsId = useWorkspaceId();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [projectId, setProjectId] = useState<string>(NONE);
  const [moduleId, setModuleId] = useState<string>(NONE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const saveLock = useRef(false);
  const binding = resolveCockpitNodeBinding(node, nodes, modules);
  const projects = useQuery({ ...projectListOptions(wsId), enabled: Boolean(wsId) && (editing || binding.status === "bound") });
  const inherited = binding.status === "bound" && binding.source_node_id !== node.id;
  const source = binding.status === "bound" ? nodes.get(binding.source_node_id) : undefined;
  const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
  // A descendant of a mapped module is execution work, not another structural mapping row.
  const parentBinding = parent ? resolveCockpitNodeBinding(parent, nodes, modules) : null;
  const canEdit = Boolean(node.project_id || node.module_id)
    || !(parentBinding?.status === "bound" && parentBinding.module_id);
  const configureTarget = inherited && binding.module_id ? source
    : !node.project_id && !node.module_id ? parent : undefined;
  const beginEdit = () => {
    setProjectId(node.project_id || (binding.status === "bound" ? binding.project_id : NONE));
    setModuleId(node.module_id || NONE);
    setError("");
    setEditing(true);
  };
  const save = async () => {
    if (saveLock.current) return;
    saveLock.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave({ project_id: projectId === NONE ? null : projectId, module_id: moduleId === NONE ? null : moduleId });
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof CockpitUnconfirmedWriteError
        ? t(($) => $.binding.unconfirmed_save)
        : cause instanceof Error ? cause.message : t(($) => $.binding.save_failed));
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  };
  const filteredModules = modules.filter((entry) => entry.project_id === projectId);
  return <section className="space-y-2 rounded-md border border-border p-3" aria-label={t(($) => $.binding.title)}>
    <h3 className="text-caption font-medium">{t(($) => $.binding.title)}</h3>
    {modulesError ? <div role="alert" className="space-y-2 text-caption text-destructive">
      <p>{t(($) => $.binding.modules_failed)}</p>
      {onRetryModules && <Button type="button" variant="outline" size="sm" onClick={onRetryModules}>{t(($) => $.binding.retry)}</Button>}
    </div> : modulesLoading ? <p className="text-caption text-muted-foreground">{t(($) => $.binding.loading)}</p>
      : binding.status === "bound" ? (
      <div className="space-y-1 text-caption">
        <p className="break-words">{projects.data?.find((entry) => entry.id === binding.project_id)?.title
          || (projects.isFetching ? t(($) => $.binding.loading) : t(($) => $.binding.project_unavailable))}
          {binding.module_id && <> / {modules.find((entry) => entry.id === binding.module_id)?.title || binding.module_id}</>}</p>
        <p className="text-muted-foreground">{inherited
          ? t(($) => $.binding.inherited, { label: source?.name || source?.code || binding.source_node_id })
          : binding.module_id ? t(($) => $.binding.module_bound) : t(($) => $.binding.project_bound)}</p>
        {!binding.module_id && !node.project_id && <p className="text-muted-foreground">{t(($) => $.binding.module_required)}</p>}
      </div>
    ) : <p className="text-caption text-muted-foreground">{binding.status === "invalid"
      ? t(($) => $.binding.invalid) : t(($) => $.binding.unbound)}</p>}
    {!editing && projects.isError && <div role="alert" className="space-y-2 text-caption text-destructive">
      <p>{t(($) => $.binding.load_failed)}</p>
      <Button type="button" variant="outline" size="sm" onClick={() => void projects.refetch()}>{t(($) => $.binding.retry)}</Button>
    </div>}
    {!readOnly && !editing && <div className="flex flex-wrap gap-2">
      {configureTarget && <Button type="button" variant="outline" size="sm" onClick={() => onOpenNode(configureTarget.id)}>
        {t(($) => $.binding.configure_parent)}
      </Button>}
      {canEdit && <Button type="button" variant="outline" size="sm" disabled={modulesLoading || modulesError} onClick={beginEdit}>{t(($) => $.binding.configure)}</Button>}
    </div>}
    {editing && <div className="space-y-3">
      {projects.isError ? <div role="alert" className="space-y-2 text-caption text-destructive">
        <p>{t(($) => $.binding.load_failed)}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void projects.refetch()}>{t(($) => $.binding.retry)}</Button>
      </div> : <>
        <div className="space-y-1">
          <label htmlFor={`${id}-project`} className="text-caption">{t(($) => $.binding.project)}</label>
          <Select value={projectId} disabled={saving || projects.isLoading}
            items={[{ value: NONE, label: t(($) => $.binding.none) }, ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.title }))]}
            onValueChange={(value) => { setProjectId(value || NONE); setModuleId(NONE); }}>
            <SelectTrigger id={`${id}-project`} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t(($) => $.binding.none)}</SelectItem>
              {(projects.data ?? []).map((project) => <SelectItem key={project.id} value={project.id}>{project.title}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-module`} className="text-caption">{t(($) => $.binding.module)}</label>
          <Select value={moduleId} disabled={saving || projectId === NONE}
            items={[{ value: NONE, label: t(($) => $.binding.none) }, ...filteredModules.map((m) => ({ value: m.id, label: m.title }))]}
            onValueChange={(value) => setModuleId(value || NONE)}>
            <SelectTrigger id={`${id}-module`} className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t(($) => $.binding.none)}</SelectItem>
              {filteredModules.map((module) => <SelectItem key={module.id} value={module.id}>{module.title}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </>}
      <p className="text-caption text-muted-foreground">{t(($) => $.binding.hint)}</p>
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={saving || projects.isLoading || projects.isError || modulesLoading || modulesError}
          aria-busy={saving} onClick={() => void save()}>
          {saving && <LoaderCircle className="size-3.5 animate-spin" />}{t(($) => $.binding.save)}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => setEditing(false)}>{t(($) => $.binding.cancel)}</Button>
      </div>
    </div>}
  </section>;
}
