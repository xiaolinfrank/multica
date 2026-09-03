"use client";

// The overview: the annual objective, the milestone track, module progress,
// finance, the three narrative cards, and the meeting log — all editable where
// they are shown.
//
// The narrative cards derive themselves from the tasks unless someone has
// written an override. A card nobody maintains is still right, and one someone
// wrote wins until they clear it.

import { useMemo } from "react";
import type {
  CockpitBoard,
  CockpitMeeting,
  CockpitMeetingPatch,
  CockpitMilestone,
  CockpitMilestonePatch,
  CockpitNode,
  CockpitNodePatch,
  CockpitPatch,
} from "@multica/core/types";
import {
  buildCockpitTree,
  computeCockpitDigest,
  computeCockpitFinance,
  computeCockpitMonths,
  computeCockpitRollups,
  isCockpitMilestoneDone,
  parseDay,
  sortCockpitMilestones,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { CalendarDays, ExternalLink, Plus, Trash2 } from "lucide-react";
import { useT } from "../../i18n";
import {
  EditableDate,
  EditableText,
  EditableTextArea,
} from "./cockpit-fields";
import { StatusChip } from "./cockpit-status";

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-3 flex items-baseline gap-2">
        <h2 className="text-title-sm font-semibold">{title}</h2>
        {hint && <span className="text-caption text-muted-foreground">{hint}</span>}
        <span className="flex-1" />
        {action}
      </header>
      {children}
    </section>
  );
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export interface CockpitOverviewProps {
  board: CockpitBoard;
  today: string;
  onPatchBoard: (patch: CockpitPatch) => void;
  onPatchNode: (nodeId: string, patch: CockpitNodePatch) => void;
  onPatchMilestone: (id: string, patch: CockpitMilestonePatch) => void;
  onCreateMilestone: () => void;
  onDeleteMilestone: (id: string) => void;
  onPatchMeeting: (id: string, patch: CockpitMeetingPatch) => void;
  onCreateMeeting: () => void;
  onDeleteMeeting: (id: string) => void;
  onOpenBranch: (nodeId: string) => void;
  readOnly?: boolean;
}

