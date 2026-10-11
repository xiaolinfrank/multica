"use client";

import { useRef, useState } from "react";
import { cockpitInputDraftKey, emptyCockpitInputForm, clearCockpitInputForm, setCockpitInputForm, useCockpitInputDraftStore, useEditCockpitInput, useArchiveCockpitInput, type CockpitInputFormDraft } from "@multica/core/cockpit";
import type { CockpitInputHeader } from "@multica/core/types/cockpit-input";
import { ApiError } from "@multica/core/api";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useT } from "../../i18n";
import { CockpitInputProblem } from "./cockpit-input-problem";
import { useCockpitCommandContext } from "./use-cockpit-command-context";

export function CockpitInputMetadataEditor({ wsId, accountId, input, onDone, onRefresh }: {
  wsId: string; accountId: string; input: CockpitInputHeader; onDone: () => void; onRefresh: () => void;
}) {
  const { t } = useT("cockpit"); const key = cockpitInputDraftKey(wsId, accountId, "input-metadata", input.id);
  const initial = useRef<CockpitInputFormDraft>({ ...emptyCockpitInputForm(crypto.randomUUID()), inputId: input.id, title: input.title, description: input.description, observedRevision: input.revision });
  const stored = useCockpitInputDraftStore((state) => state.draft.forms[key]); const draft = stored ?? initial.current;
  const save = useEditCockpitInput(wsId, input.id); const capture = useCockpitCommandContext(key); const lock = useRef(false);
  const [error, setError] = useState("");
  const changed = draft.observedRevision !== input.revision;
  const invalid = !draft.title.trim() || new TextEncoder().encode(draft.title.trim()).length > 512 || new TextEncoder().encode(draft.description).length > 16000;
  const update = (patch: Partial<CockpitInputFormDraft>) => setCockpitInputForm(key, { ...draft, ...patch });
  async function submit() {
    if (lock.current || !input.canEdit || invalid || changed || draft.observedRevision === null) return;
    lock.current = true; const current = capture(); setError(""); setCockpitInputForm(key, draft);
    try {
      const result = await save.mutateAsync({ expectedRevision: draft.observedRevision, title: draft.title.trim(), description: draft.description });
      if (!result) throw new Error(t(($) => $.input_materials.error_unknown));
      clearCockpitInputForm(key, draft); if (current()) onDone();
    } catch (cause) { if (current()) setError(cause instanceof ApiError ? cause.message : t(($) => $.task_flow.unconfirmed)); }
    finally { lock.current = false; }
  }
  return <section className="space-y-4"><h3 className="text-title-sm font-medium">{t(($) => $.input_materials.edit_metadata)}</h3>
    <label className="block space-y-1 text-caption">{t(($) => $.input_materials.name)}<Input value={draft.title} disabled={save.isPending || !input.canEdit} maxLength={512} onChange={(event) => update({ title: event.target.value })} /></label>
    <label className="block space-y-1 text-caption">{t(($) => $.input_materials.description_optional)}<Textarea value={draft.description} disabled={save.isPending || !input.canEdit} maxLength={16000} rows={5} onChange={(event) => update({ description: event.target.value })} /></label>
    {invalid && stored && <p role="alert" className="text-caption text-destructive">{draft.title.trim() ? t(($) => $.input_materials.text_too_long) : t(($) => $.input_materials.name_required)}</p>}
    {changed && <div role="alert" className="space-y-2 rounded-lg border border-border p-3 text-caption"><p>{t(($) => $.input_materials.metadata_changed)}</p><p className="break-words font-medium">{input.title}</p>{input.description && <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words">{input.description}</p>}
      <Button type="button" size="sm" variant="outline" disabled={save.isPending || !input.canEdit} onClick={() => update({ observedRevision: input.revision })}>{t(($) => $.input_materials.metadata_keep_edits)}</Button></div>}
    <CockpitInputProblem codes={input.blockedReasons} />
    {error && <div role="alert" className="space-y-2 text-caption text-destructive"><p className="break-words">{error}</p><Button type="button" size="sm" variant="outline" onClick={onRefresh}>{t(($) => $.input_materials.refresh_version)}</Button></div>}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={onDone}>{t(($) => $.input_materials.return_materials)}</Button>
      {stored && <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => { clearCockpitInputForm(key, draft); onDone(); }}>{t(($) => $.input_materials.discard_metadata_draft)}</Button>}
      <Button type="button" disabled={save.isPending || !input.canEdit || invalid || changed} aria-busy={save.isPending} onClick={() => void submit()}>{t(($) => $.input_materials.save_metadata)}</Button></div>
  </section>;
}

export function CockpitInputArchiveForm({ wsId, input, archived, observedRevision, onDone, onRefresh }: {
  wsId: string; input: CockpitInputHeader; archived: boolean; observedRevision: number; onDone: () => void; onRefresh: () => void;
}) {
  const { t } = useT("cockpit"); const archive = useArchiveCockpitInput(wsId, input.id); const capture = useCockpitCommandContext(`${wsId}:${input.id}:${archived}`);
  const lock = useRef(false); const [revision, setRevision] = useState(observedRevision); const [error, setError] = useState("");
  const currentMatches = Boolean(input.archivedAt) === archived;
  const allowed = archived ? input.canArchive : input.canUnarchive; const changed = input.revision !== revision;
  async function submit() {
    if (lock.current || !allowed || changed || currentMatches) return;
    lock.current = true; setError(""); const current = capture();
    try { const result = await archive.mutateAsync({ expectedRevision: revision, archived }); if (!result) throw new Error(t(($) => $.input_materials.error_unknown)); if (current()) onDone(); }
    catch (cause) { if (current()) setError(cause instanceof ApiError ? cause.message : t(($) => $.task_flow.unconfirmed)); }
    finally { lock.current = false; }
  }
  return <section className="space-y-4"><h3 className="text-title-sm font-medium">{archived ? t(($) => $.input_materials.archive) : t(($) => $.input_materials.unarchive)}</h3>
    <p className="break-words text-caption font-medium">{input.title}</p><p className="text-caption text-muted-foreground">{archived ? t(($) => $.input_materials.archive_hint) : t(($) => $.input_materials.unarchive_hint)}</p>
    {currentMatches ? <p role="status" className="text-caption">{archived ? t(($) => $.input_materials.archived) : t(($) => $.input_materials.active_material)}</p> : changed && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.input_materials.metadata_changed)}</p><Button type="button" size="sm" variant="outline" disabled={archive.isPending || !allowed} onClick={() => setRevision(input.revision)}>{t(($) => $.input_materials.use_current_header)}</Button></div>}
    <CockpitInputProblem codes={input.blockedReasons} />
    {error && <div role="alert" className="space-y-2 text-caption text-destructive"><p className="break-words">{error}</p><Button type="button" size="sm" variant="outline" onClick={onRefresh}>{t(($) => $.input_materials.refresh_version)}</Button></div>}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" onClick={onDone}>{t(($) => $.input_materials.return_materials)}</Button>
      {!currentMatches && <Button type="button" disabled={archive.isPending || !allowed || changed} aria-busy={archive.isPending} onClick={() => void submit()}>{archived ? t(($) => $.input_materials.archive) : t(($) => $.input_materials.unarchive)}</Button>}
    </div>
  </section>;
}
