"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cockpitObjectPath, cockpitAgendaReferencesOptions, cockpitMeetingArtifactReferencesOptions, cockpitMeetingAgendaDraftKey, cockpitArtifactPath, EMPTY_COCKPIT_SCOPE, cockpitContextOptions, useCockpitAssigneeAvailability, useCockpitMeetingAgendaDraftStore, setCockpitMeetingFormDraft, clearCockpitMeetingFormDraft, type CockpitMeetingFormDraft } from "@multica/core/cockpit";
import type { CockpitAgendaDetail, CockpitAgendaReferenceView, CockpitPreparationIssueInput, Issue } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { issueDetailOptions } from "@multica/core/issues";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { useStatusLabel } from "../../issues/utils/status-label";
import { CockpitFlowError, CockpitFlowPaging, CockpitIssueChoice } from "./cockpit-task-flow";
import { CockpitMeetingCommandRecovery } from "./cockpit-meeting-command-recovery";
import { useCockpitMeetingCommand } from "./use-cockpit-meeting-command";
import { ArtifactStatus } from "./cockpit-artifact-status";
import { CockpitAssigneePicker } from "./cockpit-assignee-picker";
import { CockpitScopePicker } from "./cockpit-scope-control";
import { useCockpitSelectedNodeIssueOption } from "./cockpit-node-issue-picker";
import { createSafeId } from "@multica/core/utils";

