"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cockpitMeetingTemplatesOptions, cockpitMeetingTemplateOptions, cockpitMeetingTemplateVersionsOptions, cockpitMeetingTemplateVersionOptions,
  cockpitMeetingTemplateCommandOptions, useSaveCockpitMeetingTemplate, cockpitMeetingTemplateAcknowledged, invalidateCockpitMeetingPreparationFacts,
  cockpitMeetingPreparationDraftKey, useCockpitMeetingPreparationDraftStore, parseCockpitTemplateEditorDraft,
  setCockpitPreparationForm, clearCockpitPreparationForm, type CockpitTemplateEditorDraft,
} from "@multica/core/cockpit";
import type { CockpitMeetingTemplateHeader, CockpitMeetingTemplateVersionDetail } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";
import { CockpitMeetingTemplateFields, CockpitTemplateSlotText, useMeetingTemplateKindLabel } from "./cockpit-meeting-template-fields";
import { useCockpitPreparationRequest } from "./use-cockpit-preparation-request";

export function CockpitMeetingTemplates({ wsId, readOnly, onSelect }: {
  wsId: string; readOnly?: boolean; onSelect?: (template: CockpitMeetingTemplateHeader, version: CockpitMeetingTemplateVersionDetail) => void;
}) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false); const busy = useRef(false);
  return <Dialog open={open} onOpenChange={(next) => { if (next || !busy.current) setOpen(next); }}><DialogTrigger render={<Button variant="outline" size="sm" />}>{onSelect ? t(($) => $.meeting_templates.use) : t(($) => $.meeting_templates.title)}</DialogTrigger>
    {open && <DialogContent className="flex max-h-[88dvh] flex-col overflow-hidden sm:max-w-3xl"><DialogHeader><DialogTitle>{t(($) => $.meeting_templates.title)}</DialogTitle></DialogHeader>
      <div className="min-h-0 overflow-y-auto overscroll-contain"><CockpitMeetingTemplateBrowser wsId={wsId} readOnly={readOnly} onBusy={(value) => { busy.current = value; }} onSelect={onSelect ? (template, version) => { setOpen(false); onSelect(template, version); } : undefined} /></div>
    </DialogContent>}
  </Dialog>;
}

export function CockpitMeetingTemplateBrowser({ wsId, readOnly, onBusy, onSelect }: {
  wsId: string; readOnly?: boolean; onBusy: (busy: boolean) => void; onSelect?: (template: CockpitMeetingTemplateHeader, version: CockpitMeetingTemplateVersionDetail) => void;
}) {
  const { t } = useT("cockpit"); const [text, setText] = useState(""); const q = useCockpitSearch(text); const [inactive, setInactive] = useState(false);
  const [cursors, setCursors] = useState([""]); const [selected, setSelected] = useState<string | null>(null); const [create, setCreate] = useState(false);
  const query = useQuery(cockpitMeetingTemplatesOptions(wsId, { q, include_inactive: inactive, cursor: cursors.at(-1) || undefined, page_size: 25 })); const page = query.data;
  const newKey = cockpitMeetingPreparationDraftKey(wsId, "template", "new");
  const pendingCreate = useCockpitMeetingPreparationDraftStore((state) => state.draft.commands[newKey]);
  if (create) return <TemplateEditor wsId={wsId} templateId={null} readOnly={readOnly || page?.can_create !== true} onBusy={onBusy} onBack={() => setCreate(false)} onSaved={(id) => { setCreate(false); setSelected(id); }} />;
  if (selected) return <TemplateReader key={selected} wsId={wsId} templateId={selected} readOnly={readOnly} onBusy={onBusy} onBack={() => setSelected(null)} onSelect={onSelect} />;
  return <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-caption text-muted-foreground">{t(($) => $.meeting_templates.workspace_shared)}</p>
    {(pendingCreate || !readOnly && page?.can_create) && <Button size="sm" onClick={() => setCreate(true)}>{pendingCreate ? t(($) => $.meeting_templates.resume_draft) : t(($) => $.meeting_templates.new)}</Button>}</div>
    <label className="block space-y-1 text-caption">{t(($) => $.meeting_templates.search)}<Input name="meeting-template-search" autoComplete="off" value={text} onChange={(event) => { setText(event.target.value); setCursors([""]); }} /></label>
    <label className="flex items-center gap-2 text-caption"><input type="checkbox" checked={inactive} onChange={(event) => { setInactive(event.target.checked); setCursors([""]); }} />{t(($) => $.meeting_templates.show_inactive)}</label>
    {query.isPending || q !== text.trim() ? <Spinner /> : query.isError || !page ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <>
      <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      <ul className="max-h-[48vh] divide-y divide-border overflow-y-auto">{page.items.map((item) => <li key={item.id} className="py-2"><Button variant="ghost" className="h-auto w-full flex-col items-start gap-1 whitespace-normal text-left" onClick={() => setSelected(item.id)}><span className="line-clamp-2 break-words font-medium" title={item.title}>{item.title}</span><span className="text-caption text-muted-foreground">{t(($) => $.workflow.version, { number: item.current_version.number })} · {t(($) => $.meeting_templates.slot_total, { count: item.current_version.slot_count })}{!item.active && <> · {t(($) => $.meeting_templates.inactive)}</>}</span></Button></li>)}</ul>
      {page.items.length === 0 && <p className="text-caption text-muted-foreground">{q ? t(($) => $.task_flow.no_matches) : t(($) => $.meeting_templates.empty)}</p>}
    </>}
    {cursors.length > 1 && <Button size="sm" variant="outline" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}
  </section>;
}

