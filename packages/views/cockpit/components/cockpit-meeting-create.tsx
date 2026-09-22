"use client";

// Filing a meeting.
//
// Three things happen at once and all three are shown before any of them do:
// the meeting gets a name the platform composes, a task is opened under the
// project and module the programme keeps its meetings in, and a folder is
// created for its material. Each is a checkbox and each says exactly what it
// will produce — the destination project, the module, the absolute path — so
// nothing about this form is a surprise afterwards.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CockpitMeeting,
  CockpitMeetingProvision,
  CockpitNode,
  IssueAssigneeType,
  MemberWithUser,
} from "@multica/core/types";
import {
  buildCockpitMeetingName,
  cockpitArchiveNodeOptions,
  cockpitMeetingDestinationOptions,
  cockpitMeetingFolderName,
  cockpitMeetingPeopleOptions,
  cockpitNodeLabel,
  cockpitMeetingVocabulary,
  nextCockpitMeetingCode,
  splitCockpitMeetingParties,
  splitCockpitMeetingPeople,
} from "@multica/core/cockpit";
import { moduleListOptions } from "@multica/core/modules/queries";
import { projectListOptions } from "@multica/core/projects/queries";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";
import { EditableSuggest, EditableTokens } from "./cockpit-fields";
import { CockpitPersonLabel, useCockpitPeople } from "./cockpit-people";
import { AssigneePicker } from "../../issues/components/pickers/assignee-picker";

/** A picker inside this form reads as a form control, not as a table cell. */
const FIELD_TRIGGER =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-title-sm";

export interface CockpitMeetingDraft {
  meet_date: string;
  start_time: string;
  end_time: string;
  kind: string;
  status: string;
  parties: string;
  organizer: string;
  attendees: string;
  location: string;
  title: string;
  code: string;
}

/** The archive sub-item picker's "file at the module level" answer. Select
 *  items cannot carry an empty value, and "" is a meaningful answer here. */
const MODULE_LEVEL = "__module__";

export interface CockpitMeetingCreateProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  wsId: string;
  today: string;
  meetings: CockpitMeeting[];
  /** The board's tree, which the archive sub-item is chosen from. */
  nodes: CockpitNode[];
  /** The workspace's people, offered by name in the person fields. */
  members: MemberWithUser[];
  /** Pre-selected as the convenor: whoever is filing the meeting. */
  currentUserName: string;
  /** The board's remembered destination, pre-selected in the pickers. */
  defaultProjectId: string | null;
  defaultModuleId: string | null;
  defaultNodeId: string | null;
  /** Who the board files meeting tasks to. Null means the member filing it. */
  defaultAssigneeType: string | null;
  defaultAssigneeId: string | null;
  /** Resolves once the meeting row exists and provisioning has answered. */
  onSubmit: (draft: CockpitMeetingDraft, provision: CockpitMeetingProvision) => Promise<unknown>;
}