export function CockpitOverview({
  board,
  today,
  onPatchBoard,
  onPatchNode,
  onPatchMilestone,
  onCreateMilestone,
  onDeleteMilestone,
  onPatchMeeting,
  onCreateMeeting,
  onDeleteMeeting,
  onOpenBranch,
  readOnly,
}: CockpitOverviewProps) {
  const { t } = useT("cockpit");

  const tree = useMemo(() => buildCockpitTree(board.nodes), [board.nodes]);
  const rollups = useMemo(() => computeCockpitRollups(tree, today), [tree, today]);
  const finance = useMemo(() => computeCockpitFinance(board), [board]);
  const months = useMemo(() => computeCockpitMonths(board), [board]);
  const digest = useMemo(() => computeCockpitDigest(board.nodes, today), [board.nodes, today]);
  const milestones = useMemo(() => sortCockpitMilestones(board.milestones), [board.milestones]);
  const nodeById = useMemo(() => new Map(board.nodes.map((n) => [n.id, n])), [board.nodes]);

  const goalDate = parseDay(board.cockpit.goal_date);
  const todayDate = parseDay(today);
  const daysLeft =
    goalDate && todayDate
      ? Math.ceil((goalDate.getTime() - todayDate.getTime()) / (24 * 60 * 60 * 1000))
      : null;

  const maxMonthAmount = months.reduce((max, m) => Math.max(max, m.amount), 0);
  const emptyLabel = t(($) => $.common.unset);

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Annual objective */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <span className="text-micro font-medium tracking-wide text-muted-foreground uppercase">
              {t(($) => $.overview.annual_goal)}
            </span>
            <div className="mt-1">
              <EditableText
                value={board.cockpit.goal_title}
                onCommit={(goal_title) => onPatchBoard({ goal_title })}
                label={t(($) => $.overview.annual_goal)}
                placeholder={t(($) => $.overview.annual_goal_placeholder)}
                disabled={readOnly}
                displayClassName="text-title font-semibold"
              />
            </div>
            {board.cockpit.basis && (
              <p className="mt-2 text-caption text-muted-foreground">{board.cockpit.basis}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <EditableDate
              value={board.cockpit.goal_date}
              onCommit={(goal_date) => onPatchBoard({ goal_date })}
              label={t(($) => $.overview.target_date)}
              placeholder={t(($) => $.overview.target_date)}
              disabled={readOnly}
            />
            {daysLeft !== null && (
              <span
                className={cn(
                  "text-display-sm font-semibold tabular-nums",
                  daysLeft < 0 ? "text-destructive" : "text-foreground",
                )}
              >
                {daysLeft >= 0
                  ? t(($) => $.overview.days_left, { days: daysLeft })
                  : t(($) => $.overview.days_over, { days: -daysLeft })}
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Milestones */}
      <Section
        title={t(($) => $.overview.milestones)}
        hint={t(($) => $.overview.milestone_count, {
          total: milestones.length,
          done: milestones.filter(isCockpitMilestoneDone).length,
        })}
        action={
          !readOnly && (
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={onCreateMilestone}>
              <Plus className="size-3.5" />
              {t(($) => $.overview.add_milestone)}
            </Button>
          )
        }
      >
        {milestones.length === 0 ? (
          <p className="text-body text-muted-foreground">{t(($) => $.empty.no_milestones)}</p>
        ) : (
          <ol className="flex gap-3 overflow-x-auto pb-1">
            {milestones.map((milestone) => (
              <MilestoneCard
                key={milestone.id}
                milestone={milestone}
                node={milestone.node_id ? nodeById.get(milestone.node_id) : undefined}
                onPatch={(patch) => onPatchMilestone(milestone.id, patch)}
                onDelete={() => onDeleteMilestone(milestone.id)}
                readOnly={readOnly}
              />
            ))}
          </ol>
        )}
      </Section>

      {/* Modules */}
      <Section title={t(($) => $.overview.modules)} hint={t(($) => $.overview.modules_hint)}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {tree.map((entry) => {
            const rollup = rollups.get(entry.node.id);
            const pct = Math.round(rollup?.progress ?? entry.node.progress);
            return (
              <article
                key={entry.node.id}
                className="rounded-md border border-border p-3"
                style={entry.color ? { borderTopColor: entry.color, borderTopWidth: 2 } : undefined}
              >
                <div className="flex items-baseline gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenBranch(entry.node.id)}
                    aria-label={t(($) => $.overview.open_module, { code: entry.node.code })}
                    className="font-mono text-micro text-muted-foreground hover:underline"
                    style={entry.color ? { color: entry.color } : undefined}
                  >
                    {entry.node.code}
                  </button>
                  <EditableText
                    value={entry.node.name}
                    onCommit={(name) => onPatchNode(entry.node.id, { name })}
                    label={t(($) => $.node.name)}
                    placeholder={t(($) => $.node.name_placeholder)}
                    disabled={readOnly}
                    displayClassName="flex-1 font-medium"
                  />
                  <EditableText
                    value={entry.node.owner}
                    onCommit={(owner) => onPatchNode(entry.node.id, { owner })}
                    label={t(($) => $.node.owner)}
                    placeholder={emptyLabel}
                    disabled={readOnly}
                    displayClassName="text-caption text-muted-foreground"
                  />
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full transition-[width] duration-300"
                    style={{ width: `${pct}%`, backgroundColor: entry.color || "var(--color-brand)" }}
                  />
                </div>
                <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground tabular-nums">
                  <div className="flex gap-1">
                    <dt>{t(($) => $.overview.progress)}</dt>
                    <dd className="font-medium text-foreground">{pct}%</dd>
                  </div>
                  <div className="flex gap-1">
                    <dt>{t(($) => $.overview.tasks)}</dt>
                    <dd className="font-medium text-foreground">
                      {rollup?.doneCount ?? 0}/{rollup?.leafCount ?? 0}
                    </dd>
                  </div>
                  {(rollup?.budget ?? 0) > 0 && (
                    <div className="flex gap-1">
                      <dt>{t(($) => $.overview.budget)}</dt>
                      <dd className="font-medium text-foreground">
                        {formatAmount(rollup!.budget)}
                      </dd>
                    </div>
                  )}
                  {(rollup?.lateCount ?? 0) > 0 && (
                    <div className="flex gap-1 text-destructive">
                      <dt>{t(($) => $.overview.overdue)}</dt>
                      <dd className="font-medium">{rollup!.lateCount}</dd>
                    </div>
                  )}
                </dl>
              </article>
            );
          })}
        </div>
      </Section>

      {/* Finance */}
      <Section title={t(($) => $.overview.finance)} hint={t(($) => $.overview.finance_hint)}>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { key: "budget", label: t(($) => $.finance.budget), value: finance.budget },
            { key: "paid", label: t(($) => $.finance.paid), value: finance.paid },
            { key: "contracted", label: t(($) => $.finance.contracted), value: finance.contracted },
            { key: "unplanned", label: t(($) => $.finance.unplanned), value: finance.unplanned },
          ].map((cell) => (
            <div key={cell.key} className="rounded-md border border-border p-3">
              <dt className="text-caption text-muted-foreground">{cell.label}</dt>
              <dd className="mt-1 text-title font-semibold tabular-nums">
                {formatAmount(cell.value)}
              </dd>
            </div>
          ))}
        </dl>

        {months.length > 0 && (
          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {months.map((month) => (
              <div key={month.month} className="min-w-24 flex-1 rounded-md border border-border p-2">
                <div className="text-micro text-muted-foreground tabular-nums">{month.month}</div>
                <div className="mt-0.5 text-body font-semibold tabular-nums">
                  {month.amount > 0 ? formatAmount(month.amount) : "—"}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-brand"
                    style={{
                      width: maxMonthAmount > 0 ? `${(month.amount / maxMonthAmount) * 100}%` : "0%",
                    }}
                  />
                </div>
                <div className="mt-1 text-micro text-muted-foreground tabular-nums">
                  {t(($) => $.finance.month_tasks, { done: month.doneCount, total: month.dueCount })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Narrative cards */}
      <div className="grid gap-4 lg:grid-cols-3">
        <DigestCard
          title={t(($) => $.overview.card_overall)}
          override={board.cockpit.summary_overall}
          nodes={digest.recentlyDone}
          emptyLabel={t(($) => $.empty.no_recent_done)}
          onCommit={(summary_overall) => onPatchBoard({ summary_overall })}
          readOnly={readOnly}
        />
        <DigestCard
          title={t(($) => $.overview.card_next)}
          override={board.cockpit.summary_next}
          nodes={digest.upcoming}
          emptyLabel={t(($) => $.empty.no_upcoming)}
          onCommit={(summary_next) => onPatchBoard({ summary_next })}
          readOnly={readOnly}
        />
        <DigestCard
          title={t(($) => $.overview.card_support)}
          override={board.cockpit.summary_support}
          nodes={digest.needsSupport}
          emptyLabel={t(($) => $.empty.no_support_needed)}
          onCommit={(summary_support) => onPatchBoard({ summary_support })}
          readOnly={readOnly}
          tone="destructive"
        />
      </div>

      {/* Meetings */}
      <Section
        title={t(($) => $.overview.meetings)}
        action={
          !readOnly && (
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={onCreateMeeting}>
              <Plus className="size-3.5" />
              {t(($) => $.overview.add_meeting)}
            </Button>
          )
        }
      >
        {board.meetings.length === 0 ? (
          <p className="text-body text-muted-foreground">{t(($) => $.empty.no_meetings)}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {board.meetings.map((meeting) => (
              <MeetingRow
                key={meeting.id}
                meeting={meeting}
                onPatch={(patch) => onPatchMeeting(meeting.id, patch)}
                onDelete={() => onDeleteMeeting(meeting.id)}
                readOnly={readOnly}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function MilestoneCard({
  milestone,
  node,
  onPatch,
  onDelete,
  readOnly,
}: {
  milestone: CockpitMilestone;
  node: CockpitNode | undefined;
  onPatch: (patch: CockpitMilestonePatch) => void;
  onDelete: () => void;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const done = isCockpitMilestoneDone(milestone);
  return (
    <li
      className={cn(
        "group/ms relative w-64 shrink-0 rounded-md border p-3",
        done ? "border-success/40 bg-success/5" : "border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-1 size-2 shrink-0 rounded-full",
            done ? "bg-success" : "border-2 border-muted-foreground",
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <EditableText
            value={milestone.name}
            onCommit={(name) => onPatch({ name })}
            label={t(($) => $.milestone.name)}
            placeholder={t(($) => $.milestone.name_placeholder)}
            disabled={readOnly}
            displayClassName="font-medium"
          />
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <StatusChip status={milestone.status} />
            {node && (
              <span className="font-mono text-micro text-muted-foreground">{node.code}</span>
            )}
          </div>
          <div className="mt-2 flex flex-col gap-0.5">
            <div className="flex items-center gap-1">
              <span className="w-8 shrink-0 text-micro text-muted-foreground">
                {t(($) => $.milestone.plan)}
              </span>
              <EditableDate
                value={milestone.plan_date}
                onCommit={(plan_date) => onPatch({ plan_date })}
                label={t(($) => $.milestone.plan)}
                placeholder={t(($) => $.common.unset)}
                disabled={readOnly}
              />
            </div>
            <div className="flex items-center gap-1">
              <span className="w-8 shrink-0 text-micro text-muted-foreground">
                {t(($) => $.milestone.actual)}
              </span>
              <EditableDate
                value={milestone.actual_date}
                onCommit={(actual_date) => onPatch({ actual_date })}
                label={t(($) => $.milestone.actual)}
                placeholder={t(($) => $.common.unset)}
                disabled={readOnly}
              />
            </div>
          </div>
          {milestone.condition && (
            <p className="mt-2 text-micro text-muted-foreground">{milestone.condition}</p>
          )}
        </div>
      </div>
      {!readOnly && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={t(($) => $.milestone.delete, { name: milestone.name })}
          className="absolute top-2 right-2 rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity group-hover/ms:opacity-100 hover:text-destructive focus-visible:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </li>
  );
}

function DigestCard({
  title,
  override,
  nodes,
  emptyLabel,
  onCommit,
  readOnly,
  tone,
}: {
  title: string;
  override: string;
  nodes: CockpitNode[];
  emptyLabel: string;
  onCommit: (next: string) => void;
  readOnly?: boolean;
  tone?: "destructive";
}) {
  const { t } = useT("cockpit");
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <header className="mb-2 flex items-baseline gap-2">
        <h2 className="text-title-sm font-semibold">{title}</h2>
        <span className="flex-1" />
        <span className="text-micro text-muted-foreground">
          {override ? t(($) => $.overview.card_manual) : t(($) => $.overview.card_auto)}
        </span>
      </header>

      {override ? (
        <EditableTextArea
          value={override}
          onCommit={onCommit}
          label={title}
          placeholder={t(($) => $.overview.card_placeholder)}
          disabled={readOnly}
          rows={5}
        />
      ) : (
        <>
          {nodes.length === 0 ? (
            <p className="text-body text-muted-foreground">{emptyLabel}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {nodes.map((node) => (
                <li key={node.id} className="flex items-baseline gap-2">
                  <span className="shrink-0 font-mono text-micro text-muted-foreground">
                    {node.code}
                  </span>
                  <span className={cn("min-w-0 flex-1 text-body", tone === "destructive" && "text-destructive")}>
                    {node.name}
                  </span>
                  {node.end_date && (
                    <span className="shrink-0 text-micro text-muted-foreground tabular-nums">
                      {node.end_date}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-7 px-2 text-caption"
              onClick={() => onCommit(t(($) => $.overview.card_seed))}
            >
              {t(($) => $.overview.card_write_manual)}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function MeetingRow({
  meeting,
  onPatch,
  onDelete,
  readOnly,
}: {
  meeting: CockpitMeeting;
  onPatch: (patch: CockpitMeetingPatch) => void;
  onDelete: () => void;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  return (
    <li className="group/meet flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
      <CalendarDays className="size-3.5 shrink-0 self-center text-muted-foreground" aria-hidden />
      <EditableDate
        value={meeting.meet_date}
        onCommit={(meet_date) => onPatch({ meet_date })}
        label={t(($) => $.meeting.date)}
        placeholder={t(($) => $.common.unset)}
        disabled={readOnly}
      />
      <EditableText
        value={meeting.time_range}
        onCommit={(time_range) => onPatch({ time_range })}
        label={t(($) => $.meeting.time)}
        placeholder={t(($) => $.meeting.time)}
        disabled={readOnly}
        displayClassName="text-caption text-muted-foreground tabular-nums"
      />
      <EditableText
        value={meeting.title}
        onCommit={(title) => onPatch({ title })}
        label={t(($) => $.meeting.title)}
        placeholder={t(($) => $.meeting.title_placeholder)}
        disabled={readOnly}
        displayClassName="min-w-40 flex-1 font-medium"
      />
      <EditableText
        value={meeting.attendees}
        onCommit={(attendees) => onPatch({ attendees })}
        label={t(($) => $.meeting.attendees)}
        placeholder={t(($) => $.meeting.attendees)}
        disabled={readOnly}
        displayClassName="text-caption text-muted-foreground"
      />
      {meeting.link && (
        <a
          href={meeting.link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-caption text-brand hover:underline"
        >
          {t(($) => $.meeting.open)}
          <ExternalLink className="size-3" />
        </a>
      )}
      {!readOnly && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={t(($) => $.meeting.delete, { title: meeting.title })}
          className="rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity group-hover/meet:opacity-100 hover:text-destructive focus-visible:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </li>
  );
}