function TemplateReader({ wsId, templateId, readOnly, onBusy, onBack, onSelect }: {
  wsId: string; templateId: string; readOnly?: boolean; onBusy: (busy: boolean) => void; onBack: () => void;
  onSelect?: (template: CockpitMeetingTemplateHeader, version: CockpitMeetingTemplateVersionDetail) => void;
}) {
  const { t } = useT("cockpit"); const kindLabel = useMeetingTemplateKindLabel(); const [edit, setEdit] = useState(false);
  const [history, setHistory] = useState(false); const [cursors, setCursors] = useState([""]); const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [slotPage, setSlotPage] = useState(1);
  const header = useQuery(cockpitMeetingTemplateOptions(wsId, templateId)); const template = header.data;
  const version = useQuery({ ...cockpitMeetingTemplateVersionOptions(wsId, templateId, selectedVersion ?? template?.current_version.id ?? ""), enabled: Boolean(selectedVersion || template?.current_version.id) }); const detail = version.data;
  const versions = useQuery({ ...cockpitMeetingTemplateVersionsOptions(wsId, templateId, { cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: history });
  const pending = useCockpitMeetingPreparationDraftStore((state) => state.draft.commands[cockpitMeetingPreparationDraftKey(wsId, "template", templateId)]);
  if (edit) return <TemplateEditor wsId={wsId} templateId={templateId} readOnly={readOnly} onBusy={onBusy} onBack={() => setEdit(false)} onSaved={() => { setEdit(false); setSelectedVersion(null); }} />;
  const known = detail ? parseCockpitTemplateEditorDraft({ kind: "template", observedRevision: template?.revision ?? 0, title: detail.title, description: detail.description, active: detail.active, config: detail.config }) : null;
  return <section className="space-y-3"><Button variant="outline" size="sm" onClick={onBack}>{t(($) => $.meeting_templates.back)}</Button>
    {header.isPending ? <Spinner /> : header.isError || !template ? <CockpitFlowError onRetry={() => void header.refetch()} /> : <>
      <h3 className="line-clamp-3 break-words text-title-sm font-medium" title={template.title}>{template.title}</h3>
      <div className="flex flex-wrap gap-2">{(pending || template.can_edit && !readOnly) && <Button variant="outline" size="sm" onClick={() => setEdit(true)}>{pending ? t(($) => $.meeting_templates.resume_draft) : t(($) => $.meeting_templates.edit)}</Button>}
        <Button variant="ghost" size="sm" onClick={() => setHistory(!history)} aria-expanded={history}>{t(($) => $.workflow.version_history)}</Button></div>
      {history && <section className="space-y-2 rounded-md border border-border p-3">{versions.isPending ? <Spinner /> : versions.isError || !versions.data ? <CockpitFlowError onRetry={() => void versions.refetch()} /> : <>
        <CockpitFlowPaging page={cursors.length} shown={versions.data.items.length} total={versions.data.total} hasNext={Boolean(versions.data.next_cursor)} busy={versions.isFetching} onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (versions.data?.next_cursor) setCursors([...cursors, versions.data.next_cursor]); }} />
        <ul className="max-h-48 overflow-y-auto">{versions.data.items.map((item) => <li key={item.id}><Button variant={detail?.id === item.id ? "secondary" : "ghost"} aria-pressed={detail?.id === item.id} className="h-auto w-full justify-start whitespace-normal text-left" onClick={() => { setSelectedVersion(item.id); setSlotPage(1); }}>{t(($) => $.workflow.version, { number: item.number })} · <span className="line-clamp-2 break-words">{item.title}</span></Button></li>)}</ul>
      </>}{cursors.length > 1 && <Button size="sm" variant="outline" onClick={() => setCursors([""])}>{t(($) => $.task_flow.first_page)}</Button>}</section>}
      {version.isPending ? <Spinner /> : version.isError || !detail ? <CockpitFlowError onRetry={() => void version.refetch()} /> : <>
        <p className="text-caption text-muted-foreground">{t(($) => $.workflow.version, { number: detail.number })}{detail.id !== template.current_version.id && <> · {t(($) => $.meeting_templates.historical)}</>}</p>
        {detail.description && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-caption">{detail.description}</p>}
        {!known && <p role="status" className="text-caption text-muted-foreground">{t(($) => $.meeting_templates.unsupported)}</p>}
        {detail.config.slots.length > 25 && <CockpitFlowPaging page={slotPage} shown={detail.config.slots.slice((slotPage - 1) * 25, slotPage * 25).length} total={detail.config.slots.length} hasNext={slotPage * 25 < detail.config.slots.length} busy={false} onPrevious={() => setSlotPage(slotPage - 1)} onNext={() => setSlotPage(slotPage + 1)} />}
        <ul className="max-h-72 divide-y divide-border overflow-y-auto">{detail.config.slots.slice((slotPage - 1) * 25, slotPage * 25).map((slot) => <li key={slot.slot_id} className="space-y-1 py-2 text-caption"><p className="line-clamp-2 break-words" title={slot.label}>{slot.label}</p><p className="text-muted-foreground">{kindLabel(slot.kind)}</p><CockpitTemplateSlotText slot={slot} /></li>)}</ul>
        {onSelect && <Button disabled={readOnly || !template.active || !detail.active || !known} onClick={() => onSelect(template, detail)}>{t(($) => $.meeting_templates.use_version, { number: detail.number })}</Button>}
      </>}
    </>}
  </section>;
}

function TemplateEditor({ wsId, templateId, readOnly, onBusy, onBack, onSaved }: {
  wsId: string; templateId: string | null; readOnly?: boolean; onBusy: (busy: boolean) => void; onBack: () => void; onSaved: (id: string) => void;
}) {
  const { t } = useT("cockpit"); const client = useQueryClient(); const key = cockpitMeetingPreparationDraftKey(wsId, "template", templateId ?? "new");
  const request = useCockpitPreparationRequest(key); const mutation = useSaveCockpitMeetingTemplate(wsId, templateId);
  const pending = request.pending?.kind === "template" ? request.pending : null;
  const header = useQuery({ ...cockpitMeetingTemplateOptions(wsId, templateId ?? ""), enabled: Boolean(templateId) });
  const version = useQuery({ ...cockpitMeetingTemplateVersionOptions(wsId, templateId ?? "", header.data?.current_version.id ?? ""), enabled: Boolean(templateId && header.data?.current_version.id) });
  const stored = useCockpitMeetingPreparationDraftStore((state) => state.draft.forms[key]);
  const initial = parseCockpitTemplateEditorDraft(pending ? { kind: "template", observedRevision: pending.body.expected_revision, ...pending.body }
    : templateId ? version.data && { kind: "template", observedRevision: header.data?.revision ?? 0, title: version.data.title, description: version.data.description, active: version.data.active, config: version.data.config }
      : { kind: "template", observedRevision: 0, title: "", description: "", active: true, config: { schema_version: 1, slots: [] } });
  const value = stored?.kind === "template" ? stored : initial;
  useEffect(() => { onBusy(request.busy); return () => onBusy(false); }, [request.busy, onBusy]);
  const unknown = Boolean(templateId && version.data && !parseCockpitTemplateEditorDraft({ kind: "template", observedRevision: header.data?.revision ?? 0, title: version.data.title, description: version.data.description, active: version.data.active, config: version.data.config }));
  const writable = !readOnly && (!templateId || !header.isError && !header.isPending && Boolean(header.data?.can_edit)) && !unknown;
  const changed = Boolean(templateId && value && value.observedRevision !== header.data?.revision);
  const invalid = !value || !validTemplate(value);
  const save = async () => {
    if (!value || request.busy || pending && (!request.canRetry || !writable) || !pending && (!writable || changed || invalid)) return;
    setCockpitPreparationForm(key, value);
    const response = await request.run(pending ?? { kind: "template", templateId, body: { command_key: crypto.randomUUID(), expected_revision: value.observedRevision,
      title: value.title.trim(), description: value.description, active: value.active, config: { ...value.config, slots: value.config.slots.map((slot) => ({ ...slot, label: slot.label.trim(), agenda: slot.agenda ? { ...slot.agenda, title: slot.agenda.title.trim() } : null, new_issue: slot.new_issue ? { ...slot.new_issue, title: slot.new_issue.title.trim() } : null })) } } },
    async (command) => { if (command.kind !== "template") throw new Error("meeting_preparation_command_scope_changed"); return mutation.mutateAsync(command.body); });
    if (response) { clearCockpitPreparationForm(key, value); if (response.stillCurrent()) onSaved(response.result.template_id); }
  };
  const verify = async () => {
    const response = await request.verify(async (command) => {
      if (command.kind !== "template") throw new Error("meeting_preparation_command_scope_changed");
      const result = await client.fetchQuery({ ...cockpitMeetingTemplateCommandOptions(wsId, command.body.command_key), staleTime: 0 });
      if (!result || !cockpitMeetingTemplateAcknowledged(result, command.body, command.templateId)) throw new Error(t(($) => $.meeting_templates.unconfirmed));
      await invalidateCockpitMeetingPreparationFacts(client, wsId);
      return result;
    });
    if (response) { if (value) clearCockpitPreparationForm(key, value); if (response.stillCurrent()) onSaved(response.result.template_id); }
  };
  return <section className="space-y-3"><Button variant="outline" size="sm" disabled={request.busy} onClick={onBack}>{t(($) => $.meeting_templates.back)}</Button>
    {templateId && (header.isError || version.isError) && <CockpitFlowError onRetry={() => { void header.refetch(); void version.refetch(); }} />}
    {!value ? unknown ? <p role="status" className="text-caption">{t(($) => $.meeting_templates.unsupported)}</p> : <Spinner /> : <>
      <CockpitMeetingTemplateFields value={value} onChange={(next) => setCockpitPreparationForm(key, next)} disabled={request.busy || Boolean(pending) || !writable} />
      {changed && !pending && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.meeting_templates.changed)}</p><Button variant="outline" size="sm" disabled={!writable || !header.data} onClick={() => { if (header.data) setCockpitPreparationForm(key, { ...value, observedRevision: header.data.revision }); }}>{t(($) => $.meeting_lifecycle.rebase)}</Button><Button variant="ghost" size="sm" onClick={() => void header.refetch()}>{t(($) => $.meeting_lifecycle.refresh)}</Button></div>}
      {invalid && stored && <p role="alert" className="text-caption text-destructive">{t(($) => $.meeting_templates.invalid)}</p>}
      {pending && <div className="space-y-2 text-caption"><p>{t(($) => $.meeting_lifecycle.pending_hint)}</p><Button variant="outline" size="sm" disabled={request.busy} onClick={() => void verify()}>{t(($) => $.meeting_lifecycle.check_command)}</Button></div>}
      {request.error && <p role="alert" className="break-words text-caption text-destructive">{request.error}</p>}
      <Button disabled={request.busy || Boolean(pending) && (!request.canRetry || !writable) || !pending && (!writable || changed || invalid)} onClick={() => void save()} aria-busy={request.busy}>{request.busy && <Spinner />}{pending ? t(($) => $.meeting_lifecycle.retry_command) : t(($) => $.meeting_templates.save_version)}</Button>
    </>}
  </section>;
}

function validTemplate(value: CockpitTemplateEditorDraft) {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  if (!value.title.trim() || bytes(value.title.trim()) > 500 || bytes(value.description) > 16000 || value.config.slots.length === 0 || value.config.slots.length > 50 || bytes(JSON.stringify(value.config)) > 256 * 1024) return false;
  const agendas = new Set(value.config.slots.filter((slot) => slot.kind === "agenda").map((slot) => slot.slot_id));
  return value.config.slots.every((slot) => slot.label.trim() && bytes(slot.label.trim()) <= 500 && (slot.kind === "agenda" ? slot.agenda && slot.agenda.title.trim() && bytes(slot.agenda.title.trim()) <= 500 && bytes(slot.agenda.desired_outcome) <= 16000 && bytes(slot.agenda.notes) <= 65536
    : slot.agenda_slot_id && agendas.has(slot.agenda_slot_id) && (slot.kind !== "preparation_issue" || slot.new_issue && slot.new_issue.title.trim() && bytes(slot.new_issue.title.trim()) <= 500 && bytes(slot.new_issue.description) <= 16000)));
}
