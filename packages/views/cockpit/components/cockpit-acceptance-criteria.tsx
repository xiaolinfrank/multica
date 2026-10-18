"use client";

import { useRef, useState } from "react";
import { cockpitAcceptanceDraftKey, clearCockpitCriteriaDraft, saveCockpitCriteriaDraft, useCockpitAcceptanceDraftStore, useSaveCockpitAcceptanceCriteria } from "@multica/core/cockpit";
import type { CockpitAcceptanceCriteriaView, CockpitAcceptanceCriterionInput } from "@multica/core/types";
import { ApiError } from "@multica/core/api";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { createSafeId } from "@multica/core/utils";

export function CockpitAcceptanceCriteriaEditor({ wsId, definition, disabled }: { wsId: string; definition: CockpitAcceptanceCriteriaView; disabled: boolean }) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false); const [error, setError] = useState(""); const lock = useRef(false);
  const key = cockpitAcceptanceDraftKey(wsId, definition.node_id);
  const captureContext = useCockpitCommandContext(key);
  const draft = useCockpitAcceptanceDraftStore((state) => state.draft.criteria[key]);
  const save = useSaveCockpitAcceptanceCriteria(wsId);
  const stale = Boolean(draft && draft.baseRevision !== definition.revision);
  const items = draft?.items ?? [];
  const valid = items.length <= definition.max_items && items.every((item) => Boolean(item.title.trim()));
  const change = (next: CockpitAcceptanceCriterionInput[]) => { if (draft && !lock.current) saveCockpitCriteriaDraft(key, draft.baseRevision, next); };
  const patch = (id: string, values: Partial<CockpitAcceptanceCriterionInput>) => change(items.map((item) => item.id === id ? { ...item, ...values } : item));
  const move = (index: number, direction: -1 | 1) => { const next = [...items]; const target = index + direction; if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!]; change(next); };
  async function submit() {
    if (!draft || lock.current || disabled || !definition.can_edit || stale || !valid) return;
    const stillCurrent = captureContext();
    lock.current = true; setError("");
    try {
      await save.mutateAsync({ nodeId: definition.node_id, body: { expected_revision: draft.baseRevision, criteria: draft.items } });
      clearCockpitCriteriaDraft(key, draft); if (stillCurrent()) setOpen(false);
    } catch (cause) { if (stillCurrent()) setError(cause instanceof ApiError ? cause.message : t(($) => $.task_flow.unconfirmed)); }
    finally { lock.current = false; }
  }
  return <Dialog open={open} onOpenChange={(next) => {
    if (lock.current) return;
    if (next && !useCockpitAcceptanceDraftStore.getState().draft.criteria[key]) saveCockpitCriteriaDraft(key, definition.revision, definition.items.map(({ id, title, description }) => ({ id, title, description })));
    setOpen(next);
  }}><DialogTrigger render={<Button type="button" variant="outline" size="sm" disabled={disabled || !definition.can_edit} />}>{t(($) => $.acceptance.edit_criteria)}</DialogTrigger>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-3xl"><DialogHeader><DialogTitle>{t(($) => $.acceptance.edit_criteria)}</DialogTitle><DialogDescription>{t(($) => $.acceptance.criteria_hint)}</DialogDescription></DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
        {stale && <div role="status" className="space-y-3 rounded-lg bg-warning-subtle p-3 text-caption"><p>{t(($) => $.acceptance.criteria_changed)}</p>
          <details><summary className="cursor-pointer">{t(($) => $.acceptance.latest_criteria)}</summary><ol className="mt-2 list-inside list-decimal space-y-2">{definition.items.map((item) => <li key={item.id} className="break-words"><b>{item.title}</b>{item.description && <p className="whitespace-pre-wrap">{item.description}</p>}</li>)}</ol></details>
          <Button type="button" variant="outline" size="sm" onClick={() => saveCockpitCriteriaDraft(key, definition.revision, items)}>{t(($) => $.acceptance.rebase_criteria)}</Button></div>}
        <ol className="space-y-3">{items.map((item, index) => <li key={item.id} className="space-y-3 rounded-xl border border-border p-3">
          <div className="flex items-center gap-2"><span className="mr-auto text-caption font-medium">{t(($) => $.acceptance.criterion_number, { number: index + 1 })}</span>
            <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0 || save.isPending} aria-label={t(($) => $.acceptance.move_up, { number: index + 1 })} onClick={() => move(index, -1)}><ArrowUp /></Button>
            <Button type="button" variant="ghost" size="icon-sm" disabled={index === items.length - 1 || save.isPending} aria-label={t(($) => $.acceptance.move_down, { number: index + 1 })} onClick={() => move(index, 1)}><ArrowDown /></Button>
            <Button type="button" variant="ghost" size="icon-sm" disabled={save.isPending} aria-label={t(($) => $.acceptance.remove_criterion, { number: index + 1 })} onClick={() => change(items.filter((entry) => entry.id !== item.id))}><Trash2 /></Button></div>
          <label className="block space-y-1 text-caption"><span>{t(($) => $.acceptance.criterion_title)}</span><Input value={item.title} maxLength={500} disabled={save.isPending} onChange={(event) => patch(item.id, { title: event.target.value })} /></label>
          <label className="block space-y-1 text-caption"><span>{t(($) => $.artifacts.description)}</span><Textarea rows={2} value={item.description} disabled={save.isPending} onChange={(event) => patch(item.id, { description: event.target.value })} /></label>
        </li>)}</ol>
        <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" size="sm" disabled={save.isPending || items.length >= definition.max_items} onClick={() => change([...items, { id: createSafeId(), title: "", description: "" }])}><Plus className="size-3.5" />{t(($) => $.acceptance.add_criterion)}</Button><span className="text-caption text-muted-foreground">{t(($) => $.acceptance.criteria_limit, { count: items.length, max: definition.max_items })}</span></div>
        {!valid && <p role="alert" className="text-caption text-destructive">{t(($) => $.acceptance.criteria_invalid)}</p>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      </div><DialogFooter><DialogClose render={<Button type="button" variant="outline" disabled={save.isPending} />}>{t(($) => $.task_create.cancel)}</DialogClose>
        <Button type="button" disabled={disabled || !definition.can_edit || stale || !valid || save.isPending} aria-busy={save.isPending} onClick={() => void submit()}>{save.isPending && <Spinner />}{t(($) => $.acceptance.save_criteria)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
