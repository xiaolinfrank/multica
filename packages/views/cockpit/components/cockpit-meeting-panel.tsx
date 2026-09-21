"use client";

// One meeting, in full: what was agreed, what it opened, and where its
// material lives. The same panel shape as the work-item panel next door, for
// the same reason — the register and the gantt are two views of one board, and
// a reader should not have to learn a second layout to read a meeting.

import { useMemo } from "react";
import type {
  CockpitMeeting,
  CockpitMeetingIssueLink,
  CockpitMeetingNodeLink,
  CockpitMeetingPatch,
  CockpitNode,
} from "@multica/core/types";
import { cockpitMeetingVocabulary } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Separator } from "@multica/ui/components/ui/separator";
import { ExternalLink, FolderPlus, ListChecks, Trash2, X } from "lucide-react";
import { useT } from "../../i18n";
import { LocalPathLink } from "../../common/local-path-link";
import {
  CockpitField,
  EditableDate,
  EditableSuggest,
  EditableText,
  EditableTextArea,
} from "./cockpit-fields";
import { CockpitIssueLinks } from "./cockpit-issue-links";
import { CockpitNodePicker } from "./cockpit-node-picker";

export interface CockpitMeetingPanelProps {
  meeting: CockpitMeeting;
  nodes: CockpitNode[];
  /** Every meeting on the board — the vocabulary pickers offer what the
   *  programme has already used rather than an invented enum. */
  meetings: CockpitMeeting[];
  issueLinks: CockpitMeetingIssueLink[];
  nodeLinks: CockpitMeetingNodeLink[];
  /** Display codes ("06.06.02") for the linked work items, resolved by the
   *  page so the panel and the gantt address a node the same way. */
  nodeLabels: Map<string, string>;
  onPatch: (patch: CockpitMeetingPatch) => void;
  onClose: () => void;
  onDelete: () => void;
  onLinkIssue: (issueId: string) => void;
  onUnlinkIssue: (issueId: string) => void;
  onToggleNode: (nodeId: string) => void;
  onOpenNode: (nodeId: string) => void;
  /** Re-runs the parts of provisioning that have not happened yet. */
  onProvision: (parts: { task?: boolean; dir?: boolean }) => void;
  provisioning?: boolean;
  readOnly?: boolean;
}