export function CockpitAgendaReferences({ wsId, meetingId, agenda, resourcesHref, readOnly, canAddPreparation }: { wsId: string; meetingId: string; agenda: CockpitAgendaDetail; resourcesHref: string; readOnly?: boolean; canAddPreparation?: boolean }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const status = useStatusLabel(wsId); const client = useQueryClient();
  const [cursors, setCursors] = useState([""]); const [removed, setRemoved] = useState(false); const [mode, setMode] = useState<"issue" | "artifact_reference" | "create" | null>(null);
  const dialogBusy = useRef(false);
  const query = useQuery(cockpitAgendaReferencesOptions(wsId, meetingId, agenda.id, { include_removed: removed, cursor: cursors.at(-1) || undefined, page_size: 25 })); const page = query.data;
  const commands = useCockpitMeetingAgendaDraftStore((state) => state.draft.commands);
  const hasPending = (kind: "create" | "issue" | "artifact_reference") => Boolean(commands[cockpitMeetingAgendaDraftKey(wsId, meetingId, kind === "create" ? `preparation:${agenda.id}` : `attach:${agenda.id}:${kind}`)]);
  const writable = !readOnly && agenda.can_edit && !agenda.removed_at;
  const refresh = async () => { await client.invalidateQueries({ queryKey: cockpitAgendaReferencesOptions(wsId, meetingId, agenda.id, { include_removed: removed, page_size: 25 }).queryKey }); setCursors([""]); };
  return <section aria-label={t(($) => $.meeting_lifecycle.references)} className="space-y-3 rounded-lg border border-border p-3">
    <h3 className="text-body font-medium">{t(($) => $.meeting_lifecycle.references)}</h3>
    <Dialog open={mode !== null} onOpenChange={(open) => { if (!open && !dialogBusy.current) setMode(null); }}><div className="flex flex-wrap gap-2">
      <DialogTrigger render={<Button size="sm" disabled={(!writable || canAddPreparation === false) && !hasPending("create")} />} onClick={() => setMode("create")}>{t(($) => $.meeting_lifecycle.create_preparation)}</DialogTrigger>
      <DialogTrigger render={<Button size="sm" variant="outline" disabled={(!writable || canAddPreparation === false) && !hasPending("issue")} />} onClick={() => setMode("issue")}>{t(($) => $.meeting_lifecycle.attach_issue)}</DialogTrigger>
      <DialogTrigger render={<Button size="sm" variant="outline" disabled={(!writable || canAddPreparation === false) && !hasPending("artifact_reference")} />} onClick={() => setMode("artifact_reference")}>{t(($) => $.meeting_lifecycle.attach_artifact)}</DialogTrigger>
    </div>{mode === "create" ? <CockpitPreparationIssueForm key={`${agenda.id}:create`} wsId={wsId} meetingId={meetingId} agenda={agenda} canAddPreparation={canAddPreparation} onDone={() => setMode(null)} onBusyChange={(busy) => { dialogBusy.current = busy; }} />
      : mode && <CockpitAgendaAttachForm key={`${agenda.id}:${mode}`} wsId={wsId} meetingId={meetingId} agenda={agenda} kind={mode} resourcesHref={resourcesHref} canAddPreparation={canAddPreparation} onDone={() => setMode(null)} onBusyChange={(busy) => { dialogBusy.current = busy; }} />}</Dialog>
    <label className="flex items-center gap-2 text-caption"><input type="checkbox" checked={removed} onChange={(event) => { setRemoved(event.target.checked); setCursors([""]); }} />{t(($) => $.artifact_runtime.include_removed)}</label>
    {query.isPending ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
      <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      <ul className="max-h-80 divide-y divide-border overflow-y-auto">{page.items.map((item) => {
        const href = item.kind === "issue" && item.issue ? paths.issueDetail(item.issue.identifier || item.issue.id) : item.kind === "artifact_reference" && item.artifact_id && item.version_id ? cockpitArtifactPath(paths.cockpit(), item.artifact_id, EMPTY_COCKPIT_SCOPE, item.version_id) : null;
        return <li key={item.id} className="space-y-2 py-3 text-caption"><div className="flex items-start gap-2">{href ? <AppLink target="_blank" rel="noopener noreferrer" href={href} className="line-clamp-2 min-w-0 flex-1 break-words text-primary hover:underline" title={item.label}>{item.label} {t(($) => $.action_flow.new_tab)}</AppLink> : <p className="line-clamp-2 min-w-0 flex-1 break-words" title={item.label}>{item.label || item.target_id}</p>}
          <CockpitAgendaUnlink wsId={wsId} meetingId={meetingId} agenda={agenda} reference={item} disabled={!writable} /></div>
          <p className="text-muted-foreground">{item.purpose === "preparation" ? t(($) => $.meeting_lifecycle.preparation) : item.purpose === "material" ? t(($) => $.meeting_lifecycle.material) : item.purpose}{item.issue && <> · {status(item.issue.status)} · {item.issue.assignee_name || t(($) => $.workflow.unassigned)}</>}{item.version_number !== null && <> · {t(($) => $.workflow.version, { number: item.version_number })}</>}</p>
          {item.kind === "artifact_reference" && <ArtifactStatus status={item.version_decision ?? "unknown"} />}
          {!item.available && <p role="status" className="text-muted-foreground">{t(($) => $.meeting_lifecycle.unavailable)}</p>}{item.removed_at && <p className="text-muted-foreground">{t(($) => $.artifact_runtime.reference_removed)}</p>}
        </li>;
      })}</ul>{page.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.references_empty)}</p>}
    </>}
    {cursors.length > 1 && <Button size="sm" variant="outline" onClick={() => void refresh()}>{t(($) => $.task_flow.first_page)}</Button>}
  </section>;
}

