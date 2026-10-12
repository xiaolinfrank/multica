"use client";

import { useState } from "react";
import type { CockpitTemplateEditorDraft } from "@multica/core/cockpit";
import type { CockpitMeetingTemplateSlot } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { useT } from "../../i18n";
import { CockpitFlowPaging } from "./cockpit-task-flow";
import { createSafeId } from "@multica/core/utils";

type Slot = CockpitTemplateEditorDraft["config"]["slots"][number];
const purposes = ["planning", "goal_review", "boundary_confirmation", "question_clarification", "solution_discussion", "direction_decision"] as const;
const priorities = ["none", "low", "medium", "high", "urgent"] as const;

export function useMeetingTemplateKindLabel() {
  const { t } = useT("cockpit");
  const labels: Record<string, string> = {
    agenda: t(($) => $.meeting_templates.agenda), preparation_issue: t(($) => $.meeting_templates.new_issue),
    issue_reference: t(($) => $.meeting_templates.existing_issue), material_reference: t(($) => $.meeting_templates.fixed_material),
  };
  return (kind: string) => labels[kind] ?? t(($) => $.meeting_templates.unknown_item);
}

export function CockpitTemplateSlotText({ slot }: { slot: CockpitMeetingTemplateSlot }) {
  const { t } = useT("cockpit");
  if (!slot.agenda && !slot.new_issue) return null;
  return <details className="space-y-2 text-caption"><summary className="cursor-pointer text-primary">{t(($) => $.meeting_templates.item_text)}</summary>
    <div className="max-h-64 space-y-2 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3">
      <p className="font-medium">{slot.agenda?.title ?? slot.new_issue?.title}</p>
      {slot.agenda?.desired_outcome && <div><p className="text-muted-foreground">{t(($) => $.meeting_lifecycle.desired_outcome)}</p><p>{slot.agenda.desired_outcome}</p></div>}
      {slot.agenda?.notes && <div><p className="text-muted-foreground">{t(($) => $.meeting_templates.initial_notes)}</p><p>{slot.agenda.notes}</p></div>}
      {slot.new_issue?.description && <div><p className="text-muted-foreground">{t(($) => $.task_flow.description)}</p><p>{slot.new_issue.description}</p></div>}
    </div>
  </details>;
}

