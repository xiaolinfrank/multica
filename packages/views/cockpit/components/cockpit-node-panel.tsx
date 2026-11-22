"use client";

// Structural levels expose basic fields; task-level details remain stored when hidden.

import type {
  CockpitNode,
  CockpitNodePatch,
} from "@multica/core/types";
import type { CockpitPlanTaskCount } from "@multica/core/types/cockpit-read";
import { useEffect, useRef, useState } from "react";
import { cockpitIssueProgress, type CockpitNodeView } from "@multica/core/cockpit";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Separator } from "@multica/ui/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multica/ui/components/ui/tabs";
import { cn } from "@multica/ui/lib/utils";
import { LoaderCircle, Trash2, X } from "lucide-react";
import { useT } from "../../i18n";
import { AppLink, useNavigation } from "../../navigation";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import {
  CockpitField,
  EditableDate,
  EditableSuggest,
  EditableText,
  EditableTextArea,
  ProgressField,
} from "./cockpit-fields";
import { StatusChip } from "./cockpit-status";

export interface CockpitNodePanelProps {
  node: CockpitNode;
  /** The row's shipped (summary-tree) code, shown when it differs from the
   * stored code. */
  displayCode?: string;
  parent: CockpitNode | undefined;
  /** The issue roll-up the plan read already has for this row. A work item
   *  with issues takes its progress from them instead of a typed number. */
  issueCounts?: CockpitPlanTaskCount | null;
  /** Meetings that discussed this node: a count link into the register. */
  meetingCount: number;
  meetingsHref: string;
  isBranch: boolean;
  statusSuggestions: string[];
  ownerSuggestions: string[];
  onPatch: (patch: CockpitNodePatch) => void;
  notice?: React.ReactNode;
  taskWorkspace?: React.ReactNode;
  referenceWorkspace?: React.ReactNode;
  section: CockpitNodeView;
  onSectionChange: (section: CockpitNodeView) => void;
  /** Resolve only after the server has deleted the node; reject on failure. */
  onDelete: () => Promise<unknown>;
  deleteAllowed: boolean;
  deleteRestriction?: React.ReactNode;
  /** Localized destructive consequences, including descendants for a branch. */
  deleteConfirmationDescription: string;
  /** Zero-based tree depth, matching CockpitTreeNode.depth. */
  depth: number;
  onClose: () => void;
  readOnly?: boolean;
}