function CockpitAgendaAttachForm({ wsId, meetingId, agenda, kind, resourcesHref, canAddPreparation, onDone, onBusyChange }: { wsId: string; meetingId: string; agenda: CockpitAgendaDetail; kind: "issue" | "artifact_reference"; resourcesHref: string; canAddPreparation?: boolean; onDone: () => void; onBusyChange: (busy: boolean) => void }) {
  const { t } = useT("cockpit"); const command = useCockpitMeetingCommand(wsId, meetingId, cockpitMeetingAgendaDraftKey(wsId, meetingId, `attach:${agenda.id}:${kind}`));
  useEffect(() => { onBusyChange(command.busy); return () => onBusyChange(false); }, [command.busy, onBusyChange]);
  const original = command.pending?.kind === "reference_attach" ? command.pending : null;
  const formKey = cockpitMeetingAgendaDraftKey(wsId, meetingId, `attach-form:${agenda.id}:${kind}`);
  const [initial] = useState<Extract<CockpitMeetingFormDraft, { kind: "reference" }>>(() => ({ kind: "reference", referenceKind: kind, observedRevision: original?.body.expected_revision ?? agenda.revision, targetId: original?.body.target_id ?? "", purpose: original?.body.purpose ?? (kind === "issue" ? "preparation" : "material") }));
  const stored = useCockpitMeetingAgendaDraftStore((state) => state.draft.forms[formKey]); const value = stored?.kind === "reference" ? stored : initial;
  const { observedRevision: revision, targetId: target, purpose } = value;
  const change = (patch: Partial<typeof value>) => setCockpitMeetingFormDraft(formKey, { ...value, ...patch });
  const [issue, setIssue] = useState<Issue | null>(null); const [cursors, setCursors] = useState([""]);
  const selectedIssue = useQuery({ ...issueDetailOptions(wsId, target), enabled: kind === "issue" && Boolean(target) });
  const fixed = useQuery({ ...cockpitMeetingArtifactReferencesOptions(wsId, meetingId, { page_size: 25, cursor: cursors.at(-1) || undefined }), enabled: kind === "artifact_reference" }); const page = fixed.data;
  const changed = revision !== agenda.revision; const locked = command.busy || Boolean(original);
  const save = async () => { if (command.busy || !original && (!target || changed || !agenda.can_edit || canAddPreparation === false || Boolean(agenda.removed_at))) return;
    setCockpitMeetingFormDraft(formKey, value);
    const response = await command.run(original ?? { kind: "reference_attach", agendaId: agenda.id, body: { command_key: createSafeId(), expected_revision: revision, kind, target_id: target, purpose } }); if (response) { clearCockpitMeetingFormDraft(formKey, value); if (response.stillCurrent()) onDone(); } };
  return <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{kind === "issue" ? t(($) => $.meeting_lifecycle.attach_issue) : t(($) => $.meeting_lifecycle.attach_artifact)}</DialogTitle></DialogHeader>
    {kind === "issue" ? <CockpitIssueChoice wsId={wsId} selected={selectedIssue.data ?? issue} disabled={locked} onSelect={(value) => { setIssue(value); change({ targetId: value.id }); }} /> : <div className="space-y-3">
      <p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.fixed_hint)}</p><AppLink target="_blank" rel="noopener noreferrer" href={resourcesHref} className={buttonVariants({ size: "sm", variant: "outline" })}>{t(($) => $.meeting_lifecycle.open_materials)} {t(($) => $.action_flow.new_tab)}</AppLink>
      {fixed.isPending ? <Spinner /> : fixed.isError || !page ? <CockpitFlowError onRetry={() => void fixed.refetch()} /> : <>
        <ul className="max-h-64 space-y-1 overflow-y-auto">{page.items.map((item) => <li key={item.id}><Button variant={target === item.id ? "secondary" : "ghost"} aria-pressed={target === item.id} disabled={locked} className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => change({ targetId: item.id })}><span className="line-clamp-2 break-words">{item.artifact_title} · {t(($) => $.workflow.version, { number: item.version_number })}</span>{" "}<ArtifactStatus status={item.version_decision ?? "unknown"} /></Button></li>)}</ul>
        {page.items.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.artifact_runtime.no_references)}</p>}
        <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={fixed.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      </>}{!page && cursors.length > 1 && <Button variant="outline" size="sm" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
      {target && <p className="break-all text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.selected_material, { name: page?.items.find((item) => item.id === target)?.artifact_title ?? target })}</p>}
    </div>}
    <fieldset disabled={locked} className="flex flex-wrap gap-3"><legend className="mb-2 text-caption">{t(($) => $.meeting_lifecycle.purpose)}</legend>{(kind === "issue" ? ["preparation", "material"] as const : ["material"] as const).map((value) => <label key={value} className="flex items-center gap-2 text-caption"><input type="radio" name="agenda-reference-purpose" checked={purpose === value} onChange={() => change({ purpose: value })} />{t(($) => $.meeting_lifecycle[value])}</label>)}</fieldset>
    {changed && !original && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.changed)}</p><Button variant="outline" size="sm" onClick={() => change({ observedRevision: agenda.revision })}>{t(($) => $.meeting_lifecycle.rebase)}</Button></div>}<CockpitMeetingCommandRecovery command={command} onConfirmed={() => clearCockpitMeetingFormDraft(formKey, value)} onCurrentConfirmed={onDone} />
    {command.error && <p role="alert" className="break-words text-caption text-destructive">{command.error}</p>}
    <DialogFooter><DialogClose render={<Button variant="outline" disabled={command.busy} />}>{t(($) => $.task_create.cancel)}</DialogClose><Button onClick={() => void save()} disabled={command.busy || !original && (!target || changed || !agenda.can_edit || canAddPreparation === false || Boolean(agenda.removed_at))}>{original ? t(($) => $.meeting_lifecycle.retry_command) : t(($) => $.meeting_lifecycle.attach)}</Button></DialogFooter>
  </DialogContent>;
}

