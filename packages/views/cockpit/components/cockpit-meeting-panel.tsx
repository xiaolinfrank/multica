"use client";

// One meeting, in full: what was agreed, what it opened, and where its
// material lives. The same panel shape as the work-item panel next door, for
// the same reason — the register and the gantt are two views of one board, and
// a reader should not have to learn a second layout to read a meeting.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  CockpitDirectoryEntry,
  CockpitMeeting,
  CockpitMeetingIssueLink,
  CockpitMeetingNodeLink,
  CockpitMeetingPatch,
} from "@multica/core/types";
import {
  cockpitMeetingWorkflowOptions, cockpitDestination, cockpitMeetingContextPath, cockpitScope,
  cockpitWorkflowSummaryPollInterval,
  type CockpitMeetingVocabularySource,
  cockpitMeetingPeopleOptions,
  cockpitMeetingVocabulary,
  splitCockpitMeetingParties,
} from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Separator } from "@multica/ui/components/ui/separator";
import { Check, ExternalLink, ScanSearch, Trash2, X } from "lucide-react";
import { useT } from "../../i18n";
import {
  CockpitField,
  EditableDate,
  EditableSuggest,
  EditableText,
  EditableTextArea,
  EditableTokens,
} from "./cockpit-fields";
import { CockpitContactNamePicker } from "./cockpit-contact-name-picker";
import { CockpitMemberNamePicker } from "./cockpit-member-name-picker";
import { CockpitAttendeeField } from "./cockpit-attendees";
import { CockpitPersonLabel, useCockpitPeople, type CockpitMember } from "./cockpit-people";
import { CockpitMeetingIssueLinks } from "./cockpit-meeting-issue-links";
import { CockpitNodeChoicePicker } from "./cockpit-node-choice";
import { CockpitMeetingMaterials } from "./cockpit-meeting-materials";
import { CockpitMeetingDirectory } from "./cockpit-meeting-directory";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink, useNavigation } from "../../navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { CockpitMeetingInputs } from "./cockpit-meeting-inputs";
import { CockpitMeetingAgenda } from "./cockpit-meeting-agenda";
import { CockpitMeetingWorkflowPanel } from "./cockpit-meeting-workflow";
import { CockpitMeetingStageAction, CockpitMeetingStageTabs } from "./cockpit-meeting-stage";
import { meetingStageDefaultView } from "./meeting-stage";
import { cockpitMeetingLifecycleOptions } from "@multica/core/cockpit";

export interface CockpitMeetingPanelProps {
  wsId: string;
  currentUserId: string;
  defaultPlacement: { project_id: string | null; module_id: string | null; node_id: string | null };
  defaultAssigneeType: string | null;
  defaultAssigneeId: string | null;
  meeting: CockpitMeeting;
  /** Known metadata for optional suggestions, never the complete meeting register. */
  meetings: CockpitMeetingVocabularySource[];
  /** Already resolved names. Full membership choices are read through paged search. */
  members: CockpitMember[];
  /** Files one contact into the book; resolves whether it landed. */
  onSaveDirectoryEntry: (entry: CockpitDirectoryEntry & { clear_position?: boolean }) => Promise<boolean>;
  onDeleteDirectoryEntry?: (entry: { party: string; name: string }) => Promise<boolean>;
  /** Candidate names; the server determines which are absent from the full book. */
  onAutoSaveDirectory?: (entries: CockpitDirectoryEntry[]) => void;
  issueLinks: CockpitMeetingIssueLink[];
  nodeLinks: CockpitMeetingNodeLink[];
  /** Display codes ("06.06.02") for the linked work items, resolved by the
   *  page so the panel and the gantt address a node the same way. */
  nodeLabels: Map<string, string>;
  nodeCodes: ReadonlyMap<string, string>;
  onPatch: (patch: CockpitMeetingPatch) => void;
  onClose: () => void;
  onDelete: () => void;
  onLinkIssue: (issueId: string) => Promise<unknown>;
  onUnlinkIssue: (issueId: string) => void;
  onSaveIssueRoles?: (issueId: string, roles: string[]) => Promise<unknown>;
  onLinkNode: (nodeId: string) => Promise<unknown>;
  onUnlinkNode: (nodeId: string) => void;
  issuePaging?: React.ReactNode;
  issuePageReady: boolean;
  nodePageReady: boolean;
  nodePaging?: React.ReactNode;
  notice?: React.ReactNode;
  artifactReferences?: React.ReactNode;
  inputsAvailable?: boolean;
  inputManifestAvailable?: boolean;
  lifecycleAvailable?: boolean;
  templatesAvailable?: boolean;
  canAddPreparation?: boolean;
  dispositionAvailable?: boolean;
  directoryPreparationAvailable?: boolean;
  onManageMeeting?: () => void;
  meetingActions?: React.ReactNode;
  authorizedPreparationId?: string | null;
  onPreparationAuthorizationConsumed?: () => void;
  onOpenNode: (nodeId: string) => void;
  onSaveMaterialPatch: (patch: Pick<CockpitMeetingPatch, "note" | "nas_dir">) => Promise<void>;
  onPrepareDirectory: () => Promise<void>;
  readOnly?: boolean;
}

