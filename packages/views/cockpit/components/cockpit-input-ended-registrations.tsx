"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cockpitEndedInputRegistrations, cockpitInputSelectedHeadersOptions, removeEndedCockpitInputRegistration, useCockpitInputDraftStore } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { useLocale, useT } from "../../i18n";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";

export function CockpitInputEndedRegistrations({ wsId, accountId, meetingId, agendaId, onInspect, onResume }: {
  wsId: string; accountId: string; meetingId: string; agendaId?: string;
  onInspect: (inputId: string) => void; onResume: (agendaId: string | null) => void;
}) {
  const { t } = useT("cockpit"); const locale = useLocale();
  const drafts = useCockpitInputDraftStore((state) => state.draft);
  const records = cockpitEndedInputRegistrations(drafts, wsId, accountId, meetingId, agendaId);
  const [open, setOpen] = useState(false); const [number, setNumber] = useState(1);
  const [removing, setRemoving] = useState<string | null>(null); const [error, setError] = useState("");
  const page = Math.min(number, Math.max(1, Math.ceil(records.length / 25))); const shown = records.slice((page - 1) * 25, page * 25);
  const ids = [...new Set(shown.map((item) => item.inputId))];
  const headers = useQuery({ ...cockpitInputSelectedHeadersOptions(wsId, ids), enabled: open && ids.length > 0 });
  const selected = records.find((item) => item.key === removing);
  if (!records.length) return null;
  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="space-y-3 rounded-lg border border-border p-3">
    <summary className="cursor-pointer text-caption font-medium">{t(($) => $.input_materials.local_records, { count: records.length })}</summary>
    {open && <><p className="text-caption text-muted-foreground">{t(($) => $.input_materials.local_records_hint)}</p>
      <CockpitFlowPaging page={page} shown={shown.length} total={records.length} busy={false} hasNext={page * 25 < records.length} onPrevious={() => setNumber(page - 1)} onNext={() => setNumber(page + 1)} />
      <ul className="max-h-[45dvh] space-y-3 overflow-y-auto overscroll-contain">{shown.map((record) => {
        const header = headers.data?.items.find((item) => item.id === record.inputId);
        return <li key={record.key} className="min-w-0 space-y-2 rounded-lg bg-muted/30 p-3">
          <p className="break-words text-caption font-medium">{record.title}</p>
          <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.registration_ended)} · {new Date(record.endedAt).toLocaleString(locale)}</p>
          <p className="break-words text-caption">{record.reason}</p>
          {record.description && <p className="whitespace-pre-wrap break-words text-caption text-muted-foreground">{record.description}</p>}
          {record.sourcePath && <details className="text-caption text-muted-foreground"><summary className="cursor-pointer">{t(($) => $.input_materials.source_details)}</summary><p className="break-words [overflow-wrap:anywhere]">{record.sourcePath}</p></details>}
          {header?.archivedAt && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.archived)}</p>}
          {headers.data?.unavailableIds.includes(record.inputId) && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.registration_read_unavailable)}</p>}
          <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" onClick={() => onInspect(record.inputId)}>{t(($) => $.input_materials.open_registered)}</Button>
            {record.inActiveBatch ? <Button type="button" variant="outline" size="sm" onClick={() => onResume(record.agendaId)}>{record.agendaId && record.agendaId !== agendaId ? t(($) => $.input_materials.open_registration_topic) : t(($) => $.input_materials.return_batch)}</Button>
              : <Button type="button" variant="ghost" size="sm" onClick={() => { setError(""); setRemoving(record.key); }}>{t(($) => $.input_materials.remove_local_record)}</Button>}
          </div>
        </li>;
      })}</ul>
      {headers.isError && <CockpitFlowError onRetry={() => void headers.refetch()} />}
    </>}
    <Dialog open={Boolean(selected)} onOpenChange={(value) => { if (!value) setRemoving(null); }}><DialogContent><DialogHeader><DialogTitle>{t(($) => $.input_materials.remove_local_record)}</DialogTitle></DialogHeader>
      <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.remove_local_record_hint)}</p>
      <p className="break-words text-caption font-medium">{selected?.title}</p>
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      <DialogFooter><DialogClose render={<Button type="button" variant="outline" />}>{t(($) => $.task_create.cancel)}</DialogClose><Button type="button" variant="destructive" onClick={() => {
        if (!selected) return; try { removeEndedCockpitInputRegistration(wsId, accountId, meetingId, selected.key, selected.generation); setRemoving(null); }
        catch (cause) { setError(cause instanceof Error ? cause.message : t(($) => $.input_materials.error_unknown)); }
      }}>{t(($) => $.input_materials.remove_local_record)}</Button></DialogFooter>
    </DialogContent></Dialog>
  </details>;
}
