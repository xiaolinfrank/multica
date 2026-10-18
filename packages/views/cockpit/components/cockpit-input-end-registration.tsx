"use client";

import { useState } from "react";
import { endCockpitInputRegistration, setCockpitInputForm, useCockpitInputDraftStore, type CockpitInputFormDraft } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useT } from "../../i18n";

export function CockpitInputEndRegistration({ wsId, accountId, meetingId, draftKey, draft, disabled, onEnded }: {
  wsId: string; accountId: string; meetingId: string; draftKey: string; draft: CockpitInputFormDraft; disabled: boolean; onEnded?: () => void;
}) {
  const { t } = useT("cockpit"); const [open, setOpen] = useState(false); const [error, setError] = useState("");
  const pending = useCockpitInputDraftStore((state) => Boolean(state.draft.commands[draftKey]));
  if (!draft.inputId || draft.inputRevision === null || draft.versionId || draft.transferId || draft.registrationEnd || pending) return null;
  return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled} />}>{t(($) => $.input_materials.end_registration)}</DialogTrigger>
    <DialogContent><DialogHeader><DialogTitle>{t(($) => $.input_materials.end_registration)}</DialogTitle></DialogHeader>
      <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.end_registration_hint)}</p>
      <label className="block space-y-1 text-caption"><span>{t(($) => $.input_materials.end_reason)}</span><Textarea value={draft.note} rows={3} maxLength={16000} disabled={disabled}
        onChange={(event) => setCockpitInputForm(draftKey, { ...draft, note: event.target.value })} /></label>
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <DialogFooter><DialogClose render={<Button type="button" variant="outline" />}>{t(($) => $.task_create.cancel)}</DialogClose>
        <Button type="button" disabled={disabled || !draft.note.trim()} onClick={() => { try { endCockpitInputRegistration(wsId, accountId, meetingId, draftKey, draft.generation, draft.note); setOpen(false); onEnded?.(); }
          catch (cause) { setError(cause instanceof Error ? cause.message : t(($) => $.input_materials.error_unknown)); } }}>{t(($) => $.input_materials.end_registration)}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
