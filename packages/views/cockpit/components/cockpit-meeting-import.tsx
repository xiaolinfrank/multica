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

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorCode } from "@multica/core/api";
import { useQuery } from "@tanstack/react-query";
import type { CockpitMeetingImportItem, CockpitMeetingImportResult, CockpitMeetingScanEntry } from "@multica/core/types";
import { cockpitMeetingScanOptions, cockpitObjectPath } from "@multica/core/cockpit";
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
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink } from "../../navigation";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multica/ui/components/ui/alert-dialog";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
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
  onSubmit: (items: CockpitMeetingImportItem[], createTask: boolean, expectedBaseDir: string) => Promise<CockpitMeetingImportResult>;
}

/** The fields a human may correct before a folder becomes a row. */
type ImportOutcome = { name: string; title: string; meetingId: string | null; error: string };
type Draft = Pick<CockpitMeetingImportItem, "code" | "meet_date" | "title" | "parties">;

function draftOf(entry: CockpitMeetingScanEntry): Draft {
  return {
    code: entry.code,
    meet_date: entry.meet_date,
    title: entry.title,
    parties: entry.parties,
  };
}

export function CockpitMeetingImport(props: CockpitMeetingImportProps) {
  return <MeetingImportSession key={JSON.stringify([props.wsId, props.projectId, props.moduleId, props.nodeId, props.open])} {...props} />;
}