export function CockpitNodePanel({
  node,
  displayCode,
  parent,
  issueCounts,
  meetingCount,
  meetingsHref,
  isBranch,
  statusSuggestions,
  ownerSuggestions,
  onPatch,
  notice,
  taskWorkspace,
  referenceWorkspace,
  section,
  onSectionChange,
  onDelete,
  deleteAllowed,
  deleteRestriction,
  deleteConfirmationDescription,
  depth,
  onClose,
  readOnly,
}: CockpitNodePanelProps) {
  const { t } = useT("cockpit");
  const { t: common } = useT("common");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const deletingRef = useRef(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const taskDetails = Boolean(taskWorkspace) || depth >= 2;
  const navigation = useNavigation();
  const deleteContext = JSON.stringify([node.id, section, navigation.pathname, navigation.searchParams.toString()]);
  const captureDelete = useCockpitCommandContext(deleteContext);
  useEffect(() => { deletingRef.current = false; setConfirmOpen(false); setDeleting(false); setDeleteFailed(false); }, [deleteContext]);

  useEffect(() => { closeButton.current?.focus(); }, [node.id]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || confirmOpen) return;
      // Editors and other popups consume Escape before it reaches the panel.
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]')) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable=true]")) return;
      onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [confirmOpen, onClose]);

  const confirmDelete = async () => {
    if (deletingRef.current || !deleteAllowed) return;
    const isCurrent = captureDelete();
    deletingRef.current = true;
    setDeleting(true);
    setDeleteFailed(false);
    try {
      await onDelete();
      if (isCurrent()) { setConfirmOpen(false); onClose(); }
    } catch {
      if (isCurrent()) setDeleteFailed(true);
    } finally {
      if (isCurrent()) { deletingRef.current = false; setDeleting(false); }
    }
  };

  const unset = t(($) => $.common.unset);
  // A work item that owns issues takes its progress from them: the ratio is
  // a read-out, not a field. Without issues the typed value stays.
  const issueRatio = !isBranch && (issueCounts?.primary_total ?? 0) > 0
    ? cockpitIssueProgress(issueCounts ?? null)
    : null;
  const progressFromIssues = !isBranch && (issueCounts?.primary_total ?? 0) > 0;

  return (
    <aside className={cn("cockpit-workbench cockpit-panel-enter @container/node-panel flex min-w-0 max-w-full shrink-0 flex-col border-l border-border bg-card @max-[80rem]/cockpit:w-full @max-[80rem]/cockpit:border-l-0",
      (taskWorkspace || referenceWorkspace) ? "w-[54rem]" : "w-96")}>
      <header tabIndex={0} className="cockpit-workbench-header flex max-h-[30%] shrink-0 items-start gap-2 overflow-y-auto border-b border-border p-4 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {parent && (
              <span className="truncate font-mono text-micro text-muted-foreground">
                {parent.code}
              </span>
            )}
            {displayCode && displayCode !== node.code && (
              <span
                className="font-mono text-micro font-medium"
                aria-label={t(($) => $.node.row_code, { code: displayCode })}
                title={t(($) => $.node.row_code, { code: displayCode })}
              >
                {displayCode}
              </span>
            )}
            {/* The code is an address, not a field: it moves only by
                renumbering the level that owns it. */}
            <span className={cn("font-mono text-micro", displayCode && displayCode !== node.code && "text-muted-foreground")}>
              {node.code}
            </span>
          </div>
          <div className="mt-1">
            <EditableText
              value={node.name}
              onCommit={(name) => onPatch({ name })}
              label={t(($) => $.node.name)}
              placeholder={t(($) => $.node.name_placeholder)}
              disabled={readOnly}
              displayClassName="max-w-full whitespace-normal break-words text-title-sm font-semibold [overflow-wrap:anywhere]"
            />
          </div>
        </div>
        <button
          ref={closeButton}
          type="button"
          onClick={onClose}
          disabled={deleting}
          aria-label={t(($) => $.panel.close)}
          className="sticky top-0 z-10 flex size-8 shrink-0 items-center justify-center rounded-md bg-card text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      </header>

      {notice && <div className="shrink-0 border-b border-border p-3">{notice}</div>}
      <Tabs value={!taskWorkspace ? "details" : section === "tasks" || section === "details" ? section : "details"} onValueChange={(value) => { if (value === "tasks" || value === "details") onSectionChange(value); }} className="min-h-0 flex-1 gap-0">
        {taskWorkspace && <TabsList variant="line" className="min-h-11 w-full shrink-0 flex-wrap border-b border-border px-4 py-1 group-data-horizontal/tabs:h-auto">
          <TabsTrigger value="tasks" className="h-9">{t(($) => $.task_flow.tasks_tab)}</TabsTrigger>
          <TabsTrigger value="details" className="h-9">{t(($) => $.task_flow.details_tab)}</TabsTrigger>
        </TabsList>}
        {taskWorkspace && <TabsContent value="tasks" keepMounted className="min-h-0 overflow-y-auto p-4">{taskWorkspace}</TabsContent>}
        <TabsContent value="details" className="min-h-0 min-w-0 overflow-y-auto overscroll-contain p-4">
        <div className="grid min-w-0 grid-cols-1 gap-4 @min-[28rem]/node-panel:grid-cols-2">
          <CockpitField label={t(($) => $.node.owner)}>
            <EditableSuggest
              value={node.owner}
              onCommit={(owner) => onPatch({ owner })}
              suggestions={ownerSuggestions}
              label={t(($) => $.node.owner)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.node.status)}>
            <EditableSuggest
              value={node.status}
              onCommit={(status) => onPatch({ status })}
              suggestions={statusSuggestions}
              clearLabel={t(($) => $.node.status_unscheduled)}
              label={t(($) => $.node.status)}
              placeholder={unset}
              disabled={readOnly}
              renderDisplay={(value) => <StatusChip status={value} />}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.node.start_date)}>
            <EditableDate
              value={node.start_date}
              onCommit={(start_date) => onPatch({ start_date })}
              label={t(($) => $.node.start_date)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.node.end_date)}>
            <EditableDate
              value={node.end_date}
              onCommit={(end_date) => onPatch({ end_date })}
              label={t(($) => $.node.end_date)}
              placeholder={unset}
              disabled={readOnly}
            />
          </CockpitField>
          <CockpitField label={t(($) => $.node.progress)} className="min-w-0 @min-[28rem]/node-panel:col-span-2">
            {/* A work item with issues has no typed progress: the ratio is
                the issues' own, and the way to move it is to move them. A
                branch's progress is its leaves' roll-up, so editing it here
                would be overwritten by the next read either way. */}
            {progressFromIssues ? (
              <>
                <span className="text-body font-medium tabular-nums">
                  {issueRatio == null ? "—" : `${issueRatio}%`}
                </span>
                <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.node.progress_issue_hint)}</p>
              </>
            ) : (
              <ProgressField
                value={node.progress}
                onCommit={(progress) => onPatch({ progress })}
                label={t(($) => $.node.progress)}
                disabled={readOnly || isBranch}
              />
            )}
            {isBranch && <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.node.progress_branch_hint)}</p>}
          </CockpitField>
        </div>

        <Separator className="my-4" />
        <CockpitField label={t(($) => $.node.linked_issues)}>
          {taskWorkspace ? <p className="text-caption text-muted-foreground">{t(($) => $.task_flow.reference_location)}</p> : referenceWorkspace}
        </CockpitField>

        {/* The other direction of the meeting register: how much was
            discussed here, as a count. The meetings themselves live in the
            register, where their record is. */}
        {meetingCount > 0 && (
          <CockpitField label={t(($) => $.meetings.node_meetings)} className="mt-3">
            <AppLink href={meetingsHref} className="text-caption text-primary hover:underline">
              {t(($) => $.meetings.node_meeting_count, { n: meetingCount })}
            </AppLink>
          </CockpitField>
        )}

        {taskDetails && (
          <>
            <Separator className="my-4" />

            <div className="flex flex-col gap-3">
              <CockpitField label={t(($) => $.node.current_progress)}>
                <EditableTextArea
                  value={node.current_progress}
                  onCommit={(current_progress) => onPatch({ current_progress })}
                  label={t(($) => $.node.current_progress)}
                  placeholder={t(($) => $.node.current_progress_placeholder)}
                  disabled={readOnly}
                  rows={2}
                />
                <p className="mt-1 text-caption text-muted-foreground">{t(($) => $.node.current_progress_hint)}</p>
              </CockpitField>
              <CockpitField label={t(($) => $.node.deliverable)}>
                <EditableTextArea
                  value={node.deliverable}
                  onCommit={(deliverable) => onPatch({ deliverable })}
                  label={t(($) => $.node.deliverable)}
                  placeholder={t(($) => $.node.deliverable_placeholder)}
                  disabled={readOnly}
                />
              </CockpitField>
              <CockpitField label={t(($) => $.node.note)}>
                <EditableTextArea
                  value={node.note}
                  onCommit={(note) => onPatch({ note })}
                  label={t(($) => $.node.note)}
                  placeholder={t(($) => $.node.note_placeholder)}
                  disabled={readOnly}
                />
              </CockpitField>
            </div>

          </>
        )}

        {(node.collaborators || node.dependencies || node.source) && (
          <details className="mt-4 border-t border-border pt-3">
            <summary className="cursor-pointer text-caption text-muted-foreground">{t(($) => $.node.more)}</summary>
            <dl className="mt-2 flex flex-col gap-2 text-caption">
              {node.collaborators && (
                <div><dt className="text-micro text-muted-foreground">{t(($) => $.node.collaborators)}</dt><dd className="whitespace-pre-wrap">{node.collaborators}</dd></div>
              )}
              {node.dependencies && (
                <div><dt className="text-micro text-muted-foreground">{t(($) => $.node.dependencies)}</dt><dd className="whitespace-pre-wrap">{node.dependencies}</dd></div>
              )}
              {node.source && (
                <div><dt className="text-micro text-muted-foreground">{t(($) => $.node.source, { source: "" }).trim()}</dt><dd className="whitespace-pre-wrap">{node.source}</dd></div>
              )}
            </dl>
          </details>
        )}
        </TabsContent>
      </Tabs>

      {!readOnly && (
        <footer className="shrink-0 border-t border-border px-4 py-3">
          <AlertDialog open={confirmOpen} onOpenChange={(open) => {
            if (deletingRef.current) return;
            setConfirmOpen(open);
            if (open) setDeleteFailed(false);
          }}>
            <AlertDialogTrigger render={<Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10 hover:text-destructive" />}>
              <Trash2 className="size-3.5" />
              {isBranch ? t(($) => $.panel.delete_branch) : t(($) => $.panel.delete_node)}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {isBranch ? t(($) => $.panel.delete_branch) : t(($) => $.panel.delete_node)} · {node.name}
                </AlertDialogTitle>
                <AlertDialogDescription>{deleteConfirmationDescription}</AlertDialogDescription>
              </AlertDialogHeader>
              {deleteRestriction}
              {deleteFailed && <p role="alert" className="text-caption text-destructive">{t(($) => $.errors.save_failed)}</p>}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleting}>{common(($) => $.cancel)}</AlertDialogCancel>
                <Button variant="destructive" disabled={deleting || !deleteAllowed} aria-busy={deleting} onClick={confirmDelete}>
                  {deleting && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
                  {deleting ? common(($) => $.loading) : common(($) => $.delete)}
                </Button>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </footer>
      )}
    </aside>
  );
}
