"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitContextOptions, cockpitMeetingArtifactReferencesOptions, type CockpitTemplateApplicationDraft, type CockpitTemplateEditorDraft } from "@multica/core/cockpit";
import { issueDetailOptions } from "@multica/core/issues";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { CockpitFlowError, CockpitFlowPaging, CockpitIssueChoice } from "./cockpit-task-flow";
import { CockpitNodeIssuePicker, useCockpitSelectedNodeIssueOption } from "./cockpit-node-issue-picker";
import { CockpitReviewerSelect } from "./cockpit-reviewer-select";
import { CockpitAssigneePicker } from "./cockpit-assignee-picker";
import { CockpitScopePicker } from "./cockpit-scope-control";
import { ArtifactStatus } from "./cockpit-artifact-status";
import { CockpitTemplateSlotText, useMeetingTemplateKindLabel } from "./cockpit-meeting-template-fields";

type Config = CockpitTemplateEditorDraft["config"];
type Binding = CockpitTemplateApplicationDraft["bindings"][number];

export function emptyMeetingTemplateBinding(slotId: string): Binding {
  return { slot_id: slotId, selected: false, node_id: null, facilitator_user_id: null, project_id: null, module_id: null,
    assignee_type: null, assignee_id: null, due_date: null, issue_id: null, material_reference_id: null };
}

export function CockpitMeetingTemplateBindings({ wsId, meetingId, config, value, onChange, disabled, resourcesHref }: {
  wsId: string; meetingId: string; config: Config; value: Binding[]; onChange: (value: Binding[]) => void; disabled: boolean; resourcesHref: string;
}) {
  const { t } = useT("cockpit"); const kindLabel = useMeetingTemplateKindLabel();
  const [page, setPage] = useState(1); const [editing, setEditing] = useState<string | null>(null);
  const slots = config.slots; const currentPage = Math.min(page, Math.max(1, Math.ceil(slots.length / 25))); const shown = slots.slice((currentPage - 1) * 25, currentPage * 25);
  const configurationRef = useRef<HTMLElement>(null); const focusConfiguration = useRef(false);
  useEffect(() => { if (focusConfiguration.current && configurationRef.current) { focusConfiguration.current = false; configurationRef.current.focus(); configurationRef.current.scrollIntoView?.({ block: "nearest" }); } }, [editing]);
  const selected = slots.find((slot) => slot.slot_id === editing); const binding = value.find((item) => item.slot_id === editing);
  const update = (next: Binding) => onChange(slots.map((slot) => {
    if (slot.slot_id === next.slot_id) return next;
    const old = value.find((item) => item.slot_id === slot.slot_id) ?? emptyMeetingTemplateBinding(slot.slot_id);
    return slot.kind === "preparation_issue" && slot.agenda_slot_id === next.slot_id && next.node_id ? { ...old, project_id: null, module_id: null } : old;
  }));
  return <div className="min-w-0 space-y-3"><p className="text-caption text-muted-foreground">{t(($) => $.meeting_templates.selection_hint)}</p>
    {slots.length > 25 && <CockpitFlowPaging page={currentPage} shown={shown.length} total={slots.length} hasNext={currentPage * 25 < slots.length} busy={false} onPrevious={() => setPage(currentPage - 1)} onNext={() => setPage(currentPage + 1)} />}
    <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border px-3">{shown.map((slot) => {
      const item = value.find((item) => item.slot_id === slot.slot_id) ?? emptyMeetingTemplateBinding(slot.slot_id);
      const parentSelected = !slot.agenda_slot_id || value.some((item) => item.slot_id === slot.agenda_slot_id && item.selected);
      return <li key={slot.slot_id} className="space-y-1 py-3"><div className="flex items-start gap-2"><label className="flex min-w-0 flex-1 items-start gap-2 text-caption"><input type="checkbox" disabled={disabled} checked={item.selected} onChange={(event) => { update(event.target.checked ? { ...item, selected: true } : emptyMeetingTemplateBinding(slot.slot_id)); if (event.target.checked) setEditing(slot.slot_id); }} /><span className="min-w-0"><span className="line-clamp-2 break-words" title={slot.label}>{slot.label || slot.agenda?.title || slot.new_issue?.title}</span><span className="text-micro text-muted-foreground">{kindLabel(slot.kind)}</span></span></label>
        <Button type="button" size="xs" variant="ghost" disabled={!item.selected} onClick={() => setEditing(slot.slot_id)}>{t(($) => $.meeting_templates.configure_item)}</Button></div>
        {item.selected && !parentSelected && <div className="space-y-2 text-caption"><p role="status" className="text-destructive">{t(($) => $.meeting_templates.select_agenda)}</p><Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => {
          const parentIndex = slots.findIndex((candidate) => candidate.kind === "agenda" && candidate.slot_id === slot.agenda_slot_id); if (parentIndex < 0) return;
          const parent = slots[parentIndex]!; update({ ...(value.find((candidate) => candidate.slot_id === parent.slot_id) ?? emptyMeetingTemplateBinding(parent.slot_id)), selected: true });
          focusConfiguration.current = true; setPage(Math.floor(parentIndex / 25) + 1); setEditing(parent.slot_id);
        }}>{t(($) => $.meeting_templates.select_parent)}</Button></div>}
      </li>;
    })}</ul>
    {selected && binding?.selected && <section ref={configurationRef} tabIndex={-1} aria-label={t(($) => $.meeting_templates.configure_item)} className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring space-y-3 rounded-lg border border-border p-3"><h3 className="break-words text-body font-medium">{selected.label || selected.agenda?.title || selected.new_issue?.title}</h3>
      <CockpitTemplateSlotText slot={selected} />
      <BindingFields key={selected.slot_id} wsId={wsId} meetingId={meetingId} kind={selected.kind} value={binding} onChange={update} disabled={disabled} resourcesHref={resourcesHref}
        agendaBinding={selected.agenda_slot_id ? value.find((item) => item.slot_id === selected.agenda_slot_id) : undefined} />
    </section>}
  </div>;
}

