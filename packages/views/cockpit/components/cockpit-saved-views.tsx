"use client";
import { useEffect, useState } from "react";
import { Bookmark, MoreHorizontal, Plus } from "lucide-react";
import { COCKPIT_SAVED_VIEW_LIMIT, CockpitSavedViewError, cockpitSavedViewStorageKey, useCockpitSavedViewStore, type CockpitSavedView, type CockpitSavedViewDefinition } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@multica/ui/components/ui/dropdown-menu";
import { Input } from "@multica/ui/components/ui/input";
import { useT } from "../../i18n";

export interface CockpitSavedViewsControlProps {
  wsId: string; userId: string;
  capture: () => CockpitSavedViewDefinition | null;
  onApply: (definition: CockpitSavedViewDefinition) => void;
}
type Editing = { kind: "save"; definition: CockpitSavedViewDefinition } | { kind: "rename"; item: CockpitSavedView } | { kind: "remove"; item: CockpitSavedView } | { kind: "replace"; item: CockpitSavedView; definition: CockpitSavedViewDefinition };
export function CockpitSavedViewsControl(props: CockpitSavedViewsControlProps) {
  return <SavedViewsSession key={JSON.stringify([props.userId, props.wsId])} {...props} />;
}
function SavedViewsSession({ wsId, userId, capture, onApply }: CockpitSavedViewsControlProps) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null), [name, setName] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const state = useCockpitSavedViewStore();
  const expectedNamespace = cockpitSavedViewStorageKey(userId, wsId);
  const namespace = state.namespaces[expectedNamespace];
  const ready = Boolean(namespace && !namespace.loadFailed);
  useEffect(() => { if (open) useCockpitSavedViewStore.getState().load(userId, wsId); }, [open, userId, wsId]);
  const current = capture();
  const items = ready ? (namespace?.items ?? []).filter((item) => item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : [];
  const label = (view: CockpitSavedViewDefinition) => view.surface === "work" ? t(($) => $.shell.overview) : view.surface === "plan" ? t(($) => $.shell.plan) : view.surface === "meetings" ? t(($) => $.shell.meetings) : t(($) => $.shell.governance);
  const showError = (cause: unknown) => {
    const code = cause instanceof CockpitSavedViewError ? cause.code : "write";
    setError(code === "duplicate" ? t(($) => $.saved_views.duplicate) : code === "limit" ? t(($) => $.saved_views.limit, { count: COCKPIT_SAVED_VIEW_LIMIT }) : code === "invalid" ? t(($) => $.saved_views.invalid) : t(($) => $.saved_views.write_failed));
  };
  const begin = (value: Editing) => { setEditing(value); setName(value.kind === "save" ? "" : value.item.name); setError(""); setNotice(""); };
  const submit = () => {
    if (!editing || !ready) return;
    try {
      if (editing.kind === "remove") state.remove(userId, wsId, editing.item.id);
      else if (editing.kind === "rename") state.rename(userId, wsId, editing.item.id, name);
      else state.save(userId, wsId, editing.kind === "replace" ? editing.item.name : name, editing.definition, editing.kind === "replace" ? editing.item.id : undefined);
      setNotice(editing.kind === "remove" ? t(($) => $.saved_views.removed) : t(($) => $.saved_views.saved)); setEditing(null); setName(""); setError("");
    } catch (cause) { showError(cause); }
  };
  return <Dialog open={open} onOpenChange={(value) => { setOpen(value); if (!value) { setEditing(null); setError(""); setNotice(""); } }}>
    <DialogTrigger render={<Button type="button" variant="outline" size="sm" disabled={!userId || !wsId} />}><Bookmark className="size-4" />{t(($) => $.saved_views.title)}</DialogTrigger>
    <DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{t(($) => $.saved_views.title)}</DialogTitle></DialogHeader>
      <p className="text-caption text-muted-foreground">{t(($) => $.saved_views.device_only)}</p>
      {namespace?.loadFailed ? <div role="alert" className="space-y-2 text-caption text-destructive"><p>{t(($) => $.saved_views.load_failed)}</p><Button type="button" variant="outline" size="sm" onClick={() => state.load(userId, wsId)}>{t(($) => $.binding.retry)}</Button></div>
        : editing ? <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); submit(); }}>
          {editing.kind === "save" || editing.kind === "rename" ? <label className="block space-y-1 text-caption">{t(($) => $.saved_views.name)}<Input name="saved-cockpit-view-name" autoComplete="off" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
            : <p className="break-words text-body">{editing.kind === "remove" ? t(($) => $.saved_views.remove_confirm, { name: editing.item.name }) : t(($) => $.saved_views.replace_confirm, { name: editing.item.name })}</p>}
          {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => { setEditing(null); setError(""); }}>{t(($) => $.binding.cancel)}</Button><Button type="submit" variant={editing.kind === "remove" ? "destructive" : "default"} disabled={!ready || ((editing.kind === "save" || editing.kind === "rename") && !name.trim())}>{editing.kind === "remove" ? t(($) => $.saved_views.remove) : t(($) => $.saved_views.save)}</Button></DialogFooter>
        </form> : <>
          <div className="flex flex-wrap items-center gap-2"><Input className="min-w-40 flex-1" name="saved-cockpit-view-search" autoComplete="off" spellCheck={false} value={search} onChange={(event) => setSearch(event.target.value)} aria-label={t(($) => $.saved_views.search)} placeholder={t(($) => $.saved_views.search)} />
            <Button type="button" size="sm" disabled={!ready || !current || (namespace?.items.length ?? 0) >= COCKPIT_SAVED_VIEW_LIMIT} onClick={() => { const value = capture(); if (value) begin({ kind: "save", definition: value }); }}><Plus className="size-4" />{t(($) => $.saved_views.save_current)}</Button></div>
          {!current && <p className="text-caption text-muted-foreground">{t(($) => $.saved_views.main_views_only)}</p>}
          {ready && <p className="text-micro text-muted-foreground">{t(($) => $.saved_views.count, { count: (namespace?.items.length ?? 0), limit: COCKPIT_SAVED_VIEW_LIMIT })}</p>}
          <ul className="max-h-80 overflow-y-auto divide-y divide-border">{items.map((item) => <li key={item.id} className="flex min-w-0 items-center gap-2 py-1">
            <Button type="button" variant="ghost" className="h-auto min-h-11 min-w-0 flex-1 justify-start py-2 text-left" aria-label={t(($) => $.saved_views.apply_named, { name: item.name })} onClick={() => { try { onApply(item.definition); setOpen(false); } catch (cause) { showError(cause); } }}><span className="min-w-0"><span className="block line-clamp-2 break-words whitespace-normal" title={item.name}>{item.name}</span><span className="mt-0.5 block text-micro text-muted-foreground">{label(item.definition)}</span></span></Button>
            <DropdownMenu><DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={t(($) => $.saved_views.manage_named, { name: item.name })} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => begin({ kind: "rename", item })}>{t(($) => $.saved_views.rename)}</DropdownMenuItem>
              <DropdownMenuItem disabled={!current} onClick={() => { const definition = capture(); if (definition) begin({ kind: "replace", item, definition }); }}>{t(($) => $.saved_views.replace)}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => begin({ kind: "remove", item })}>{t(($) => $.saved_views.remove)}</DropdownMenuItem>
            </DropdownMenuContent></DropdownMenu>
          </li>)}</ul>
          {ready && items.length === 0 && <p className="py-3 text-caption text-muted-foreground">{search ? t(($) => $.task_flow.no_matches) : t(($) => $.saved_views.empty)}</p>}
          {error && <p role="alert" className="text-caption text-destructive">{error}</p>}{notice && <p role="status" className="text-caption">{notice}</p>}
        </>}
    </DialogContent>
  </Dialog>;
}
