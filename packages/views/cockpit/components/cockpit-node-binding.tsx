"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspacePaths } from "@multica/core/paths";
import { CockpitUnconfirmedWriteError, cockpitContextOptions } from "@multica/core/cockpit";
import type { CockpitNode, CockpitNodeBindingContext } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { CockpitScopePicker } from "./cockpit-scope-control";

/** Binding facts come from the selected node read model, never from a partial module catalog. */
export function CockpitNodeBindingField({ wsId, node, ancestors, binding, onSave, onOpenNode, readOnly }: {
  wsId: string;
  node: CockpitNode;
  ancestors: CockpitNode[];
  binding: CockpitNodeBindingContext;
  onSave: (binding: { project_id: string | null; module_id: string | null }) => Promise<unknown>;
  onOpenNode: (id: string) => void;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths();
  const [editing, setEditing] = useState(false); const [projectId, setProjectId] = useState<string | null>(null); const [moduleId, setModuleId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false); const [error, setError] = useState(""); const lock = useRef(false);
  const preview = useQuery({ ...cockpitContextOptions(wsId, { projectId, moduleId }), enabled: Boolean(editing && projectId) });
  const inherited = Boolean(binding.source_node_id && binding.source_node_id !== node.id);
  const source = ancestors.find((entry) => entry.id === binding.source_node_id);
  const explicit = Boolean(node.project_id || node.module_id);
  const canEdit = explicit || !(inherited && binding.module_id);
  const configureTarget = inherited && binding.module_id ? binding.source_node_id : !explicit ? node.parent_id : null;
  const bound = Boolean(binding.project_id);
  const begin = () => { setProjectId(node.project_id || binding.project_id); setModuleId(node.module_id || null); setError(""); setEditing(true); };
  async function save() {
    if (lock.current || readOnly || !canEdit || (projectId && (!preview.data || preview.isError || preview.isFetching))) return;
    lock.current = true; setSaving(true); setError("");
    try { await onSave({ project_id: projectId, module_id: moduleId }); setEditing(false); }
    catch (cause) { setError(cause instanceof CockpitUnconfirmedWriteError ? t(($) => $.binding.unconfirmed_save) : cause instanceof Error ? cause.message : t(($) => $.binding.save_failed)); }
    finally { lock.current = false; setSaving(false); }
  }
  return <section className="space-y-3 rounded-xl border border-border bg-muted/20 p-4" aria-label={t(($) => $.binding.title)}>
    <h3 className="text-caption font-medium">{t(($) => $.binding.title)}</h3>
    {bound ? <div className="space-y-1 text-caption"><p className="break-words">{binding.project_title || t(($) => $.binding.project_unavailable)}{binding.module_id && <> / {binding.module_title || binding.module_id}</>}</p>
      <p className="text-muted-foreground">{inherited ? t(($) => $.binding.inherited, { label: source?.name || source?.code || binding.source_node_id }) : binding.module_id ? t(($) => $.binding.module_bound) : t(($) => $.binding.project_bound)}</p>
      {!binding.module_id && !explicit && <p className="text-muted-foreground">{t(($) => $.binding.module_required)}</p>}</div>
      : <p className="text-caption text-muted-foreground">{binding.reason === "binding_conflict" || binding.reason === "invalid_ancestry" ? t(($) => $.binding.invalid) : t(($) => $.binding.unbound)}</p>}
    {!editing && !readOnly && <div className="flex flex-wrap gap-2">{configureTarget && <Button type="button" variant="outline" size="sm" onClick={() => onOpenNode(configureTarget)}>{t(($) => $.binding.configure_parent)}</Button>}
      {canEdit && <Button type="button" variant="outline" size="sm" onClick={begin}>{t(($) => $.binding.configure)}</Button>}</div>}
    {editing && <div className="space-y-3">
      <div className="flex flex-wrap gap-3"><CockpitScopePicker wsId={wsId} kind="project" projectId={null} selectedId={projectId} selectedTitle={preview.data?.scope.project_title ?? ""}
        label={t(($) => $.binding.project)} emptyLabel={t(($) => $.binding.none)} disabled={saving} onSelect={(value) => { if (!lock.current) { setProjectId(value); setModuleId(null); } }}
        emptyAction={<div className="space-y-1"><p>{t(($) => $.task_recovery.no_projects)}</p><AppLink href={paths.projects()} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t(($) => $.task_recovery.open_projects)}</AppLink></div>} />
        <CockpitScopePicker key={projectId ?? "none"} wsId={wsId} kind="module" projectId={projectId} selectedId={moduleId} selectedTitle={preview.data?.scope.module_title ?? ""}
          label={t(($) => $.binding.module)} emptyLabel={t(($) => $.binding.none)} disabled={saving || !projectId} onSelect={(value) => { if (!lock.current) setModuleId(value); }}
          emptyAction={projectId ? <div className="space-y-1"><p>{t(($) => $.task_recovery.no_modules)}</p><AppLink href={paths.projectDetail(projectId)} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t(($) => $.task_recovery.open_project)}</AppLink></div> : undefined} /></div>
      {projectId && preview.isError && <div role="alert" className="space-y-2 text-caption text-destructive"><p>{t(($) => $.shell.invalid_scope)}</p><Button type="button" size="sm" variant="outline" onClick={() => void preview.refetch()}>{t(($) => $.binding.retry)}</Button></div>}
      <p className="text-caption text-muted-foreground">{t(($) => $.binding.hint)}</p>
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={saving || Boolean(projectId && (preview.isFetching || preview.isError || !preview.data))} aria-busy={saving} onClick={() => void save()}>{saving && <Spinner />}{t(($) => $.binding.save)}</Button>
        <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => setEditing(false)}>{t(($) => $.binding.cancel)}</Button></div>
    </div>}
  </section>;
}
