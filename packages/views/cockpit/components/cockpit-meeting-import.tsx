"use client";

// Reading meetings back off the share.
//
// Meetings happen whether or not anybody opens the register, and their
// material lands in the archive folder either way — dropped there from a
// laptop, by someone who has never used the board. Those folders ARE the
// record; the register just does not know about them yet.
//
// Everything on this screen except the folder name is a GUESS off that name,
// so nothing here is presented as fact: every guessed field is an input, the
// folder it came from is shown beside it, and the rows this creates stay
// flagged afterwards until somebody says they have checked them.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CockpitMeetingImportItem, CockpitMeetingScanEntry } from "@multica/core/types";
import { cockpitMeetingScanOptions } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { RotateCw } from "lucide-react";
import { useT } from "../../i18n";

export interface CockpitMeetingImportProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wsId: string;
  /** The board's destination, so the scan reads the same folder the create
   *  form would file into. */
  projectId: string | null;
  moduleId: string | null;
  nodeId: string | null;
  onSubmit: (items: CockpitMeetingImportItem[], createTask: boolean) => Promise<unknown>;
}

/** The fields a human may correct before a folder becomes a row. */
type Draft = Pick<CockpitMeetingImportItem, "code" | "meet_date" | "title" | "parties">;

function draftOf(entry: CockpitMeetingScanEntry): Draft {
  return {
    code: entry.code,
    meet_date: entry.meet_date,
    title: entry.title,
    parties: entry.parties,
  };
}

export function CockpitMeetingImport({
  open,
  onOpenChange,
  wsId,
  projectId,
  moduleId,
  nodeId,
  onSubmit,
}: CockpitMeetingImportProps) {
  const { t } = useT("cockpit");
  const { t: common } = useT("common");

  const scan = useQuery({
    ...cockpitMeetingScanOptions(wsId, {
      projectId: projectId || undefined,
      moduleId: moduleId || undefined,
      nodeId: nodeId ?? "",
    }),
    enabled: open && Boolean(wsId),
  });

  const fresh = useMemo(
    () => (scan.data?.entries ?? []).filter((entry) => !entry.meeting_id),
    [scan.data],
  );

  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [withTask, setWithTask] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // A fresh scan replaces what is on screen: the folders it found are the
  // folders that are there now, and a leftover edit against a folder that has
  // since been renamed would import under a name nobody chose.
  useEffect(() => {
    if (!open) return;
    const nextChosen: Record<string, boolean> = {};
    const nextDrafts: Record<string, Draft> = {};
    for (const entry of fresh) {
      nextChosen[entry.name] = true;
      nextDrafts[entry.name] = draftOf(entry);
    }
    setChosen(nextChosen);
    setDrafts(nextDrafts);
  }, [open, fresh]);

  useEffect(() => {
    if (!open) setSubmitting(false);
  }, [open]);

  const edit = (name: string, patch: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [name]: { ...current[name], ...patch } }));

  const selected = fresh.filter((entry) => chosen[entry.name]);

  const submit = async () => {
    if (submitting || selected.length === 0) return;
    setSubmitting(true);
    try {
      await onSubmit(
        selected.map((entry) => ({ name: entry.name, ...drafts[entry.name] })),
        withTask,
      );
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  const error = scan.data?.error ?? "";

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.meetings.scan_title)}</DialogTitle>
          <DialogDescription>{t(($) => $.meetings.scan_description)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
              {scan.data?.base_dir || t(($) => $.meetings.scan_no_folder)}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2"
              disabled={scan.isFetching}
              aria-busy={scan.isFetching}
              onClick={() => void scan.refetch()}
            >
              <RotateCw className="size-3.5" />
              {t(($) => $.meetings.scan_again)}
            </Button>
          </div>

          {scan.isLoading ? (
            <p className="text-caption text-muted-foreground">{common(($) => $.loading)}</p>
          ) : error ? (
            <p className="text-caption text-destructive">{error}</p>
          ) : fresh.length === 0 ? (
            <p className="text-caption text-muted-foreground">
              {t(($) => $.meetings.scan_empty, { matched: scan.data?.matched ?? 0 })}
            </p>
          ) : (
            <div className="max-h-96 overflow-y-auto rounded-md border border-border">
              <table className="w-full border-collapse text-caption">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-left text-micro tracking-wide text-muted-foreground uppercase">
                    <th scope="col" className="w-8 py-1 pl-2" />
                    <th scope="col" className="py-1 pr-2 font-medium">
                      {t(($) => $.meetings.scan_folder)}
                    </th>
                    <th scope="col" className="w-28 py-1 pr-2 font-medium">
                      {t(($) => $.meeting.date)}
                    </th>
                    <th scope="col" className="w-28 py-1 pr-2 font-medium">
                      {t(($) => $.meeting.code)}
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      {t(($) => $.meeting.title)}
                    </th>
                    <th scope="col" className="py-1 pr-2 font-medium">
                      {t(($) => $.meeting.parties)}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {fresh.map((entry) => {
                    const draft = drafts[entry.name] ?? draftOf(entry);
                    return (
                      <tr key={entry.name} className="border-b border-border/60 align-top">
                        <td className="py-1.5 pl-2">
                          <Checkbox
                            checked={chosen[entry.name] ?? false}
                            aria-label={t(($) => $.meetings.scan_choose, { folder: entry.name })}
                            onCheckedChange={(checked) =>
                              setChosen((current) => ({ ...current, [entry.name]: checked === true }))
                            }
                          />
                        </td>
                        <td className="max-w-64 py-1.5 pr-2">
                          <span className="block truncate" title={entry.name}>
                            {entry.name}
                          </span>
                          <span className="block text-micro text-muted-foreground">
                            {t(($) => $.meetings.scan_files, { n: entry.files })}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input
                            type="date"
                            className="h-7"
                            value={draft.meet_date ?? ""}
                            aria-label={t(($) => $.meetings.scan_field_date, { folder: entry.name })}
                            onChange={(e) => edit(entry.name, { meet_date: e.target.value })}
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input
                            className="h-7 font-mono text-micro"
                            value={draft.code ?? ""}
                            aria-label={t(($) => $.meetings.scan_field_code, { folder: entry.name })}
                            onChange={(e) => edit(entry.name, { code: e.target.value })}
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input
                            className="h-7"
                            value={draft.title ?? ""}
                            aria-label={t(($) => $.meetings.scan_field_title, { folder: entry.name })}
                            onChange={(e) => edit(entry.name, { title: e.target.value })}
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input
                            className="h-7"
                            value={draft.parties ?? ""}
                            aria-label={t(($) => $.meetings.scan_field_parties, { folder: entry.name })}
                            onChange={(e) => edit(entry.name, { parties: e.target.value })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {scan.data?.truncated && (
            <p className="text-caption text-muted-foreground">{t(($) => $.meetings.scan_truncated)}</p>
          )}

          {fresh.length > 0 && (
            <label className="flex items-start gap-2">
              <Checkbox
                checked={withTask}
                onCheckedChange={(checked) => setWithTask(checked === true)}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-body">{t(($) => $.meetings.scan_with_task)}</span>
                <span className="text-caption text-muted-foreground">
                  {t(($) => $.meetings.scan_with_task_hint)}
                </span>
              </span>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {common(($) => $.cancel)}
          </Button>
          <Button
            disabled={submitting || selected.length === 0}
            aria-busy={submitting}
            onClick={() => void submit()}
          >
            {submitting && <Spinner />}
            {t(($) => $.meetings.scan_submit, { n: selected.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