/** Template content is edited as topics and preparation items, never as a JSON document. */
export function CockpitMeetingTemplateFields({ value, onChange, disabled }: {
  value: CockpitTemplateEditorDraft; onChange: (value: CockpitTemplateEditorDraft) => void; disabled: boolean;
}) {
  const { t } = useT("cockpit"); const { t: issueT } = useT("issues"); const kindLabel = useMeetingTemplateKindLabel();
  const [page, setPage] = useState(1); const [selected, setSelected] = useState<string | null>(value.config.slots[0]?.slot_id ?? null);
  const [removing, setRemoving] = useState<string | null>(null);
  const slots = value.config.slots; const agendas = slots.filter((slot) => slot.kind === "agenda");
  const current = slots.find((slot) => slot.slot_id === selected); const index = current ? slots.indexOf(current) : -1;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(slots.length / 25))); const shown = slots.slice((currentPage - 1) * 25, currentPage * 25);
  const changeSlots = (next: Slot[]) => onChange({ ...value, config: { schema_version: 1, slots: next } });
  const patch = (update: Partial<Slot>) => { if (current && !disabled) changeSlots(slots.map((slot) => slot.slot_id === current.slot_id ? { ...slot, ...update } : slot)); };
  const add = (kind: Slot["kind"]) => {
    if (disabled || slots.length >= 50 || kind !== "agenda" && agendas.length === 0) return;
    const next: Slot = { slot_id: createSafeId(), kind, label: "", agenda_slot_id: kind === "agenda" ? null : current?.kind === "agenda" ? current.slot_id : current?.agenda_slot_id ?? agendas[0]!.slot_id,
      agenda: kind === "agenda" ? { title: "", purposes: [], desired_outcome: "", notes: "" } : null,
      new_issue: kind === "preparation_issue" ? { title: "", description: "", priority: "none" } : null,
      purpose: kind === "issue_reference" ? "preparation" : kind === "material_reference" ? "material" : "" };
    changeSlots([...slots, next]); setSelected(next.slot_id); setPage(Math.floor(slots.length / 25) + 1); setRemoving(null);
  };
  const move = (direction: -1 | 1) => {
    if (disabled || !current || index + direction < 0 || index + direction >= slots.length) return;
    const next = [...slots]; next.splice(index, 1); next.splice(index + direction, 0, current); changeSlots(next);
    setPage(Math.floor((index + direction) / 25) + 1);
  };
  const remove = () => {
    if (disabled || !removing) return;
    const next = slots.filter((slot) => slot.slot_id !== removing && slot.agenda_slot_id !== removing);
    changeSlots(next); if (!next.some((slot) => slot.slot_id === selected)) setSelected(next[0]?.slot_id ?? null); setRemoving(null);
  };
  const removeCount = removing ? slots.filter((slot) => slot.slot_id === removing || slot.agenda_slot_id === removing).length : 0;
  return <div className="min-w-0 space-y-4">
    <label className="block space-y-1 text-caption">{t(($) => $.meeting_templates.name)}<Input value={value.title} disabled={disabled} onChange={(event) => onChange({ ...value, title: event.target.value })} /></label>
    <label className="block space-y-1 text-caption">{t(($) => $.meeting_templates.description)}<Textarea className="max-h-40 resize-y overflow-y-auto" value={value.description} disabled={disabled} onChange={(event) => onChange({ ...value, description: event.target.value })} /></label>
    <label className="flex items-start gap-2 text-caption"><input type="checkbox" checked={value.active} disabled={disabled} onChange={(event) => onChange({ ...value, active: event.target.checked })} />{t(($) => $.meeting_templates.active)}</label>
    <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-title-sm font-medium">{t(($) => $.meeting_templates.items)}</h3><span className="text-caption text-muted-foreground">{t(($) => $.meeting_templates.item_count, { count: slots.length })}</span></div>
      <div className="flex flex-wrap gap-2">{(["agenda", "preparation_issue", "issue_reference", "material_reference"] as const).map((kind) => <Button key={kind} type="button" size="sm" variant="outline" disabled={disabled || slots.length >= 50 || kind !== "agenda" && agendas.length === 0} onClick={() => add(kind)}><Plus className="size-3.5" />{kindLabel(kind)}</Button>)}</div>
      {agendas.length === 0 && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_templates.agenda_first)}</p>}
      {slots.length > 25 && <CockpitFlowPaging page={currentPage} shown={shown.length} total={slots.length} hasNext={currentPage * 25 < slots.length} busy={false} onPrevious={() => setPage(currentPage - 1)} onNext={() => setPage(currentPage + 1)} />}
      <ol className="max-h-52 space-y-1 overflow-y-auto overscroll-contain rounded-lg border border-border p-2">{shown.map((slot, row) => <li key={slot.slot_id}><Button type="button" variant={slot.slot_id === selected ? "secondary" : "ghost"} className="h-auto w-full justify-start whitespace-normal text-left" aria-pressed={slot.slot_id === selected} aria-label={`${(currentPage - 1) * 25 + row + 1}. ${slot.label || slot.agenda?.title || slot.new_issue?.title || kindLabel(slot.kind)} · ${kindLabel(slot.kind)}`} onClick={() => { setSelected(slot.slot_id); setRemoving(null); }}>
        <span className="shrink-0 tabular-nums text-muted-foreground">{(currentPage - 1) * 25 + row + 1}.</span><span className="min-w-0"><span className="line-clamp-2 break-words">{slot.label || slot.agenda?.title || slot.new_issue?.title || kindLabel(slot.kind)}</span><span className="text-micro text-muted-foreground">{kindLabel(slot.kind)}</span></span>
      </Button></li>)}</ol>
    </div>
    {current && <section aria-label={t(($) => $.meeting_templates.edit_item)} className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-body font-medium">{kindLabel(current.kind)}</h4><div className="flex gap-1">
        <Button type="button" variant="ghost" size="icon-sm" disabled={disabled || index === 0} aria-label={t(($) => $.meeting_templates.move_up)} onClick={() => move(-1)}><ArrowUp /></Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={disabled || index === slots.length - 1} aria-label={t(($) => $.meeting_templates.move_down)} onClick={() => move(1)}><ArrowDown /></Button>
        <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t(($) => $.meeting_templates.remove_item)} onClick={() => setRemoving(current.slot_id)}><X /></Button>
      </div></div>
      {removing === current.slot_id && <div role="alert" className="space-y-2 rounded-md bg-muted p-3 text-caption"><p>{t(($) => $.meeting_templates.remove_items, { count: removeCount })}</p><div className="flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setRemoving(null)}>{t(($) => $.binding.cancel)}</Button><Button type="button" variant="destructive" size="sm" disabled={disabled} onClick={remove}>{t(($) => $.meeting_templates.remove_item)}</Button></div></div>}
      {(current.kind === "issue_reference" || current.kind === "material_reference") && <label className="block space-y-1 text-caption">{t(($) => $.meeting_templates.item_label)}<Input value={current.label} disabled={disabled} onChange={(event) => patch({ label: event.target.value })} /></label>}
      {current.kind !== "agenda" && <label className="block space-y-1 text-caption">{t(($) => $.meeting_templates.for_agenda)}<Select value={current.agenda_slot_id ?? ""} disabled={disabled} items={agendas.map((slot, index) => ({ value: slot.slot_id, label: slot.agenda?.title || slot.label || t(($) => $.meeting_templates.unnamed_agenda, { number: index + 1 }) }))} onValueChange={(agenda_slot_id) => { if (agenda_slot_id) patch({ agenda_slot_id }); }}><SelectTrigger className="w-full" aria-label={t(($) => $.meeting_templates.for_agenda)}><SelectValue /></SelectTrigger><SelectContent>{agendas.map((slot, index) => <SelectItem key={slot.slot_id} value={slot.slot_id}>{slot.agenda?.title || slot.label || t(($) => $.meeting_templates.unnamed_agenda, { number: index + 1 })}</SelectItem>)}</SelectContent></Select></label>}
      {current.agenda && <>
        <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.agenda_title)}<Input value={current.agenda.title} disabled={disabled} onChange={(event) => patch({ label: event.target.value, agenda: { ...current.agenda!, title: event.target.value } })} /></label>
        <fieldset disabled={disabled}><legend className="mb-2 text-caption">{t(($) => $.meeting_lifecycle.purposes)}</legend><div className="flex flex-wrap gap-x-4 gap-y-2">{purposes.map((purpose) => <label key={purpose} className="flex items-center gap-2 text-caption"><input type="checkbox" checked={current.agenda!.purposes.includes(purpose)} onChange={(event) => patch({ agenda: { ...current.agenda!, purposes: event.target.checked ? [...current.agenda!.purposes, purpose] : current.agenda!.purposes.filter((item) => item !== purpose) } })} />{t(($) => $.meeting_lifecycle[purpose])}</label>)}</div></fieldset>
        <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.desired_outcome)}<Textarea className="max-h-40 resize-y overflow-y-auto" value={current.agenda.desired_outcome} disabled={disabled} onChange={(event) => patch({ agenda: { ...current.agenda!, desired_outcome: event.target.value } })} /></label>
        <label className="block space-y-1 text-caption">{t(($) => $.meeting_templates.initial_notes)}<Textarea className="max-h-52 resize-y overflow-y-auto" value={current.agenda.notes} disabled={disabled} onChange={(event) => patch({ agenda: { ...current.agenda!, notes: event.target.value } })} /></label>
      </>}
      {current.new_issue && <>
        <label className="block space-y-1 text-caption">{t(($) => $.task_flow.title)}<Input value={current.new_issue.title} disabled={disabled} onChange={(event) => patch({ label: event.target.value, new_issue: { ...current.new_issue!, title: event.target.value } })} /></label>
        <label className="block space-y-1 text-caption">{t(($) => $.task_flow.description)}<Textarea className="max-h-52 resize-y overflow-y-auto" value={current.new_issue.description} disabled={disabled} onChange={(event) => patch({ new_issue: { ...current.new_issue!, description: event.target.value } })} /></label>
        <label className="block space-y-1 text-caption">{t(($) => $.task_flow.priority)}<Select value={current.new_issue.priority} disabled={disabled} items={priorities.map((item) => ({ value: item, label: issueT(($) => $.priority[item]) }))} onValueChange={(priority) => { const next = priorities.find((item) => item === priority); if (next) patch({ new_issue: { ...current.new_issue!, priority: next } }); }}><SelectTrigger aria-label={t(($) => $.task_flow.priority)}><SelectValue /></SelectTrigger><SelectContent>{priorities.map((item) => <SelectItem key={item} value={item}>{issueT(($) => $.priority[item])}</SelectItem>)}</SelectContent></Select></label>
        <p className="text-caption text-muted-foreground">{t(($) => $.meeting_templates.backlog_hint)}</p>
      </>}
      {current.kind === "issue_reference" && <label className="block space-y-1 text-caption">{t(($) => $.meeting_lifecycle.purpose)}<Select value={current.purpose} disabled={disabled} items={[{ value: "preparation", label: t(($) => $.meeting_lifecycle.preparation) }, { value: "material", label: t(($) => $.meeting_lifecycle.material) }]} onValueChange={(purpose) => { if (purpose) patch({ purpose }); }}><SelectTrigger aria-label={t(($) => $.meeting_lifecycle.purpose)}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="preparation">{t(($) => $.meeting_lifecycle.preparation)}</SelectItem><SelectItem value="material">{t(($) => $.meeting_lifecycle.material)}</SelectItem></SelectContent></Select></label>}
      {(current.kind === "issue_reference" || current.kind === "material_reference") && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_templates.choose_when_applying)}</p>}
    </section>}
  </div>;
}
