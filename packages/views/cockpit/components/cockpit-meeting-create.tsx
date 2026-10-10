"use client";

// Filing a meeting.
//
// Three things happen at once and all three are shown before any of them do:
// the meeting gets a name the platform composes, a task is opened under the
// project and module the programme keeps its meetings in, and a folder is
// created for its material. Each is a checkbox and each says exactly what it
// will produce — the destination project, the module, the absolute path — so
// nothing about this form is a surprise afterwards.

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@multica/core/api";
import { useQuery } from "@tanstack/react-query";
import type {
  CockpitDirectoryEntry,
  CockpitMeetingProvision,
  CockpitMeetingWorkflowSetup,
} from "@multica/core/types";
import {
  cockpitScopeViewKey, useCockpitMeetingCreateDraftStore, prepareCockpitMeetingCreation, settleCockpitMeetingCreation, type CockpitMeetingCreationFields,
  cockpitMeetingDestinationOptions,
  cockpitMeetingFolderName,
  cockpitMeetingPeopleOptions,
  cockpitMeetingVocabulary,
  buildCockpitDisplayCodesFromIndex, cockpitMeetingNextCodeOptions, cockpitContextOptions, cockpitSelectedMemberOptions, useCockpitAssigneeAvailability, cockpitNodeDetailOptions, cockpitSurfacePath, cockpitMeetingContextPath, type CockpitScope,
  splitCockpitMeetingParties,
} from "@multica/core/cockpit";
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
import { Label } from "@multica/ui/components/ui/label";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { CockpitContactNamePicker } from "./cockpit-contact-name-picker";
import { CockpitMemberNamePicker } from "./cockpit-member-name-picker";
import { CockpitAttendeeField } from "./cockpit-attendees";
import { EditableSuggest, EditableTokens } from "./cockpit-fields";
import { CockpitPersonLabel, useCockpitPeople, type CockpitMember } from "./cockpit-people";
import { CockpitAssigneePicker } from "./cockpit-assignee-picker";
import { CockpitScopePicker } from "./cockpit-scope-control";
import { CockpitNodeChoicePicker } from "./cockpit-node-choice";
import { CockpitFlowError } from "./cockpit-task-flow";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink, useNavigation } from "../../navigation";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitReviewerSelect } from "./cockpit-reviewer-select";

/** A picker inside this form reads as a form control, not as a table cell. */
const FIELD_TRIGGER =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-title-sm";

export type CockpitMeetingDraft = CockpitMeetingCreationFields;

export interface CockpitMeetingCreateProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wsId: string;
  scope: CockpitScope;
  today: string;
  /** Already resolved names. Full membership choices are read through paged search. */
  members: CockpitMember[];
  /** Files one contact into the book; resolves whether it landed. */
  onSaveDirectoryEntry: (entry: CockpitDirectoryEntry & { clear_position?: boolean }) => Promise<boolean>;
  onDeleteDirectoryEntry?: (entry: { party: string; name: string }) => Promise<boolean>;
  /** Candidate names; the server determines which are absent from the full book. */
  onAutoSaveDirectory?: (entries: CockpitDirectoryEntry[]) => void;
  /** Pre-selected as the convenor: whoever is filing the meeting. */
  currentUserName: string;
  currentUserId: string;
  savedMeetingId: string | null;
  workflowCreated: boolean;
  /** The board's remembered destination, pre-selected in the pickers. */
  defaultProjectId: string | null;
  defaultModuleId: string | null;
  defaultNodeId: string | null;
  /** Who the board files meeting tasks to. Null means the member filing it. */
  defaultAssigneeType: string | null;
  defaultAssigneeId: string | null;
  /** Resolves once the meeting row exists and provisioning has answered. */
  onSubmit: (draft: CockpitMeetingDraft, provision: CockpitMeetingProvision, workflow: CockpitMeetingWorkflowSetup | null) => Promise<string>;
  onCreated: (id: string) => void;
}

