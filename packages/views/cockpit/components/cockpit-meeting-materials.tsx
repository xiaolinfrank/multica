"use client";

import { useRef, useState } from "react";
import type { CockpitMeeting, CockpitMeetingPatch, CockpitMeetingWorkflowSummary } from "@multica/core/types";
import { acknowledgeCockpitMeetingNotesDraft, cockpitMeetingNotesDraftKey, rebaseCockpitMeetingNotesDraft, setCockpitMeetingNotesDraft, useCockpitMeetingMaterialsDraftStore } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { cn } from "@multica/ui/lib/utils";
import { FolderPlus } from "lucide-react";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { WorkflowIssueLink } from "./cockpit-workflow-issue-link";
import { CockpitPathField } from "./cockpit-path-field";

export function CockpitMeetingMaterials({ wsId, meeting, workflow, workflowHref, readOnly, onSaveMaterialPatch, onPrepareDirectory }: {
  wsId: string; meeting: CockpitMeeting; workflow: CockpitMeetingWorkflowSummary | null | undefined; workflowHref: string; readOnly?: boolean;
  onSaveMaterialPatch: (patch: Pick<CockpitMeetingPatch, "note" | "nas_dir">) => Promise<void>;
  onPrepareDirectory: () => Promise<void>;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const draftKey = cockpitMeetingNotesDraftKey(wsId, meeting.id);
  const draft = useCockpitMeetingMaterialsDraftStore((state) => state.draft.byMeeting[draftKey]);
  const note = draft?.note ?? meeting.note;
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [directoryError, setDirectoryError] = useState("");
  const noteLock = useRef(false);
  const directoryLock = useRef(false);
  const changedElsewhere = Boolean(draft && draft.baseNote !== meeting.note && draft.note !== meeting.note && !saving);
  const issue = workflow?.minutes_issue;
  async function saveNote() {
    if (noteLock.current || readOnly || changedElsewhere) return;
    noteLock.current = true; setSaving(true); setNoteError("");
    try { await onSaveMaterialPatch({ note }); acknowledgeCockpitMeetingNotesDraft(draftKey, note); }
    catch (cause) { setNoteError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed)); }
    finally { noteLock.current = false; setSaving(false); }
  }
  async function prepareDirectory() {
    if (directoryLock.current || readOnly) return;
    directoryLock.current = true; setPreparing(true); setDirectoryError("");
    try { await onPrepareDirectory(); }
    catch (cause) { setDirectoryError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed)); }
    finally { directoryLock.current = false; setPreparing(false); }
  }
  return <section aria-label={t(($) => $.meeting_materials.title)} className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-title-sm font-medium">{t(($) => $.meeting_materials.title)}</h3>
      <AppLink href={workflowHref} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>{t(($) => $.meeting_materials.return_workflow)}</AppLink></div>
    <div className="space-y-3 rounded-lg border border-border p-4">
      <h4 className="text-caption font-medium">{t(($) => $.meeting_materials.issue_inputs)}</h4>
      {issue ? <><WorkflowIssueLink wsId={wsId} issue={issue} newTab />
        <AppLink href={paths.issueDetail(issue.id)} target="_blank" rel="noreferrer" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-auto min-h-8 max-w-full whitespace-normal text-left")}>{t(($) => $.meeting_materials.open_issue)}</AppLink>
        <p className="text-caption text-muted-foreground">{t(($) => $.meeting_materials.issue_hint)}</p></>
        : <><p className="text-caption text-muted-foreground">{t(($) => $.meeting_materials.no_minutes_issue)}</p>
          <AppLink href={workflowHref} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>{t(($) => $.meeting_materials.setup_issue)}</AppLink></>}
    </div>
    <div className="space-y-2 rounded-lg border border-border p-4">
      <label className="block space-y-2 text-caption font-medium">{t(($) => $.meeting_materials.notes)}
        <Textarea value={note} rows={4} readOnly={readOnly} disabled={saving} onChange={(event) => { setCockpitMeetingNotesDraft(draftKey, event.target.value, meeting.note); setNoteError(""); }} /></label>
      <p className="text-caption text-muted-foreground">{t(($) => $.meeting_materials.notes_hint)}</p>
      {changedElsewhere && <div role="alert" className="space-y-2 text-caption"><p>{t(($) => $.meeting_materials.notes_changed)}</p>
        <details><summary className="cursor-pointer">{t(($) => $.meeting_materials.latest_notes)}</summary><p className="mt-2 whitespace-pre-wrap break-words">{meeting.note || t(($) => $.common.unset)}</p></details>
        <Button type="button" size="sm" variant="outline" onClick={() => { rebaseCockpitMeetingNotesDraft(draftKey, meeting.note); setNoteError(""); }}>{t(($) => $.meeting_materials.keep_draft)}</Button></div>}
      {noteError && <p role="alert" className="text-caption text-destructive">{noteError}</p>}
      {!readOnly && <Button type="button" size="sm" disabled={saving || changedElsewhere || !draft} aria-busy={saving} onClick={() => void saveNote()}>
        {saving && <Spinner />}{t(($) => $.meeting_materials.save_notes)}</Button>}
    </div>
    <div className="space-y-2 rounded-lg border border-border p-4">
      <h4 className="text-caption font-medium">{t(($) => $.meeting.folder)}</h4>
      <CockpitPathField value={meeting.nas_dir} label={t(($) => $.meeting.folder)} empty={t(($) => $.meeting.no_folder)} readOnly={readOnly}
        onCommit={(nas_dir) => onSaveMaterialPatch({ nas_dir })}>
        <Button type="button" variant="outline" size="sm" disabled={preparing} aria-busy={preparing} onClick={() => void prepareDirectory()}>
          {preparing ? <Spinner /> : <FolderPlus />}{t(($) => $.meeting.provision_dir)}</Button>
      </CockpitPathField>
      <p className="text-caption text-muted-foreground">{t(($) => $.meeting_materials.directory_hint)}</p>
      {directoryError && <p role="alert" className="text-caption text-destructive">{directoryError}</p>}
    </div>
    <p className="text-caption text-muted-foreground">{t(($) => $.meeting_materials.related_hint)}</p>
  </section>;
}