function MeetingImportSession({
  open,
  onOpenChange,
  wsId,
  projectId,
  moduleId,
  nodeId,
  onSubmit,
}: CockpitMeetingImportProps) {
  const { t } = useT("cockpit");
  const { t: common } = useT("common"); const paths = useWorkspacePaths();
  const sessionId = useId(); const [initialized, setInitialized] = useState(false);
  const captureContext = useCockpitCommandContext(JSON.stringify([wsId, projectId, moduleId, nodeId, open, sessionId]));
  const lock = useRef(false); const [confirmRefresh, setConfirmRefresh] = useState(false);

  const scan = useQuery({
    ...cockpitMeetingScanOptions(wsId, {
      projectId: projectId || undefined,
      moduleId: moduleId || undefined,
      nodeId: nodeId ?? "",
    }, sessionId),
    enabled: open && Boolean(wsId) && !initialized,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
  });

  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [outcomes, setOutcomes] = useState<Record<string, ImportOutcome>>({});
  const [withTask, setWithTask] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [directoryChanged, setDirectoryChanged] = useState(false);
  const fresh = useMemo(() => (scan.data?.entries ?? []).filter((entry) => !entry.meeting_id && !outcomes[entry.path]?.meetingId), [scan.data, outcomes]);
  const seed = (entries: CockpitMeetingScanEntry[]) => {
    const nextChosen: Record<string, boolean> = {}, nextDrafts: Record<string, Draft> = {};
    const nextOutcomes: Record<string, ImportOutcome> = Object.fromEntries(Object.entries(outcomes).filter(([, outcome]) => outcome.meetingId));
    for (const entry of entries) {
      if (!entry.meeting_id) { nextChosen[entry.name] = true; nextDrafts[entry.name] = draftOf(entry); }
      else if (drafts[entry.name] || outcomes[entry.path]) { nextDrafts[entry.name] = drafts[entry.name] ?? draftOf(entry); nextOutcomes[entry.path] = { name: entry.name, title: drafts[entry.name]?.title || entry.name, meetingId: entry.meeting_id, error: outcomes[entry.path]?.error ?? "" }; }
    }
    setChosen(nextChosen); setDrafts(nextDrafts); setOutcomes(nextOutcomes); setInitialized(true);
  };
  // A scan becomes this review session's fixed Query snapshot. Explicit refresh
  // is the only operation that may replace the human-corrected candidates.
  useEffect(() => {
    if (!open || initialized || scan.isFetching || !scan.data || scan.data.error) return;
    const nextChosen: Record<string, boolean> = {}, nextDrafts: Record<string, Draft> = {};
    for (const entry of scan.data.entries) if (!entry.meeting_id) { nextChosen[entry.name] = true; nextDrafts[entry.name] = draftOf(entry); }
    setChosen(nextChosen); setDrafts(nextDrafts); setInitialized(true);
  }, [open, initialized, scan.isFetching, scan.data]);
  const dirty = fresh.some((entry) => chosen[entry.name] === false || JSON.stringify(drafts[entry.name] ?? draftOf(entry)) !== JSON.stringify(draftOf(entry)));
  const refresh = async () => {
    if (lock.current || scan.isFetching) return;
    const isCurrent = captureContext(); setConfirmRefresh(false);
    const result = await scan.refetch();
    if (isCurrent() && result.data && !result.isError && !result.data.error) { seed(result.data.entries); setSubmitError(""); setDirectoryChanged(false); }
  };

  const edit = (name: string, patch: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [name]: { ...current[name], ...patch } }));

  const selected = fresh.filter((entry) => chosen[entry.name]);
  const scanError = scan.isError || (!scan.isPending && !scan.data)
    ? t(($) => $.import_recovery.scan_failed) : scan.data?.error ?? "";

  const submit = async () => {
    if (lock.current || selected.length === 0 || scan.isFetching || scanError || directoryChanged || !scan.data?.base_dir) return;
    const isCurrent = captureContext(); const submitted = selected.map((entry) => ({ ...entry }));
    lock.current = true; setSubmitting(true); setSubmitError("");
    try {
      const result = await onSubmit(submitted.map((entry) => ({ name: entry.name, ...drafts[entry.name] })), withTask, scan.data.base_dir);
      if (!isCurrent()) return;
      const next: Record<string, ImportOutcome> = {};
      for (const entry of submitted) {
        const meeting = result.meetings.find((item) => item.nas_dir === entry.path && item.id);
        const reason = result.skipped.filter((item) => item.name === entry.name).map((item) => item.reason).join("; ");
        next[entry.path] = { name: entry.name, title: drafts[entry.name]?.title || entry.name, meetingId: meeting?.id ?? null, error: reason || (meeting ? "" : t(($) => $.workflow.unconfirmed)) };
      }
      setOutcomes((previous) => ({ ...previous, ...next }));
      setChosen((previous) => ({ ...previous, ...Object.fromEntries(Object.values(next).filter((outcome) => outcome.meetingId).map((outcome) => [outcome.name, false])) }));
    } catch (cause) {
      if (isCurrent()) { setSubmitError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed)); setDirectoryChanged(errorCode(cause) === "directory_changed"); }
    } finally {
      lock.current = false;
      if (isCurrent()) setSubmitting(false);
    }
  };
  const imported = Object.entries(outcomes).filter(([, outcome]) => outcome.meetingId);
  const registered = scan.data?.entries.filter((entry) => Boolean(entry.meeting_id)) ?? [];


  return (
    <><Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.meetings.scan_title)}</DialogTitle>
          <DialogDescription>{t(($) => $.meetings.scan_description)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <p title={scan.data?.base_dir} className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
              {scan.data?.base_dir || t(($) => $.meetings.scan_no_folder)}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2"
              disabled={scan.isFetching || submitting}
              aria-busy={scan.isFetching}
              onClick={() => { if (dirty || Object.keys(outcomes).length) setConfirmRefresh(true); else void refresh(); }}
            >
              <RotateCw className="size-3.5" />
              {t(($) => $.meetings.scan_again)}
            </Button>
          </div>

          {scan.isLoading ? (
            <p className="text-caption text-muted-foreground">{common(($) => $.loading)}</p>
          ) : scanError ? (
            <p role="alert" className="text-caption text-destructive">{scanError}</p>
          ) : fresh.length === 0 ? imported.length > 0 ? null : (
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
                            disabled={submitting || scan.isFetching}
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
                          <span className="block text-micro text-muted-foreground">{t(($) => $.meetings.scan_files, { n: entry.files })}</span>
                          {outcomes[entry.path]?.error && <p role="alert" className="mt-1 break-words text-caption text-destructive">{outcomes[entry.path]?.error}</p>}
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input disabled={submitting || scan.isFetching}
                            type="date"
                            className="h-7"
                            value={draft.meet_date ?? ""}
                            aria-label={t(($) => $.meetings.scan_field_date, { folder: entry.name })}
                            onChange={(e) => edit(entry.name, { meet_date: e.target.value })}
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input disabled={submitting || scan.isFetching}
                            className="h-7 font-mono text-micro"
                            value={draft.code ?? ""}
                            aria-label={t(($) => $.meetings.scan_field_code, { folder: entry.name })}
                            onChange={(e) => edit(entry.name, { code: e.target.value })}
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input disabled={submitting || scan.isFetching}
                            className="h-7"
                            value={draft.title ?? ""}
                            aria-label={t(($) => $.meetings.scan_field_title, { folder: entry.name })}
                            onChange={(e) => edit(entry.name, { title: e.target.value })}
                          />
                        </td>
                        <td className="py-1.5 pr-2">
                          <Input disabled={submitting || scan.isFetching}
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

          {registered.length > 0 && <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-caption font-medium">{t(($) => $.import_recovery.registered_found, { count: registered.length })}</summary><ul className="mt-2 max-h-56 space-y-2 overflow-y-auto">{registered.map((entry) => <li key={entry.path} className="min-w-0"><AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: entry.meeting_id }, { projectId, moduleId })} target="_blank" rel="noreferrer" className="line-clamp-2 break-words text-caption text-primary underline" title={entry.name}>{entry.name} {t(($) => $.action_flow.new_tab)}</AppLink></li>)}</ul></details>}

          {scan.data?.truncated && (
            <p className="text-caption text-muted-foreground">{t(($) => $.meetings.scan_truncated)}</p>
          )}

          {fresh.length > 0 && (
            <label className="flex items-start gap-2">
              <Checkbox
                disabled={submitting || scan.isFetching}
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

        {imported.length > 0 && <section aria-label={t(($) => $.import_recovery.imported)} className="space-y-2"><h3 className="text-caption font-medium">{t(($) => $.import_recovery.imported)}</h3><ul className="max-h-48 space-y-2 overflow-y-auto">{imported.map(([path, outcome]) => <li key={path} className="rounded-lg border p-3 text-caption"><AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: outcome.meetingId! }, { projectId, moduleId })} target="_blank" rel="noreferrer" className="break-words text-primary underline">{outcome.title} {t(($) => $.action_flow.new_tab)}</AppLink>{outcome.error && <p role="alert" className="mt-1 break-words text-destructive">{outcome.error}</p>}</li>)}</ul></section>}
        {submitError && <p role="alert" className="text-caption text-destructive">{submitError}</p>}

        {directoryChanged && <div role="status" className="space-y-2 text-caption"><p>{t(($) => $.import_recovery.directory_changed)}</p><Button type="button" variant="outline" disabled={scan.isFetching} onClick={() => setConfirmRefresh(true)}>{t(($) => $.import_recovery.rescan_destination)}</Button></div>}
        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {imported.length ? t(($) => $.import_recovery.done) : common(($) => $.cancel)}
          </Button>
          <Button
            disabled={submitting || selected.length === 0 || scan.isFetching || Boolean(scanError) || directoryChanged || !scan.data?.base_dir}
            aria-busy={submitting}
            onClick={() => void submit()}
          >
            {submitting && <Spinner />}
            {t(($) => $.meetings.scan_submit, { n: selected.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={confirmRefresh} onOpenChange={setConfirmRefresh}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t(($) => $.meetings.scan_again)}</AlertDialogTitle><AlertDialogDescription>{t(($) => $.import_recovery.refresh_confirm)}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel render={<Button type="button" variant="outline" />}>{common(($) => $.cancel)}</AlertDialogCancel><Button type="button" onClick={() => void refresh()}>{t(($) => $.meetings.scan_again)}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog></>
  );
}