export function CockpitMeetingCreate({
  open,
  onOpenChange,
  wsId,
  today,
  meetings,
  nodes,
  members,
  currentUserName,
  defaultProjectId,
  defaultModuleId,
  defaultNodeId,
  defaultAssigneeType,
  defaultAssigneeId,
  onSubmit,
}: CockpitMeetingCreateProps) {
  const { t } = useT("cockpit");
  const { t: common } = useT("common");

  const [date, setDate] = useState(today);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [parties, setParties] = useState("");
  const [organizer, setOrganizer] = useState("");
  const [attendees, setAttendees] = useState("");
  const [location, setLocation] = useState("");
  const [subject, setSubject] = useState("");
  // Empty means "follow the generated name"; once someone types, their name
  // wins and nothing regenerates it under them.
  const [nameOverride, setNameOverride] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [moduleId, setModuleId] = useState(defaultModuleId ?? "");
  const [nodeId, setNodeId] = useState(defaultNodeId ?? "");
  const [withTask, setWithTask] = useState(true);
  const [withDir, setWithDir] = useState(true);
  // Null is "the member filing the meeting", which is also what an empty
  // assignee tells the server — not "unassigned", a state that would hand the
  // minutes to the workspace's fallback agent and start a run.
  const [assigneeType, setAssigneeType] = useState<IssueAssigneeType | null>(
    (defaultAssigneeType || null) as IssueAssigneeType | null,
  );
  const [assigneeId, setAssigneeId] = useState<string | null>(defaultAssigneeId);
  const [submitting, setSubmitting] = useState(false);

  // Re-opening the form starts a new meeting, not the last one again.
  useEffect(() => {
    if (!open) return;
    setDate(today);
    setStartTime("");
    setEndTime("");
    setKind("");
    setStatus("");
    setParties("");
    // Whoever is filing the meeting is the convenor until they say otherwise;
    // it is the answer in almost every case and it is one fewer box.
    setOrganizer(currentUserName);
    setAttendees("");
    setLocation("");
    setSubject("");
    setNameOverride("");
    setProjectId(defaultProjectId ?? "");
    setModuleId(defaultModuleId ?? "");
    setNodeId(defaultNodeId ?? "");
    setWithTask(true);
    setWithDir(true);
    setAssigneeType((defaultAssigneeType || null) as IssueAssigneeType | null);
    setAssigneeId(defaultAssigneeId);
    setSubmitting(false);
  }, [
    open,
    today,
    currentUserName,
    defaultProjectId,
    defaultModuleId,
    defaultNodeId,
    defaultAssigneeType,
    defaultAssigneeId,
  ]);

  const projects = useQuery({ ...projectListOptions(wsId), enabled: open && Boolean(wsId) });
  const modules = useQuery({
    ...moduleListOptions(wsId, projectId || undefined),
    enabled: open && Boolean(wsId),
  });
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

  const vocabulary = useMemo(() => cockpitMeetingVocabulary(meetings), [meetings]);
  const people = useCockpitPeople(members);
  const personOptions = useMemo(
    () => cockpitMeetingPeopleOptions(people.names, [...vocabulary.organizers, ...vocabulary.attendees]),
    [people.names, vocabulary.organizers, vocabulary.attendees],
  );
  const renderPerson = (name: string) => (
    <CockpitPersonLabel name={name} member={people.byName.get(name)} withEmail />
  );
  const code = useMemo(() => nextCockpitMeetingCode(meetings, date || today), [meetings, date, today]);
  const generated = useMemo(
    () => buildCockpitMeetingName({ code, parties, subject }),
    [code, parties, subject],
  );
  const name = nameOverride.trim() ? nameOverride : generated;
  const folderName = cockpitMeetingFolderName({ code, title: name });

  const projectTitle =
    projects.data?.find((p) => p.id === projectId)?.title ?? destination.data?.project_title ?? "";
  const moduleTitle =
    modules.data?.find((m) => m.id === moduleId)?.title ?? destination.data?.module_title ?? "";
  const archiveNodes = useMemo(
    () => cockpitArchiveNodeOptions(nodes, moduleTitle, nodeId || null),
    [nodes, moduleTitle, nodeId],
  );
  const baseDir = destination.data?.base_dir ?? "";
  const destinationError = destination.data?.error ?? "";
  const canFile = Boolean(projectId && moduleId);
  // What decides this is whether the server could CREATE the path, not
  // whether every folder on it exists: an archive folder nobody has made yet
  // is an ordinary state of a share that is mounted.
  const canCreateDir = Boolean(baseDir) && (destination.data?.creatable ?? false);
  const willCreateBase = canCreateDir && !(destination.data?.base_dir_exists ?? false);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(
        {
          meet_date: date,
          start_time: startTime.trim(),
          end_time: endTime.trim(),
          kind: kind.trim(),
          status: status.trim(),
          parties: parties.trim(),
          organizer: organizer.trim(),
          attendees: attendees.trim(),
          location: location.trim(),
          title: name.trim() || code,
          code,
        },
        {
          create_task: withTask && canFile,
          create_dir: withDir && canCreateDir,
          project_id: projectId || undefined,
          module_id: moduleId || undefined,
          node_id: nodeId,
          base_dir: baseDir || undefined,
          // Always sent, including empty: this is the board's stored choice
          // being confirmed or cleared, and an absent key would mean "leave
          // it alone".
          assignee_type: assigneeType ?? "",
          assignee_id: assigneeId ?? "",
          remember: true,
        },
      );
      // Only closes once the write came back — a failed create must leave the
      // form and everything typed into it exactly where they were.
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (submitting ? undefined : onOpenChange(next))}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.meetings.create_title)}</DialogTitle>
          <DialogDescription>{t(($) => $.meetings.create_description)}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
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

          <div className="flex flex-col gap-1">
            <Label>{t(($) => $.meeting.parties)}</Label>
            <EditableTokens
              value={parties}
              onCommit={setParties}
              split={splitCockpitMeetingParties}
              suggestions={vocabulary.parties}
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
            </div>
            <div className="flex flex-col gap-1">
              <Label>{t(($) => $.meeting.attendees)}</Label>
              <EditableTokens
                value={attendees}
                onCommit={setAttendees}
                split={splitCockpitMeetingPeople}
                suggestions={personOptions}
                label={t(($) => $.meeting.attendees)}
                placeholder={t(($) => $.meetings.pick_or_type)}
                triggerClassName={FIELD_TRIGGER}
                renderToken={(name) => (
                  <CockpitPersonLabel name={name} member={people.byName.get(name)} chip />
                )}
                renderOption={renderPerson}
              />
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
            <Label htmlFor="cockpit-meeting-name">{t(($) => $.meetings.name_preview)}</Label>
            <Input
              id="cockpit-meeting-name"
              value={name}
              onChange={(e) => setNameOverride(e.target.value)}
            />
            <p className="text-caption text-muted-foreground">
              {t(($) => $.meetings.name_preview_hint)}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-md border border-border p-3">
            <div className="col-span-2 text-micro font-medium tracking-wide text-muted-foreground uppercase">
              {t(($) => $.meetings.destination)}
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="cockpit-meeting-project">
                {t(($) => $.meetings.destination_project)}
              </Label>
              <Select
                items={(projects.data ?? []).map((p) => ({ value: p.id, label: p.title }))}
                value={projectId}
                onValueChange={(value) => {
                  setProjectId(typeof value === "string" ? value : "");
                  setModuleId("");
                  setNodeId("");
                }}
              >
                <SelectTrigger id="cockpit-meeting-project" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(projects.data ?? []).map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="cockpit-meeting-module">
                {t(($) => $.meetings.destination_module)}
              </Label>
              <Select
                items={(modules.data ?? []).map((m) => ({ value: m.id, label: m.title }))}
                value={moduleId}
                onValueChange={(value) => {
                  setModuleId(typeof value === "string" ? value : "");
                  setNodeId("");
                }}
              >
                <SelectTrigger id="cockpit-meeting-module" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(modules.data ?? []).map((module) => (
                    <SelectItem key={module.id} value={module.id}>
                      {module.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="col-span-2 flex flex-col gap-1">
              <Label htmlFor="cockpit-meeting-node">{t(($) => $.meetings.destination_node)}</Label>
              <Select
                items={[
                  { value: MODULE_LEVEL, label: t(($) => $.meetings.destination_node_none) },
                  ...archiveNodes.map((node) => ({ value: node.id, label: cockpitNodeLabel(node) })),
                ]}
                value={nodeId || MODULE_LEVEL}
                onValueChange={(value) =>
                  setNodeId(typeof value === "string" && value !== MODULE_LEVEL ? value : "")
                }
              >
                <SelectTrigger id="cockpit-meeting-node" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={MODULE_LEVEL}>
                    {t(($) => $.meetings.destination_node_none)}
                  </SelectItem>
                  {archiveNodes.map((node) => (
                    <SelectItem key={node.id} value={node.id}>
                      {cockpitNodeLabel(node)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-caption text-muted-foreground">
                {t(($) => $.meetings.destination_node_hint)}
              </p>
            </div>

            <label className="col-span-2 flex items-start gap-2">
              <Checkbox
                checked={withTask && canFile}
                disabled={!canFile}
                onCheckedChange={(checked) => setWithTask(checked === true)}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-body">{t(($) => $.meetings.with_task)}</span>
                <span className="text-caption text-muted-foreground">
                  {!canFile
                    ? t(($) => $.meetings.with_task_unset)
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

            {/* Who writes the minutes is a standing answer, not a per-meeting
                one, so the choice made here becomes the board's default.
                Assigning an agent starts a run the moment the task is filed —
                that is the point when the minutes are an agent's job, and the
                reason the fallback is a person rather than the workspace's
                cluster agent. */}
            {withTask && canFile && (
              <div className="col-span-2 flex items-center gap-2 pl-6">
                <span className="shrink-0 text-caption text-muted-foreground">
                  {t(($) => $.meetings.task_assignee)}
                </span>
                <AssigneePicker
                  assigneeType={assigneeType}
                  assigneeId={assigneeId}
                  onUpdate={(update) => {
                    setAssigneeType(update.assignee_type ?? null);
                    setAssigneeId(update.assignee_id ?? null);
                  }}
                />
              </div>
            )}

            <label className="col-span-2 flex items-start gap-2">
              <Checkbox
                checked={withDir && canCreateDir}
                disabled={!canCreateDir}
                onCheckedChange={(checked) => setWithDir(checked === true)}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-body">{t(($) => $.meetings.with_dir)}</span>
                <span className="text-caption break-all text-muted-foreground">
                  {destinationError
                    ? t(($) => $.meetings.with_dir_unavailable, { reason: destinationError })
                    : !baseDir
                      ? t(($) => $.meetings.with_dir_unavailable, {
                          reason: t(($) => $.meetings.with_task_unset),
                        })
                      : !canCreateDir
                        ? t(($) => $.meetings.destination_missing)
                        : t(($) => $.meetings.with_dir_at, {
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
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            {common(($) => $.cancel)}
          </Button>
          <Button disabled={submitting} aria-busy={submitting} onClick={() => void submit()}>
            {submitting && <Spinner />}
            {t(($) => $.meetings.create_submit)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