function CockpitAgendaUnlink({ wsId, meetingId, agenda, reference, disabled }: { wsId: string; meetingId: string; agenda: CockpitAgendaDetail; reference: CockpitAgendaReferenceView; disabled: boolean }) {
  const { t } = useT("cockpit"); const command = useCockpitMeetingCommand(wsId, meetingId, cockpitMeetingAgendaDraftKey(wsId, meetingId, `unlink:${reference.id}`));
  const [open, setOpen] = useState(false); const [revision, setRevision] = useState(agenda.revision);
  const save = async () => { if (command.busy || !command.pending && (disabled || !reference.can_remove || revision !== agenda.revision)) return;
    const response = await command.run(command.pending ?? { kind: "reference_remove", agendaId: agenda.id, referenceId: reference.id, body: { command_key: createSafeId(), expected_revision: revision } }); if (response?.stillCurrent()) setOpen(false); };
  return <Dialog open={open} onOpenChange={(value) => { if (value || !command.busy) setOpen(value); if (value) setRevision(agenda.revision); }}><DialogTrigger render={<Button variant="ghost" size="xs" disabled={!command.pending && (disabled || !reference.can_remove || Boolean(reference.removed_at))} />}>{t(($) => $.meeting_lifecycle.unlink)}</DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>{t(($) => $.meeting_lifecycle.unlink)}</DialogTitle><DialogDescription>{reference.label}</DialogDescription></DialogHeader>
      {revision !== agenda.revision && !command.pending && <p role="alert" className="text-caption">{t(($) => $.meeting_lifecycle.changed)}</p>}{command.error && <p role="alert" className="break-words text-caption text-destructive">{command.error}</p>}
      <CockpitMeetingCommandRecovery command={command} onCurrentConfirmed={() => setOpen(false)} />
      <DialogFooter><DialogClose render={<Button variant="outline" disabled={command.busy} />}>{t(($) => $.task_create.cancel)}</DialogClose><Button variant="destructive" disabled={command.busy || !command.pending && revision !== agenda.revision} onClick={() => void save()}>{command.pending ? t(($) => $.meeting_lifecycle.retry_command) : t(($) => $.meeting_lifecycle.unlink)}</Button></DialogFooter>
    </DialogContent></Dialog>;
}