export function CockpitMeetingPanel({
  meeting,
  nodes,
  meetings,
  issueLinks,
  nodeLinks,
  nodeLabels,
  onPatch,
  onClose,
  onDelete,
  onLinkIssue,
  onUnlinkIssue,
  onToggleNode,
  onOpenNode,
  onProvision,
  provisioning,
  readOnly,
}: CockpitMeetingPanelProps) {
  const { t } = useT("cockpit");
  const unset = t(($) => $.common.unset);
  const vocabulary = useMemo(() => cockpitMeetingVocabulary(meetings), [meetings]);
  const linkedNodeIds = useMemo(() => new Set(nodeLinks.map((l) => l.node_id)), [nodeLinks]);
  const hasTask = issueLinks.some((link) => link.role === "task");

  return (
    <aside className="flex w-96 shrink-0 flex-col border-l border-border bg-card">
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
        <button
          type="button"
          onClick={onClose}
          aria-label={t(($) => $.panel.close)}
          className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3">
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
          <CockpitField label={t(($) => $.meeting.status)}>
            <EditableSuggest
              value={meeting.status}
              onCommit={(status) => onPatch({ status })}
              suggestions={vocabulary.statuses}
              label={t(($) => $.meeting.status)}
              placeholder={unset}
              disabled={readOnly}
            />
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
          <CockpitField label={t(($) => $.meeting.series)}>
            <EditableSuggest
              value={meeting.series}
              onCommit={(series) => onPatch({ series })}
              suggestions={vocabulary.series}
              label={t(($) => $.meeting.series)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.parties)} className="col-span-2">
            <EditableText
              value={meeting.parties}
              onCommit={(parties) => onPatch({ parties })}
              label={t(($) => $.meeting.parties)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.attendees)} className="col-span-2">
            <EditableTextArea
              value={meeting.attendees}
              onCommit={(attendees) => onPatch({ attendees })}
              label={t(($) => $.meeting.attendees)}
              placeholder={unset}
              disabled={readOnly}
              rows={2}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.meeting.organizer)}>
            <EditableSuggest
              value={meeting.organizer}
              onCommit={(organizer) => onPatch({ organizer })}
              suggestions={vocabulary.organizers}
              label={t(($) => $.meeting.organizer)}
              placeholder={unset}
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

        <Separator className="my-3" />

        <CockpitField label={t(($) => $.meeting.agenda)}>
          <EditableTextArea
            value={meeting.note}
            onCommit={(note) => onPatch({ note })}
            label={t(($) => $.meeting.agenda)}
            placeholder={t(($) => $.meeting.no_agenda)}
            disabled={readOnly}
            rows={3}
          />
        </CockpitField>
        <CockpitField label={t(($) => $.meeting.minutes)} className="mt-3">
          <EditableTextArea
            value={meeting.minutes}
            onCommit={(minutes) => onPatch({ minutes })}
            label={t(($) => $.meeting.minutes)}
            placeholder={unset}
            disabled={readOnly}
            rows={4}
          />
        </CockpitField>
        <CockpitField label={t(($) => $.meeting.decisions)} className="mt-3">
          <EditableTextArea
            value={meeting.decisions}
            onCommit={(decisions) => onPatch({ decisions })}
            label={t(($) => $.meeting.decisions)}
            placeholder={unset}
            disabled={readOnly}
            rows={3}
          />
        </CockpitField>
        <CockpitField label={t(($) => $.meeting.actions)} className="mt-3">
          <EditableTextArea
            value={meeting.actions}
            onCommit={(actions) => onPatch({ actions })}
            label={t(($) => $.meeting.actions)}
            placeholder={unset}
            disabled={readOnly}
            rows={3}
          />
        </CockpitField>

        <Separator className="my-3" />

        {/* The tasks the meeting is carried out through. The one the platform
            opened with the meeting leads the list and reads no differently —
            it is an ordinary issue, and unlinking it does not delete it. */}
        <CockpitField label={t(($) => $.meeting.issues)}>
          {issueLinks.length === 0 ? (
            <p className="text-caption text-muted-foreground">{t(($) => $.meeting.no_issues)}</p>
          ) : null}
          <CockpitIssueLinks
            links={issueLinks}
            onLink={onLinkIssue}
            onUnlink={onUnlinkIssue}
            disabled={readOnly}
          />
          {!readOnly && !hasTask && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1 h-6 w-fit gap-1 px-1.5 text-caption"
              disabled={provisioning}
              aria-busy={provisioning}
              onClick={() => onProvision({ task: true })}
            >
              <ListChecks className="size-3" />
              {t(($) => $.meeting.provision_task)}
            </Button>
          )}
        </CockpitField>

        <CockpitField label={t(($) => $.meeting.nodes)} className="mt-3">
          {nodeLinks.length === 0 ? (
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
                        onClick={() => onToggleNode(link.node_id)}
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
            <CockpitNodePicker
              nodes={nodes}
              selectedIds={linkedNodeIds}
              onToggle={onToggleNode}
              label={t(($) => $.meeting.link_node)}
            />
          )}
        </CockpitField>

        <CockpitField label={t(($) => $.meeting.folder)} className="mt-3">
          {meeting.nas_dir ? (
            <LocalPathLink path={meeting.nas_dir} wrap="truncate" />
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-caption text-muted-foreground">
                {t(($) => $.meeting.no_folder)}
              </span>
              {!readOnly && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-caption"
                  disabled={provisioning}
                  aria-busy={provisioning}
                  onClick={() => onProvision({ dir: true })}
                >
                  <FolderPlus className="size-3" />
                  {t(($) => $.meeting.provision_dir)}
                </Button>
              )}
            </div>
          )}
        </CockpitField>
      </div>

      {!readOnly && (
        <footer className="border-t border-border p-3">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" />
            {t(($) => $.meeting.delete, { title: meeting.title })}
          </Button>
        </footer>
      )}
    </aside>
  );
}