export function CockpitMeetingPanel({
  wsId, currentUserId, defaultPlacement, defaultAssigneeType, defaultAssigneeId,
  meeting,
  meetings,
  members,
  onSaveDirectoryEntry,
  onDeleteDirectoryEntry,
  onAutoSaveDirectory,
  issueLinks,
  nodeLinks,
  nodeLabels, nodeCodes,
  onPatch,
  onClose,
  onDelete,
  onLinkIssue,
  onUnlinkIssue,
  onSaveIssueRoles,
  onLinkNode, onUnlinkNode, issuePaging, nodePaging, issuePageReady, nodePageReady, notice, artifactReferences, inputsAvailable = false, inputManifestAvailable = false, lifecycleAvailable = false, templatesAvailable = false, canAddPreparation, dispositionAvailable = false, directoryPreparationAvailable = false, onManageMeeting, meetingActions, authorizedPreparationId, onPreparationAuthorizationConsumed,
  onOpenNode,
  onSaveMaterialPatch,
  onPrepareDirectory,
  readOnly,
}: CockpitMeetingPanelProps) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const destination = cockpitDestination(navigation.searchParams);
  const directoryOperationId = destination.meetingId === meeting.id ? destination.directoryOperationId : null;
  const nasPoll = useRef({ meetingId: meeting.id, active: false, deadline: 0 });
  const lifecycleQuery = useQuery({ ...cockpitMeetingLifecycleOptions(wsId, meeting.id), enabled: lifecycleAvailable });
  const workflowQuery = useQuery({ ...cockpitMeetingWorkflowOptions(wsId, meeting.id),
    refetchInterval: (query) => {
      const now = Date.now();
      if (nasPoll.current.meetingId !== meeting.id) nasPoll.current = { meetingId: meeting.id, active: false, deadline: 0 };
      const active = cockpitWorkflowSummaryPollInterval(query.state.data, Infinity, now) !== false;
      if (active && !nasPoll.current.active) nasPoll.current.deadline = now + 5 * 60_000;
      nasPoll.current.active = active;
      return cockpitWorkflowSummaryPollInterval(query.state.data, nasPoll.current.deadline, now);
    },
    refetchIntervalInBackground: false,
  });
  const reloadWorkflow = () => {
    nasPoll.current.deadline = Date.now() + 5 * 60_000;
    void workflowQuery.refetch();
  };
  const stageDefault = meetingStageDefaultView(lifecycleQuery.data?.occurrence.state, workflowQuery.data);
  const section = destination.meetingId === meeting.id && destination.meetingView && destination.meetingView !== "agenda" && destination.meetingView !== "workflow" ? destination.meetingView : stageDefault;
  const openSection = (value: "preparation" | "recording" | "minutes_review" | "followup" | "resources" | "details") => navigation.push(cockpitMeetingContextPath(paths.cockpit(), meeting.id, cockpitScope(navigation.searchParams), navigation.searchParams, value));
  // Each stage view mounts its working surface on first visit; the meeting
  // keeps state through the stores, not through duplicated early mounts.
  const [visitedViews, setVisitedViews] = useState<ReadonlySet<string>>(() => new Set([section]));
  useEffect(() => { setVisitedViews((visited) => visited.has(section) ? visited : new Set(visited).add(section)); }, [section]);
  const agendaOpened = visitedViews.has("preparation");
  const recordingOpened = visitedViews.has("recording");
  const agendaHref = cockpitMeetingContextPath(paths.cockpit(), meeting.id, cockpitScope(navigation.searchParams), navigation.searchParams, "preparation");
  const resourcesHref = cockpitMeetingContextPath(paths.cockpit(), meeting.id, cockpitScope(navigation.searchParams), navigation.searchParams, "resources");
  const workflowHref = cockpitMeetingContextPath(paths.cockpit(), meeting.id, cockpitScope(navigation.searchParams), navigation.searchParams, "minutes_review");
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus({ preventScroll: true }); }, []);
  const unset = t(($) => $.common.unset);
  const vocabulary = useMemo(() => cockpitMeetingVocabulary(meetings), [meetings]);
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
  const workflowEnabled = workflowQuery.data?.enabled === true;
  const workflowUnknown = workflowQuery.isPending || workflowQuery.isError || workflowQuery.data?.meeting_id !== meeting.id;
  const legacyReadOnly = readOnly || workflowEnabled || workflowUnknown;
  const requiredRolesByIssue = useMemo(() => {
    const workflow = workflowQuery.data;
    const required = new Map(issueLinks.filter((link) => link.required_roles?.length).map((link) => [link.issue_id, link.required_roles ?? []]));
    if (workflow?.meeting_id === meeting.id && workflow.enabled) {
      if (workflow.minutes_issue) required.set(workflow.minutes_issue.id, ["minutes"]);
      for (const version of [workflow.current_version, workflow.published_version]) {
        if (version) required.set(version.review_issue.id, [...new Set([...(required.get(version.review_issue.id) ?? []), "review"])]);
      }
    }
    return required;
  }, [workflowQuery.data, meeting.id, issueLinks]);

  return (
    <aside className="cockpit-panel-enter flex w-[min(46rem,65vw)] max-w-full shrink-0 flex-col border-l border-border bg-card max-xl:w-full max-xl:border-l-0">
      <header className="flex items-start gap-2 border-b border-border p-3">
        <div className="min-w-0 flex-1">
          <EditableText
            value={meeting.code}
            onCommit={(code) => onPatch({ code })}
            label={t(($) => $.meeting.code)}
            placeholder={t(($) => $.meeting.code)}
            disabled={readOnly}
            displayClassName="font-mono text-micro"
          />
          <div className="mt-1">
            <EditableText
              value={meeting.title}
              onCommit={(title) => onPatch({ title })}
              label={t(($) => $.meeting.title)}
              placeholder={t(($) => $.meeting.title_placeholder)}
              disabled={readOnly}
              displayClassName="text-title-sm font-semibold"
            />
          </div>
        </div>
        <CockpitMeetingStageAction occurrenceState={lifecycleQuery.data?.occurrence.state} workflow={workflowQuery.data} onOpenView={openSection} />
        {meetingActions ?? (!readOnly && <Button variant="ghost" size="icon-sm" disabled={workflowEnabled || workflowUnknown} aria-label={t(($) => $.meeting.delete, { title: meeting.title })} onClick={onDelete}><Trash2 className="size-4" /></Button>)}
        <button
          ref={closeButton}
          type="button"
          onClick={onClose}
          aria-label={t(($) => $.panel.close)}
          className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      {/* A row the scan read off the share says so, until someone says they
          have checked it. Its date, number, parties and subject came from a
          folder name, and presenting a guess as a fact is the one thing the
          scan must not do. */}
      {notice && <div className="border-b p-3">{notice}</div>}
      {meeting.detected && (
        <div className="flex items-start gap-2 border-b border-border bg-warning-subtle px-3 py-2">
          <ScanSearch className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="min-w-0 flex-1 text-caption text-muted-foreground">
            {t(($) => $.meeting.detected_hint)}
          </p>
          {!readOnly && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 shrink-0 gap-1 px-1.5 text-caption"
              onClick={() => onPatch({ detected: false })}
            >
              <Check className="size-3" />
              {t(($) => $.meeting.detected_confirm)}
            </Button>
          )}
        </div>
      )}

      <Tabs value={section} onValueChange={(value) => {
        navigation.push(cockpitMeetingContextPath(paths.cockpit(), meeting.id, cockpitScope(navigation.searchParams), navigation.searchParams, value));
      }} className="min-h-0 flex-1 gap-0">
        <TabsList aria-label={t(($) => $.meeting_stage.strip)} className="h-auto w-full shrink-0 gap-1 rounded-none border-b p-2">
          {lifecycleAvailable && <CockpitMeetingStageTabs occurrenceState={lifecycleQuery.data?.occurrence.state} workflow={workflowQuery.data} />}
          {!lifecycleAvailable && <TabsTrigger value="preparation" className="h-9 flex-1 px-3 text-body">{t(($) => $.meeting_stage.preparation)}</TabsTrigger>}
          <TabsTrigger value="resources" className="ml-auto h-9 px-3 text-caption data-active:bg-accent data-active:text-foreground">{t(($) => $.meeting_stage.tab_resources)}</TabsTrigger>
          <TabsTrigger value="details" className="h-9 px-3 text-caption data-active:bg-accent data-active:text-foreground">{t(($) => $.meeting_stage.tab_details)}</TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TabsContent value="preparation" keepMounted>
            {lifecycleAvailable ? agendaOpened && <CockpitMeetingAgenda key={`${wsId}:${meeting.id}`} wsId={wsId} meetingId={meeting.id} accountId={currentUserId} inputsAvailable={inputsAvailable} readOnly={readOnly} templatesAvailable={templatesAvailable} dispositionAvailable={dispositionAvailable} directoryPreparationAvailable={directoryPreparationAvailable} authorizedPreparationId={authorizedPreparationId} onPreparationAuthorizationConsumed={onPreparationAuthorizationConsumed} /> : <p role="status" className="text-caption">{t(($) => $.feature_availability.unavailable)}</p>}
          </TabsContent>
          <TabsContent value="recording" keepMounted>
            {lifecycleAvailable && recordingOpened && <CockpitMeetingAgenda key={`${wsId}:${meeting.id}:rec`} wsId={wsId} meetingId={meeting.id} accountId={currentUserId} inputsAvailable={inputsAvailable} readOnly={readOnly} templatesAvailable={templatesAvailable} dispositionAvailable={dispositionAvailable} directoryPreparationAvailable={directoryPreparationAvailable} authorizedPreparationId={authorizedPreparationId} onPreparationAuthorizationConsumed={onPreparationAuthorizationConsumed} />}
          </TabsContent>
          <TabsContent value="minutes_review" keepMounted>
            <CockpitMeetingWorkflowPanel wsId={wsId} meetingId={meeting.id} currentUserId={currentUserId}
              members={members} issueLinks={issueLinks} workflow={workflowQuery.data}
              loading={workflowQuery.isPending} loadError={workflowQuery.isError}
              onReload={reloadWorkflow} resourcesHref={resourcesHref} agendaHref={lifecycleAvailable ? agendaHref : undefined} defaultPlacement={defaultPlacement}
              defaultAssigneeType={defaultAssigneeType} defaultAssigneeId={defaultAssigneeId} readOnly={readOnly || !workflowEnabled && canAddPreparation === false} />
          </TabsContent>
          <TabsContent value="followup" keepMounted>
            <CockpitMeetingWorkflowPanel wsId={wsId} meetingId={meeting.id} currentUserId={currentUserId}
              members={members} issueLinks={issueLinks} workflow={workflowQuery.data}
              loading={workflowQuery.isPending} loadError={workflowQuery.isError}
              onReload={reloadWorkflow} resourcesHref={resourcesHref} agendaHref={lifecycleAvailable ? agendaHref : undefined} defaultPlacement={defaultPlacement}
              defaultAssigneeType={defaultAssigneeType} defaultAssigneeId={defaultAssigneeId} readOnly={readOnly || !workflowEnabled && canAddPreparation === false} />
          </TabsContent>
          <TabsContent value="resources" keepMounted>
            <CockpitMeetingDirectory key={`${wsId}:${meeting.id}`} wsId={wsId} meetingId={meeting.id} available={directoryPreparationAvailable} active={section === "resources"} operationId={directoryOperationId} readOnly={readOnly} onManageMeeting={() => onManageMeeting?.()} />
            <div hidden={Boolean(directoryOperationId)} className="space-y-4">
            {inputsAvailable && <CockpitMeetingInputs wsId={wsId} accountId={currentUserId} meetingId={meeting.id} targetLabel={meeting.title} active={section === "resources" && !directoryOperationId} readOnly={readOnly} />}
            {artifactReferences}
            <CockpitMeetingMaterials inputManifestAvailable={inputsAvailable && inputManifestAvailable} wsId={wsId} meeting={meeting} workflow={workflowQuery.data} workflowHref={workflowHref} readOnly={readOnly} directoryPreparationAvailable={directoryPreparationAvailable}
              onSaveMaterialPatch={onSaveMaterialPatch} onPrepareDirectory={onPrepareDirectory} />
        <Separator className="my-3" />

        {/* The tasks the meeting is carried out through. The one the platform
            opened with the meeting leads the list and reads no differently —
            it is an ordinary issue, and unlinking it does not delete it. */}
        <CockpitField label={t(($) => $.meeting.issues)}>
          {issuePageReady && issueLinks.length === 0 ? (
            <p className="text-caption text-muted-foreground">{t(($) => $.meeting.no_issues)}</p>
          ) : null}
          {issuePaging}
          <CockpitMeetingIssueLinks
            wsId={wsId}
            links={issueLinks}
            onLink={onLinkIssue}
            onUnlink={onUnlinkIssue}
            onSaveRoles={onSaveIssueRoles}
            disabled={readOnly || workflowUnknown}
            requiredRolesByIssue={requiredRolesByIssue} canAddPreparation={canAddPreparation}
          />

        </CockpitField>

        <CockpitField label={t(($) => $.meeting.nodes)} className="mt-3">
          {nodePaging}
          {nodePageReady && nodeLinks.length === 0 ? (
            <p className="text-caption text-muted-foreground">{t(($) => $.meeting.no_nodes)}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {nodeLinks.map((link) => {
                const label = nodeLabels.get(link.node_id) ?? link.node_id;
                return (
                  <li key={link.node_id} className="group/node flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onOpenNode(link.node_id)}
                      aria-label={t(($) => $.meeting.open_node, { label })}
                      className="min-w-0 flex-1 truncate rounded-sm px-1 text-left text-caption hover:bg-accent"
                    >
                      {label}
                    </button>
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => onUnlinkNode(link.node_id)}
                        aria-label={t(($) => $.meeting.unlink_node, { label })}
                        className="rounded-full p-0.5 text-muted-foreground opacity-0 group-hover/node:opacity-100 hover:text-foreground focus-visible:opacity-100"
                      >
                        <X className="size-3" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {!readOnly && (
            <CockpitNodeChoicePicker disabled={canAddPreparation === false} wsId={wsId} displayCodes={nodeCodes} eligible={false} scope={cockpitScope(navigation.searchParams)}
              onSelect={(node) => onLinkNode(node.id)} label={t(($) => $.meeting.link_node)} />
          )}
        </CockpitField>

        <Separator className="my-3" />
            </div>
          </TabsContent>
          <TabsContent value="details" keepMounted>
        <div className="grid grid-cols-2 gap-3">
          <CockpitField label={t(($) => $.meeting.date)}>
            <EditableDate
              value={meeting.meet_date}
              onCommit={(meet_date) => onPatch({ meet_date })}
              label={t(($) => $.meeting.date)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={lifecycleAvailable ? t(($) => $.meeting_lifecycle.custom_status) : t(($) => $.meeting.status)}>
            <EditableSuggest
              value={meeting.status}
              onCommit={(status) => onPatch({ status })}
              suggestions={vocabulary.statuses}
              label={lifecycleAvailable ? t(($) => $.meeting_lifecycle.custom_status) : t(($) => $.meeting.status)}
              placeholder={unset}
              disabled={readOnly}
            />
            {lifecycleAvailable && <div className="mt-1 space-y-1 text-caption text-muted-foreground"><p>{t(($) => $.meeting_lifecycle.custom_status_hint)}</p><AppLink href={agendaHref} className="text-primary underline">{t(($) => $.meeting_lifecycle.record_occurrence)}</AppLink></div>}
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.start_time)}>
            <EditableText
              value={meeting.start_time ?? ""}
              onCommit={(next) => onPatch({ start_time: next.trim() ? next.trim() : null })}
              label={t(($) => $.meeting.start_time)}
              placeholder={t(($) => $.meeting.all_day)}
              disabled={readOnly}
              displayClassName="tabular-nums"
            />
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.end_time)}>
            <EditableText
              value={meeting.end_time ?? ""}
              onCommit={(next) => onPatch({ end_time: next.trim() ? next.trim() : null })}
              label={t(($) => $.meeting.end_time)}
              placeholder={t(($) => $.meeting.all_day)}
              disabled={readOnly}
              displayClassName="tabular-nums"
            />
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.kind)}>
            <EditableSuggest
              value={meeting.kind}
              onCommit={(kind) => onPatch({ kind })}
              suggestions={vocabulary.kinds}
              label={t(($) => $.meeting.kind)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.track)}>
            <EditableSuggest
              value={meeting.track}
              onCommit={(track) => onPatch({ track })}
              suggestions={vocabulary.tracks}
              label={t(($) => $.meeting.track)}
              placeholder={unset}
              // The empty state is a lane of its own ("unfiled"), not just an
              // unset field, so the editor names it instead of showing "—".
              clearLabel={t(($) => $.meetings.track_none)}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.location)}>
            <EditableSuggest
              value={meeting.location}
              onCommit={(location) => onPatch({ location })}
              suggestions={vocabulary.locations}
              label={t(($) => $.meeting.location)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.parties)} className="col-span-2">
            <EditableTokens
              value={meeting.parties}
              onCommit={(parties) => onPatch({ parties })}
              split={splitCockpitMeetingParties}
              suggestions={partyOptions}
              label={t(($) => $.meeting.parties)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.organizer)} className="col-span-2">
            <EditableSuggest
              value={meeting.organizer}
              onCommit={(organizer) => onPatch({ organizer })}
              suggestions={personOptions}
              label={t(($) => $.meeting.organizer)}
              placeholder={unset}
              disabled={readOnly}
              renderDisplay={(name) =>
                name ? (
                  <CockpitPersonLabel name={name} member={people.byName.get(name)} />
                ) : (
                  <span className="text-caption text-muted-foreground italic">{unset}</span>
                )
              }
              renderOption={(name) => (
                <CockpitPersonLabel name={name} member={people.byName.get(name)} withEmail />
              )}
            />
            <CockpitMemberNamePicker wsId={wsId} label={t(($) => $.meeting.organizer)} disabled={readOnly} onSelect={(organizer) => onPatch({ organizer })} />
            <CockpitContactNamePicker wsId={wsId} label={t(($) => $.meeting.organizer)} disabled={readOnly} onSelect={(organizer) => onPatch({ organizer })} />
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.attendees)} className="col-span-2">
            <CockpitAttendeeField
              value={meeting.attendees}
              onCommit={(attendees) => onPatch({ attendees })}
              parties={splitCockpitMeetingParties(meeting.parties)}
              wsId={wsId}
              suggestions={personOptions}
              label={t(($) => $.meeting.attendees)}
              placeholder={unset}
              disabled={readOnly}
              onSaveEntry={onSaveDirectoryEntry}
              onDeleteEntry={onDeleteDirectoryEntry}
              onAutoSave={onAutoSaveDirectory}
              renderToken={(name) => (
                <CockpitPersonLabel name={name} member={people.byName.get(name)} chip />
              )}
              renderOption={(name) => (
                <CockpitPersonLabel name={name} member={people.byName.get(name)} withEmail />
              )}
            />
            <CockpitMemberNamePicker wsId={wsId} label={t(($) => $.meeting.attendees)} disabled={readOnly} onSelect={(name) => onPatch({ attendees: [...new Set([...splitCockpitMeetingParties(meeting.attendees), name])].join("、") })} />
            {!readOnly && (
              <p className="text-caption text-muted-foreground">
                {t(($) => $.meetings.directory_hint)}
              </p>
            )}
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.meet_no)}>
            <EditableText
              value={meeting.meet_no}
              onCommit={(meet_no) => onPatch({ meet_no })}
              label={t(($) => $.meeting.meet_no)}
              placeholder={unset}
              disabled={readOnly}
              displayClassName="tabular-nums"
            />
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.link)}>
            <div className="flex min-w-0 items-center gap-1">
              <EditableText
                value={meeting.link}
                onCommit={(link) => onPatch({ link })}
                label={t(($) => $.meeting.link)}
                placeholder={unset}
                disabled={readOnly}
                displayClassName="truncate"
                className="min-w-0"
              />
              {meeting.link && (
                <a
                  href={meeting.link}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t(($) => $.meeting.open)}
                  className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          </CockpitField>
        </div>


            {/* R4: legacy free-text records live in the collapsed auxiliary area —
                the fact layer on the agenda tab is where occurrence facts are read now. */}
            <details className="mt-4 space-y-3 border-t pt-4" aria-label={t(($) => $.workflow.legacy_records)}>
              <summary className="cursor-pointer text-title-sm font-medium text-muted-foreground">{t(($) => $.workflow.legacy_records)}</summary>
              <p className="text-caption text-muted-foreground">{t(($) => $.workflow.legacy_records_hint)}</p>
        <CockpitField label={t(($) => $.meeting.minutes)} className="mt-3">
          <EditableTextArea
            value={meeting.minutes}
            onCommit={(minutes) => onPatch({ minutes })}
            label={t(($) => $.meeting.minutes)}
            placeholder={unset}
            disabled={legacyReadOnly}
            rows={4}
          />
        </CockpitField>
        <CockpitField label={t(($) => $.meeting.decisions)} className="mt-3">
          <EditableTextArea
            value={meeting.decisions}
            onCommit={(decisions) => onPatch({ decisions })}
            label={t(($) => $.meeting.decisions)}
            placeholder={unset}
            disabled={legacyReadOnly}
            rows={3}
          />
        </CockpitField>
        <CockpitField label={t(($) => $.meeting.actions)} className="mt-3">
          <EditableTextArea
            value={meeting.actions}
            onCommit={(actions) => onPatch({ actions })}
            label={t(($) => $.meeting.actions)}
            placeholder={unset}
            disabled={legacyReadOnly}
            rows={3}
          />
        </CockpitField>
            </details>
          </TabsContent>
        </div>
      </Tabs>


    </aside>
  );
}