function CockpitPreparationIssueForm({ wsId, meetingId, agenda, canAddPreparation, onDone, onBusyChange }: { wsId: string; meetingId: string; agenda: CockpitAgendaDetail; canAddPreparation?: boolean; onDone: () => void; onBusyChange: (busy: boolean) => void }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const { t: issueT } = useT("issues"); const command = useCockpitMeetingCommand(wsId, meetingId, cockpitMeetingAgendaDraftKey(wsId, meetingId, `preparation:${agenda.id}`));
  useEffect(() => { onBusyChange(command.busy); return () => onBusyChange(false); }, [command.busy, onBusyChange]);
  const original = command.pending?.kind === "preparation_issue_create" ? command.pending : null;
  const formKey = cockpitMeetingAgendaDraftKey(wsId, meetingId, `preparation-form:${agenda.id}`);
  const [initial] = useState<Extract<CockpitMeetingFormDraft, { kind: "preparation" }>>(() => ({ kind: "preparation", observedRevision: original?.body.expected_revision ?? agenda.revision, primaryNodeId: original ? original.body.primary_node_id : agenda.node_id,
    fields: original?.body.new_issue ?? { title: "", description: "", assignee_type: null, assignee_id: null, priority: "none", due_date: null, project_id: null, module_id: null } }));
  const stored = useCockpitMeetingAgendaDraftStore((state) => state.draft.forms[formKey]); const value = stored?.kind === "preparation" ? stored : initial;
  const { observedRevision: revision, fields } = value;
  const setFields = (fields: CockpitPreparationIssueInput["new_issue"]) => setCockpitMeetingFormDraft(formKey, { ...value, fields });
  const selectedNodeId = original ? original.body.primary_node_id : value.primaryNodeId;
  const node = useCockpitSelectedNodeIssueOption(selectedNodeId ?? ""); const selectedScope = useQuery({ ...cockpitContextOptions(wsId, { projectId: fields.project_id, moduleId: fields.module_id }), enabled: !selectedNodeId && Boolean(fields.project_id || fields.module_id) });
  const assignee = useCockpitAssigneeAvailability(wsId, fields.assignee_type, fields.assignee_id);
  const changed = revision !== agenda.revision || value.primaryNodeId !== agenda.node_id; const locked = command.busy || Boolean(original);
  const invalidPlacement = selectedNodeId ? node.isPending || node.isFetching || node.isError || !node.option : Boolean(fields.project_id || fields.module_id) && (selectedScope.isPending || selectedScope.isFetching || selectedScope.isError || !selectedScope.data);
  const invalidAssignee = Boolean(fields.assignee_id) && !assignee.available;
  const invalid = !fields.title.trim() || changed || invalidPlacement || invalidAssignee || !agenda.can_edit || canAddPreparation === false || Boolean(agenda.removed_at);
  const save = async () => { if (command.busy || !original && invalid) return;
    setCockpitMeetingFormDraft(formKey, value);
    const response = await command.run(original ?? { kind: "preparation_issue_create", agendaId: agenda.id, body: { command_key: createSafeId(), expected_revision: revision, primary_node_id: selectedNodeId,
      new_issue: { ...fields, title: fields.title.trim(), project_id: selectedNodeId ? node.option?.project_id ?? null : fields.project_id, module_id: selectedNodeId ? node.option?.module_id ?? null : fields.module_id } } }); if (response) { clearCockpitMeetingFormDraft(formKey, value); if (response.stillCurrent()) onDone(); } };
  return <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{t(($) => $.meeting_lifecycle.create_preparation)}</DialogTitle><DialogDescription>{t(($) => $.meeting_lifecycle.create_hint)}</DialogDescription></DialogHeader>
    <label className="space-y-1 text-caption">{t(($) => $.task_flow.title)}<Input value={fields.title} disabled={locked} onChange={(event) => setFields({ ...fields, title: event.target.value })} /></label>
    <label className="space-y-1 text-caption">{t(($) => $.task_flow.description)}<Textarea className="max-h-56 resize-y overflow-y-auto" value={fields.description} disabled={locked} onChange={(event) => setFields({ ...fields, description: event.target.value })} /></label>
    {selectedNodeId ? <div className="space-y-1 text-caption"><p className="break-words">{node.option?.label || (selectedNodeId === agenda.node_id ? `${agenda.node_code} ${agenda.node_title}`.trim() : selectedNodeId)}</p>{!node.isPending && !node.option && <p className="text-muted-foreground">{t(($) => $.meeting_lifecycle.node_unavailable)}</p>}<AppLink target="_blank" rel="noopener noreferrer" className="text-primary underline" href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: selectedNodeId, view: "details" }, EMPTY_COCKPIT_SCOPE)}>{t(($) => $.meeting_lifecycle.repair_node)} {t(($) => $.action_flow.new_tab)}</AppLink></div> : <div className="flex flex-wrap gap-2">
      <CockpitScopePicker wsId={wsId} kind="project" projectId={null} selectedId={fields.project_id} selectedTitle={selectedScope.data?.scope.project_title ?? ""} label={t(($) => $.binding.project)} emptyLabel={t(($) => $.common.unset)} disabled={locked} onSelect={(id) => setFields({ ...fields, project_id: id, module_id: null })} />
      <CockpitScopePicker wsId={wsId} kind="module" projectId={fields.project_id} selectedId={fields.module_id} selectedTitle={selectedScope.data?.scope.module_title ?? ""} label={t(($) => $.binding.module)} emptyLabel={t(($) => $.common.unset)} disabled={locked || !fields.project_id} onSelect={(id) => setFields({ ...fields, module_id: id })} />
    </div>}
    {(node.isError || !selectedNodeId && selectedScope.isError) && <CockpitFlowError onRetry={() => { if (selectedNodeId) void node.refetch(); else void selectedScope.refetch(); }} />}
    <div className="space-y-1"><p className="text-caption">{t(($) => $.task_flow.assignee)}</p><CockpitAssigneePicker wsId={wsId} assigneeType={fields.assignee_type} assigneeId={fields.assignee_id} disabled={locked} onUpdate={(value) => setFields({ ...fields, ...value })} />
      {fields.assignee_id && <Button size="xs" variant="ghost" disabled={locked} onClick={() => setFields({ ...fields, assignee_type: null, assignee_id: null })}>{t(($) => $.workflow.unassigned)}</Button>}</div>
    <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-caption">{t(($) => $.task_flow.due_date)}<Input type="date" value={fields.due_date ?? ""} disabled={locked} onChange={(event) => setFields({ ...fields, due_date: event.target.value || null })} /></label>
      <label className="space-y-1 text-caption">{t(($) => $.task_flow.priority)}<Select value={fields.priority} disabled={locked} items={(["none", "low", "medium", "high", "urgent"] as const).map((value) => ({ value, label: issueT(($) => $.priority[value]) }))} onValueChange={(value) => { if (value === "none" || value === "low" || value === "medium" || value === "high" || value === "urgent") setFields({ ...fields, priority: value }); }}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{(["none", "low", "medium", "high", "urgent"] as const).map((value) => <SelectItem key={value} value={value}>{issueT(($) => $.priority[value])}</SelectItem>)}</SelectContent></Select></label></div>
    {changed && !original && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.changed)}</p><p>{agenda.node_code} {agenda.node_title}</p><Button variant="outline" size="sm" onClick={() => setCockpitMeetingFormDraft(formKey, { ...value, observedRevision: agenda.revision, primaryNodeId: agenda.node_id })}>{t(($) => $.meeting_lifecycle.rebase)}</Button></div>}<CockpitMeetingCommandRecovery command={command} onConfirmed={() => clearCockpitMeetingFormDraft(formKey, value)} onCurrentConfirmed={onDone} />{command.error && <p role="alert" className="break-words text-caption text-destructive">{command.error}</p>}
    <DialogFooter><DialogClose render={<Button variant="outline" disabled={command.busy} />}>{t(($) => $.task_create.cancel)}</DialogClose><Button onClick={() => void save()} disabled={command.busy || !original && invalid}>{original ? t(($) => $.meeting_lifecycle.retry_command) : t(($) => $.meeting_lifecycle.create_preparation)}</Button></DialogFooter>
  </DialogContent>;
}