function BindingFields({ wsId, meetingId, kind, value, onChange, disabled, resourcesHref, agendaBinding }: {
  wsId: string; meetingId: string; kind: Config["slots"][number]["kind"]; value: Binding; onChange: (value: Binding) => void; disabled: boolean; resourcesHref: string; agendaBinding?: Binding;
}) {
  const { t } = useT("cockpit"); const [cursors, setCursors] = useState([""]);
  const node = useCockpitSelectedNodeIssueOption(kind === "agenda" ? value.node_id ?? "" : agendaBinding?.node_id ?? "");
  const scope = useQuery({ ...cockpitContextOptions(wsId, { projectId: value.project_id, moduleId: value.module_id }), enabled: kind === "preparation_issue" && Boolean(value.project_id || value.module_id) });
  const issue = useQuery({ ...issueDetailOptions(wsId, value.issue_id ?? ""), enabled: kind === "issue_reference" && Boolean(value.issue_id) });
  const material = useQuery({ ...cockpitMeetingArtifactReferencesOptions(wsId, meetingId, { page_size: 25, cursor: cursors.at(-1) || undefined }), enabled: kind === "material_reference" });
  const patch = (next: Partial<Binding>) => { if (!disabled) onChange({ ...value, ...next }); };
  if (kind === "agenda") return <>
    <div className="space-y-1"><p className="text-caption">{t(($) => $.meeting_lifecycle.node)}</p><CockpitNodeIssuePicker disabled={disabled} value={node.option} onUpdate={(node) => patch({ node_id: node?.node_id ?? null })} />
      {value.node_id && <Button type="button" variant="ghost" size="xs" disabled={disabled} onClick={() => patch({ node_id: null })}>{t(($) => $.meeting_lifecycle.clear_node)}</Button>}
      {node.isError && <CockpitFlowError onRetry={() => void node.refetch()} />}
      {value.node_id && !node.isPending && !node.isError && !node.option && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.node_unavailable)}</p>}</div>
    <CockpitReviewerSelect wsId={wsId} value={value.facilitator_user_id ?? ""} disabled={disabled} onChange={(id) => patch({ facilitator_user_id: id || null })} label={t(($) => $.meeting_lifecycle.facilitator)} emptyLabel={t(($) => $.common.unset)} missingLabel={t(($) => $.meeting_lifecycle.facilitator_missing)} />
    {value.facilitator_user_id && <Button variant="ghost" size="xs" disabled={disabled} onClick={() => patch({ facilitator_user_id: null })}>{t(($) => $.meeting_lifecycle.no_facilitator)}</Button>}
  </>;
  if (kind === "preparation_issue") return <>
    {agendaBinding?.node_id ? <div className="space-y-1 text-caption"><p className="break-words">{node.option?.label ?? agendaBinding.node_id}</p>{node.isError && <CockpitFlowError onRetry={() => void node.refetch()} />}<p className="text-muted-foreground">{t(($) => $.meeting_templates.agenda_placement)}</p></div> : <div className="flex flex-wrap gap-2">
      <CockpitScopePicker wsId={wsId} kind="project" projectId={null} selectedId={value.project_id} selectedTitle={scope.data?.scope.project_title ?? ""} label={t(($) => $.binding.project)} emptyLabel={t(($) => $.common.unset)} disabled={disabled} onSelect={(id) => patch({ project_id: id, module_id: null })} />
      <CockpitScopePicker wsId={wsId} kind="module" projectId={value.project_id} selectedId={value.module_id} selectedTitle={scope.data?.scope.module_title ?? ""} label={t(($) => $.binding.module)} emptyLabel={t(($) => $.common.unset)} disabled={disabled || !value.project_id} onSelect={(id) => patch({ module_id: id })} />
      {(scope.isError || Boolean(value.project_id || value.module_id) && scope.isSuccess && !scope.data) && <CockpitFlowError onRetry={() => void scope.refetch()} />}
    </div>}
    <div className="space-y-1"><p className="text-caption">{t(($) => $.task_flow.assignee)}</p><CockpitAssigneePicker wsId={wsId} assigneeType={value.assignee_type} assigneeId={value.assignee_id} disabled={disabled} onUpdate={(update) => patch(update)} />
      {value.assignee_id && <Button variant="ghost" size="xs" disabled={disabled} onClick={() => patch({ assignee_type: null, assignee_id: null })}>{t(($) => $.workflow.unassigned)}</Button>}</div>
    <label className="block space-y-1 text-caption">{t(($) => $.task_flow.due_date)}<Input type="date" value={value.due_date ?? ""} disabled={disabled} onChange={(event) => patch({ due_date: event.target.value || null })} /></label>
    <p className="text-caption text-muted-foreground">{t(($) => $.meeting_templates.backlog_hint)}</p>
  </>;
  if (kind === "issue_reference") return <>
    <CockpitIssueChoice wsId={wsId} selected={issue.data ?? null} disabled={disabled} onSelect={(item) => patch({ issue_id: item.id })} />
    {(issue.isError || Boolean(value.issue_id) && issue.isSuccess && !issue.data) && <CockpitFlowError onRetry={() => void issue.refetch()} />}
    {value.issue_id && <Button variant="ghost" size="xs" disabled={disabled} onClick={() => patch({ issue_id: null })}>{t(($) => $.common.unset)}</Button>}
  </>;
  const page = material.data;
  return <div className="space-y-3"><p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.fixed_hint)}</p>
    <AppLink target="_blank" rel="noopener noreferrer" href={resourcesHref} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.meeting_lifecycle.open_materials)} {t(($) => $.action_flow.new_tab)}</AppLink>
    {material.isPending ? <Spinner /> : material.isError || !page ? <CockpitFlowError onRetry={() => void material.refetch()} /> : <>
      <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={material.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      <ul className="max-h-64 space-y-1 overflow-y-auto">{page.items.map((item) => <li key={item.id}><Button variant={value.material_reference_id === item.id ? "secondary" : "ghost"} aria-pressed={value.material_reference_id === item.id} disabled={disabled} className="h-auto w-full flex-wrap justify-start whitespace-normal text-left" onClick={() => patch({ material_reference_id: item.id })}><span className="line-clamp-2 break-words">{item.artifact_title} · {t(($) => $.workflow.version, { number: item.version_number })}</span><ArtifactStatus status={item.version_decision ?? "unknown"} /></Button></li>)}</ul>
      {page.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.artifact_runtime.no_references)}</p>}
    </>}
    {cursors.length > 1 && <Button variant="outline" size="sm" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
    {value.material_reference_id && <p className="break-words text-caption">{t(($) => $.meeting_lifecycle.selected_material, { name: page?.items.find((item) => item.id === value.material_reference_id)?.artifact_title ?? value.material_reference_id })}</p>}
  </div>;
}