export function CockpitMeetingCreate({
  open,
  onOpenChange,
  wsId, scope,
  today,
  members,
  onSaveDirectoryEntry,
  onDeleteDirectoryEntry,
  onAutoSaveDirectory,
  currentUserName,
  currentUserId,
  savedMeetingId,
  workflowCreated,
  defaultProjectId,
  defaultModuleId,
  defaultNodeId,
  defaultAssigneeType,
  defaultAssigneeId,
  onSubmit, onCreated,
}: CockpitMeetingCreateProps) {
  const { t } = useT("cockpit");
  const { t: common } = useT("common");
  const paths = useWorkspacePaths(); const navigation = useNavigation();
  const draftKey = cockpitScopeViewKey(wsId, scope);
  const pending = useCockpitMeetingCreateDraftStore((state) => state.draft.byScope[draftKey]);
  const captureContext = useCockpitCommandContext(JSON.stringify([draftKey, open]));
  const submitLock = useRef(false);

  const [date, setDate] = useState(today);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [track, setTrack] = useState("");
  const [parties, setParties] = useState("");
  const [organizer, setOrganizer] = useState("");
  const [attendees, setAttendees] = useState("");
  // Names the book does not know yet, as of the last attendee-field commit.
  // The meeting does not exist until submit, so the book must not learn from
  // a draft that may be cancelled: the batch is filed after a successful
  // create, and each commit REPLACES it (the field computes from its whole
  // value, so the latest batch is the answer, never a union).
  const [pendingAutoSave, setPendingAutoSave] = useState<CockpitDirectoryEntry[]>([]);
  const [location, setLocation] = useState("");
  const [subject, setSubject] = useState("");
  // Empty means "follow the generated name"; once someone types, their name
  // wins and nothing regenerates it under them.
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [moduleId, setModuleId] = useState(defaultModuleId ?? "");
  const [nodeId, setNodeId] = useState(defaultNodeId ?? "");
  const [withTask, setWithTask] = useState(true);
  const [withDir, setWithDir] = useState(true);
  // Null is "the member filing the meeting", which is also what an empty
  // assignee tells the server — not "unassigned", a state that would hand the
  // minutes to the workspace's fallback agent and start a run.
  const [assigneeType, setAssigneeType] = useState<string | null>(defaultAssigneeType || null);
  const [assigneeId, setAssigneeId] = useState<string | null>(defaultAssigneeId);
  const [submitting, setSubmitting] = useState(false);
  const [reviewerId, setReviewerId] = useState(currentUserId);
  const [error, setError] = useState("");
  const [creationGone, setCreationGone] = useState(false);
  const wasOpen = useRef(false);

  // Reopening resumes an unconfirmed command; only an acknowledged or rejected command starts a fresh form.
  useEffect(() => {
    if (!open) { wasOpen.current = false; return; }
    if (wasOpen.current) return;
    wasOpen.current = true;
    const recovery = useCockpitMeetingCreateDraftStore.getState().draft.byScope[draftKey];
    setDate(recovery?.meeting.meet_date ?? today);
    setStartTime(recovery?.meeting.start_time ?? "");
    setEndTime(recovery?.meeting.end_time ?? "");
    setKind(recovery?.meeting.kind ?? "");
    setStatus(recovery?.meeting.status ?? "");
    setTrack(recovery?.meeting.track ?? "");
    setParties(recovery?.meeting.parties ?? "");
    // Whoever is filing the meeting is the convenor until they say otherwise;
    // it is the answer in almost every case and it is one fewer box.
    setOrganizer(recovery?.meeting.organizer ?? currentUserName);
    setAttendees(recovery?.meeting.attendees ?? "");
    setPendingAutoSave(recovery?.autoSaveEntries.map((entry) => ({ ...entry, source: "user" })) ?? []);
    setLocation(recovery?.meeting.location ?? "");
    setSubject(recovery?.meeting.title ?? "");
    setProjectId(recovery?.provision.project_id ?? defaultProjectId ?? "");
    setModuleId(recovery?.provision.module_id ?? defaultModuleId ?? "");
    setNodeId(recovery?.meeting.node_id ?? defaultNodeId ?? "");
    setWithTask(recovery ? Boolean(recovery.workflow) : true);
    setWithDir(recovery?.provision.create_dir ?? true);
    setAssigneeType(recovery?.provision.assignee_type || defaultAssigneeType || null);
    setAssigneeId(recovery?.provision.assignee_id ?? defaultAssigneeId);
    setSubmitting(false);
    setReviewerId(recovery?.workflow?.reviewer_id ?? currentUserId);
    setError(""); setCreationGone(false);
  }, [
    open, draftKey,
    today,
    currentUserName,
    currentUserId,
    defaultProjectId,
    defaultModuleId,
    defaultNodeId,
    defaultAssigneeType,
    defaultAssigneeId,
  ]);

  const selectedScope = useQuery({ ...cockpitContextOptions(wsId, { projectId: projectId || null, moduleId: moduleId || null }), enabled: open });
  const selectedNode = useQuery({ ...cockpitNodeDetailOptions(wsId, nodeId, scope), enabled: Boolean(open && nodeId) });
  const executor = useCockpitAssigneeAvailability(wsId, assigneeType || "member", assigneeId || currentUserId);
  const selectedReviewer = useQuery({ ...cockpitSelectedMemberOptions(wsId, reviewerId), enabled: Boolean(open && reviewerId) });
  const requireNode = Boolean(scope.projectId || scope.moduleId);
  const validAnchor = !nodeId ? !requireNode : Boolean(selectedNode.data?.scope_match) && !selectedNode.isError && !selectedNode.isFetching;
  const validReviewer = Boolean(selectedReviewer.data?.items.some((member) => member.id === reviewerId)) && !selectedReviewer.isError && !selectedReviewer.isFetching;
  const destination = useQuery({
    ...cockpitMeetingDestinationOptions(wsId, {
      projectId: projectId || undefined,
      moduleId: moduleId || undefined,
      // Always sent: "" means "file at the module level", which is a
      // different answer from "use whatever the board remembers".
      nodeId,
    }),
    enabled: open && Boolean(wsId) && Boolean(projectId),
  });

  const vocabulary = useMemo(() => cockpitMeetingVocabulary([]), []);
  const people = useCockpitPeople(members);
  // Members lead, then names the board has used, then the rest of the book —
  // a contact is offered before their first meeting.
  const personOptions = useMemo(
    () =>
      cockpitMeetingPeopleOptions(people.names, [
        ...vocabulary.organizers,
        ...vocabulary.attendees,
      ]),
    [people.names, vocabulary.organizers, vocabulary.attendees],
  );
  const partyOptions = useMemo(
    () =>
      vocabulary.parties.sort((a, b) =>
        a.localeCompare(b),
      ),
    [vocabulary.parties],
  );
  const renderPerson = (name: string) => (
    <CockpitPersonLabel name={name} member={people.byName.get(name)} withEmail />
  );
  const nextCode = useQuery({ ...cockpitMeetingNextCodeOptions(wsId, date || today), enabled: Boolean(open && date && !savedMeetingId) });
  const code = nextCode.data?.code ?? "";
  // A meeting is called by its number and its subject — the same two parts
  // the folder and the task are named after, composed in one place so the
  // three cannot drift. It is shown, not offered: a hand-written name is a
  // name the register cannot be read against.
  const name = cockpitMeetingFolderName({ code, title: subject.trim() });
  const folderName = name;

  const projectTitle = selectedScope.data?.scope.project_title ?? "";
  const moduleTitle = selectedScope.data?.scope.module_title ?? "";
  const baseDir = destination.data?.base_dir ?? "";
  const destinationError = destination.data?.error ?? "";
  const canFile = Boolean(projectId && moduleId && selectedScope.data) && !selectedScope.isError && !selectedScope.isFetching;
  // What decides this is whether the server could CREATE the path, not
  // whether every folder on it exists: an archive folder nobody has made yet
  // is an ordinary state of a share that is mounted.
  const canCreateDir = Boolean(baseDir) && (destination.data?.creatable ?? false);
  const willCreateBase = canCreateDir && !(destination.data?.base_dir_exists ?? false);

  const sameSetupSelections = Boolean(pending && withTask === Boolean(pending.workflow) && withDir === Boolean(pending.provision.create_dir)
    && projectId === (pending.provision.project_id ?? "") && moduleId === (pending.provision.module_id ?? "") && nodeId === (pending.provision.node_id ?? "")
    && (assigneeType ?? "") === (pending.provision.assignee_type ?? "") && (assigneeId ?? "") === (pending.provision.assignee_id ?? "")
    && (!pending.workflow || reviewerId === pending.workflow.reviewer_id));
  const canRetry = Boolean(pending && (!pending.meetingId || sameSetupSelections));
  const requestedSetup = withTask && Boolean(projectId && moduleId);
  const invalidNewSetup = requestedSetup && !workflowCreated && (!canFile || !validReviewer || !executor.available);
  const destinationUnknown = withDir && Boolean(projectId) && (destination.isPending || destination.isError || !destination.data);
  const submitDisabled = submitting || (!canRetry && ((!savedMeetingId && !validAnchor) || invalidNewSetup || destinationUnknown));
  const submit = async () => {
    if (submitLock.current || submitDisabled) return;
    const command = prepareCockpitMeetingCreation(draftKey, {
      meeting: pending?.meeting ?? {
        creation_key: crypto.randomUUID(), node_id: nodeId || null, meet_date: date,
        start_time: startTime.trim(), end_time: endTime.trim(), kind: kind.trim(), status: status.trim(), track: track.trim(),
        parties: parties.trim(), organizer: organizer.trim(), attendees: attendees.trim(), location: location.trim(), title: subject.trim(),
      },
      provision: canRetry && pending ? pending.provision : { create_task: false, create_dir: withDir && (canCreateDir || pending?.provision.create_dir === true),
        project_id: projectId || undefined, module_id: moduleId || undefined, node_id: nodeId, base_dir: baseDir || pending?.provision.base_dir || undefined,
        assignee_type: assigneeType ?? "", assignee_id: assigneeId ?? "", remember: true },
      workflow: canRetry && pending ? pending.workflow : withTask && canFile ? { reviewer_id: reviewerId, project_id: projectId, module_id: moduleId,
        node_id: nodeId || undefined, assignee_type: assigneeType || undefined, assignee_id: assigneeId || undefined } : null,
      autoSaveEntries: pendingAutoSave.map(({ party, name, position }) => ({ party, name, position })),
    });
    setWithTask(Boolean(command.workflow)); setWithDir(command.provision.create_dir === true);
    const isCurrent = captureContext(); submitLock.current = true; setSubmitting(true); setError(""); setCreationGone(false);
    try {
      const meetingId = await onSubmit(command.meeting, command.provision, command.workflow);
      settleCockpitMeetingCreation(draftKey, command, "accepted");
      if (isCurrent()) {
        if (command.autoSaveEntries.length > 0) onAutoSaveDirectory?.(command.autoSaveEntries.map((entry) => ({ ...entry, source: "user" })));
        onOpenChange(false);
        onCreated(meetingId);
      }
    } catch (cause) {
      const definite = cause instanceof ApiError && [400, 403, 404, 409, 422].includes(cause.status);
      settleCockpitMeetingCreation(draftKey, command, definite ? "rejected" : "uncertain");
      if (isCurrent()) { setError(cause instanceof Error ? cause.message : t(($) => $.workflow.command_failed)); setCreationGone(cause instanceof ApiError && cause.status === 410); }
    } finally {
      submitLock.current = false;
      if (isCurrent()) setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.meetings.create_title)}</DialogTitle>
          <DialogDescription>{t(($) => $.meetings.create_description)}</DialogDescription>
        </DialogHeader>

        <fieldset disabled={submitting || Boolean(pending && !pending.meetingId)} className="flex min-w-0 flex-col gap-3">
          {savedMeetingId && <div role="status" className="space-y-1 text-caption text-muted-foreground"><p>{t(($) => $.workflow.meeting_saved)}</p><AppLink href={cockpitMeetingContextPath(paths.cockpit(), savedMeetingId, scope, navigation.searchParams)} target="_blank" rel="noreferrer" className="text-primary underline">{t(($) => $.meeting_center.open_saved)}</AppLink></div>}
          <fieldset disabled={submitting || Boolean(savedMeetingId)} className="contents">
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="cockpit-meeting-date">{t(($) => $.meeting.date)}</Label>
              <Input
                id="cockpit-meeting-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="cockpit-meeting-start">{t(($) => $.meeting.start_time)}</Label>
              <Input
                id="cockpit-meeting-start"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="cockpit-meeting-end">{t(($) => $.meeting.end_time)}</Label>
              <Input
                id="cockpit-meeting-end"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1">
              <Label>{t(($) => $.meeting.kind)}</Label>
              <EditableSuggest
                value={kind}
                onCommit={setKind}
                suggestions={vocabulary.kinds}
                label={t(($) => $.meeting.kind)}
                placeholder={t(($) => $.meetings.pick)}
                displayClassName={FIELD_TRIGGER}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t(($) => $.meeting.status)}</Label>
              <EditableSuggest
                value={status}
                onCommit={setStatus}
                suggestions={vocabulary.statuses}
                label={t(($) => $.meeting.status)}
                placeholder={t(($) => $.meetings.pick)}
                displayClassName={FIELD_TRIGGER}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t(($) => $.meeting.location)}</Label>
              <EditableSuggest
                value={location}
                onCommit={setLocation}
                suggestions={vocabulary.locations}
                label={t(($) => $.meeting.location)}
                placeholder={t(($) => $.meetings.pick_or_type)}
                displayClassName={FIELD_TRIGGER}
              />
            </div>
          </div>

          {/* Which line of the programme the meeting advances — the timeline
              lanes on it. Optional: a cross-cutting meeting can stay unfiled. */}
          <div className="flex flex-col gap-1">
            <Label>{t(($) => $.meeting.track)}</Label>
            <EditableSuggest
              value={track}
              onCommit={setTrack}
              suggestions={vocabulary.tracks}
              label={t(($) => $.meeting.track)}
              placeholder={t(($) => $.meetings.pick_or_type)}
              clearLabel={t(($) => $.meetings.track_none)}
              displayClassName={FIELD_TRIGGER}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label>{t(($) => $.meeting.parties)}</Label>
            <EditableTokens
              value={parties}
              onCommit={setParties}
              split={splitCockpitMeetingParties}
              suggestions={partyOptions}
              label={t(($) => $.meeting.parties)}
              placeholder={t(($) => $.meetings.pick_or_type)}
              triggerClassName={FIELD_TRIGGER}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label>{t(($) => $.meeting.organizer)}</Label>
              <EditableSuggest
                value={organizer}
                onCommit={setOrganizer}
                suggestions={personOptions}
                label={t(($) => $.meeting.organizer)}
                placeholder={t(($) => $.meetings.pick_or_type)}
                displayClassName={FIELD_TRIGGER}
                renderDisplay={(name) =>
                  name ? (
                    <CockpitPersonLabel name={name} member={people.byName.get(name)} />
                  ) : (
                    <span className="text-caption text-muted-foreground italic">
                      {t(($) => $.meetings.pick_or_type)}
                    </span>
                  )
                }
                renderOption={renderPerson}
              />
              <CockpitMemberNamePicker wsId={wsId} label={t(($) => $.meeting.organizer)} disabled={submitting || Boolean(savedMeetingId)} onSelect={setOrganizer} />
              <CockpitContactNamePicker wsId={wsId} label={t(($) => $.meeting.organizer)} disabled={submitting || Boolean(savedMeetingId)} onSelect={setOrganizer} />
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t(($) => $.meeting.attendees)}</Label>
              <CockpitAttendeeField
                value={attendees}
                onCommit={setAttendees}
                parties={splitCockpitMeetingParties(parties)}
                wsId={wsId}
                suggestions={personOptions}
                label={t(($) => $.meeting.attendees)}
                placeholder={t(($) => $.meetings.pick_or_type)}
                triggerClassName={FIELD_TRIGGER}
                onSaveEntry={onSaveDirectoryEntry}
                onDeleteEntry={onDeleteDirectoryEntry}
                onAutoSave={setPendingAutoSave}
                renderToken={(name) => (
                  <CockpitPersonLabel name={name} member={people.byName.get(name)} chip />
                )}
                renderOption={renderPerson}
              />
              <CockpitMemberNamePicker wsId={wsId} label={t(($) => $.meeting.attendees)} disabled={submitting || Boolean(savedMeetingId)} onSelect={(name) => setAttendees([...new Set([...splitCockpitMeetingParties(attendees), name])].join("、"))} />
              <p className="text-caption text-muted-foreground">
                {t(($) => $.meetings.directory_hint)}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="cockpit-meeting-subject">{t(($) => $.meetings.create_subject)}</Label>
            <Input
              id="cockpit-meeting-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t(($) => $.meetings.create_subject_placeholder)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-caption text-muted-foreground">
              {t(($) => $.meetings.name_preview)}
            </span>
            {/* Never empty: with no subject yet it is the number alone,
                which is still what the folder and the task will be called. */}
            <p className="font-mono text-body break-all" data-testid="meeting-name-preview">
              {code ? name : subject.trim() || t(($) => $.meeting_center.code_assigned_on_save)}
            </p>
            {nextCode.isError && <div role="alert" className="flex flex-wrap items-center gap-2 text-caption text-destructive">{t(($) => $.meeting_center.code_preview_failed)}<Button type="button" variant="ghost" size="sm" onClick={() => void nextCode.refetch()}>{t(($) => $.binding.retry)}</Button></div>}
            <p className="text-caption text-muted-foreground">
              {t(($) => $.meetings.name_preview_hint)}
            </p>
          </div>

          </fieldset>
          <div className="grid grid-cols-2 gap-3 rounded-md border border-border p-3">
            <div className="col-span-2 text-micro font-medium tracking-wide text-muted-foreground uppercase">
              {t(($) => $.meetings.destination)}
            </div>
            <CockpitScopePicker wsId={wsId} kind="project" projectId={null} selectedId={projectId || null} selectedTitle={projectTitle}
              label={t(($) => $.meetings.destination_project)} disabled={submitting || workflowCreated || Boolean(scope.projectId)}
              emptyLabel={t(($) => $.binding.choose_project)} emptyAction={<AppLink href={paths.projects()} target="_blank" rel="noreferrer" className="text-primary underline">{t(($) => $.task_recovery.open_projects)}</AppLink>}
              onSelect={(id) => { setProjectId(id ?? ""); setModuleId(""); setNodeId(""); }} />
            <CockpitScopePicker wsId={wsId} kind="module" projectId={projectId || null} selectedId={moduleId || null} selectedTitle={moduleTitle}
              label={t(($) => $.meetings.destination_module)} disabled={submitting || workflowCreated || !projectId || Boolean(scope.moduleId)}
              emptyLabel={t(($) => $.binding.choose_module)} emptyAction={projectId ? <AppLink href={paths.projectDetail(projectId)} target="_blank" rel="noreferrer" className="text-primary underline">{t(($) => $.task_recovery.open_project)}</AppLink> : undefined}
              onSelect={(id) => { setModuleId(id ?? ""); setNodeId(""); }} />
            {selectedScope.isError && <div className="col-span-2"><CockpitFlowError onRetry={() => void selectedScope.refetch()} /></div>}
            {requestedSetup && selectedScope.isPending && <p role="status" className="col-span-2 flex items-center gap-2 text-caption text-muted-foreground"><Spinner />{t(($) => $.meeting_center.checking_destination)}</p>}
            {withDir && projectId && destination.isError && <div className="col-span-2"><CockpitFlowError onRetry={() => void destination.refetch()} /></div>}
            {withDir && projectId && destination.isPending && !selectedScope.isPending && <p role="status" className="col-span-2 flex items-center gap-2 text-caption text-muted-foreground"><Spinner />{t(($) => $.meeting_center.checking_destination)}</p>}
            <div className="col-span-2 space-y-1"><Label>{t(($) => $.meetings.destination_node)}</Label>
              <CockpitNodeChoicePicker wsId={wsId} scope={{ projectId: projectId || null, moduleId: moduleId || null }} eligible={false}
                value={selectedNode.data ? `${buildCockpitDisplayCodesFromIndex(selectedNode.data.node_index).get(selectedNode.data.node.id) ?? selectedNode.data.node.code} ${selectedNode.data.node.name}` : nodeId || t(($) => $.meetings.destination_node_none)}
                label={t(($) => $.meetings.destination_node)} allowClear={!requireNode} onClear={() => setNodeId("")}
                disabled={submitting || workflowCreated || Boolean(savedMeetingId)} onSelect={(node) => { setNodeId(node.id); if (!projectId && node.project_id) setProjectId(node.project_id); if (!moduleId && node.module_id) setModuleId(node.module_id); }} />
              {nodeId && selectedNode.isError && <CockpitFlowError onRetry={() => void selectedNode.refetch()} />}
              {requireNode && !nodeId && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_center.anchor_required)}</p>}
              {nodeId && selectedNode.data && !selectedNode.data.scope_match && <p role="alert" className="text-caption text-destructive">{t(($) => $.shell.scope_outside)}</p>}
              <AppLink href={cockpitSurfacePath(paths.cockpit(), "plan", scope)} target="_blank" rel="noopener noreferrer" className="text-caption text-primary underline">{t(($) => $.meeting_center.open_plan_setup)}</AppLink>
              <p className="text-caption text-muted-foreground">{t(($) => $.meetings.destination_node_hint)}</p>
            </div>

            <label className="col-span-2 flex items-start gap-2">
              <Checkbox
                checked={withTask && Boolean(projectId && moduleId)}
                disabled={!projectId || !moduleId || submitting || Boolean(savedMeetingId)}
                onCheckedChange={(checked) => setWithTask(checked === true)}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-body">{t(($) => $.workflow.create_package)}</span>
                <span className="text-caption text-muted-foreground">
                  {!canFile
                    ? requestedSetup ? "" : t(($) => $.meetings.with_task_unset)
                    : destination.data?.node_code
                      ? t(($) => $.meetings.with_task_hint_numbered, {
                          project: projectTitle,
                          module: moduleTitle,
                          code: destination.data.node_code,
                        })
                      : t(($) => $.meetings.with_task_hint, {
                          project: projectTitle,
                          module: moduleTitle,
                        })}
                </span>
              </span>
            </label>

            {/* A workflow creates backlog work first. Readiness and release are separate commands. */}
            {withTask && canFile && (
              <div className="col-span-2 space-y-3 pl-6">
                <p className="text-caption text-muted-foreground">{t(($) => $.workflow.setup_hint)}</p>
                <div className="flex flex-wrap items-center gap-2">
                <span className="shrink-0 text-caption text-muted-foreground">
                  {t(($) => $.workflow.writer)}
                </span>
                <CockpitAssigneePicker wsId={wsId}
                  open={submitting || workflowCreated ? false : undefined}
                  triggerRender={<Button type="button" variant="outline" size="sm" disabled={submitting || workflowCreated} />}
                  assigneeType={assigneeType || "member"}
                  assigneeId={assigneeId || currentUserId}
                  onUpdate={(update) => {
                    if (submitting || workflowCreated) return;
                    setAssigneeType(update.assignee_type ?? null);
                    setAssigneeId(update.assignee_id ?? null);
                  }}
                />
                </div>
                <CockpitReviewerSelect wsId={wsId} value={reviewerId} onChange={setReviewerId} disabled={submitting || workflowCreated} />
              </div>
            )}

            <label className="col-span-2 flex items-start gap-2">
              <Checkbox
                checked={withDir && (canCreateDir || pending?.provision.create_dir === true)}
                disabled={!canCreateDir || submitting}
                onCheckedChange={(checked) => setWithDir(checked === true)}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-body">{t(($) => $.meetings.with_dir)}</span>
                <span className="text-caption break-all text-muted-foreground">
                  {destinationUnknown ? "" : destinationError
                    ? t(($) => $.meetings.with_dir_unavailable, { reason: destinationError })
                    : !baseDir
                      ? t(($) => $.meetings.with_dir_unavailable, {
                          reason: t(($) => $.meetings.with_task_unset),
                        })
                      : !canCreateDir
                        ? t(($) => $.meetings.destination_missing)
                        : !code ? t(($) => $.meeting_center.directory_assigned, { path: baseDir }) : t(($) => $.meetings.with_dir_at, {
                            path: `${baseDir}/${folderName}`,
                          })}
                </span>
                {canCreateDir && willCreateBase && (
                  <span className="text-caption text-muted-foreground">
                    {t(($) => $.meetings.with_dir_creates_base)}
                  </span>
                )}
                {canCreateDir && destination.data?.derived && (
                  <span className="text-caption text-muted-foreground">
                    {t(($) => $.meetings.destination_derived)}
                  </span>
                )}
              </span>
            </label>
          </div>
        </fieldset>

        {pending && !savedMeetingId && <p role="status" className="text-caption text-muted-foreground">{t(($) => $.meeting_center.retry_creation)}</p>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}

        {creationGone && pending && <Button type="button" variant="outline" disabled={submitting} onClick={() => { settleCockpitMeetingCreation(draftKey, pending, "discarded"); setCreationGone(false); setError(""); }}>{t(($) => $.meeting_center.restart_deleted)}</Button>}
        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {common(($) => $.cancel)}
          </Button>
          <Button disabled={submitDisabled} aria-busy={submitting} onClick={() => void submit()}>
            {submitting && <Spinner />}
            {savedMeetingId ? t(($) => $.workflow.retry_setup) : pending ? t(($) => $.binding.retry) : t(($) => $.meetings.create_submit)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
