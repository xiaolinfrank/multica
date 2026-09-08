"use client";

// The overview: the annual objective, the milestone track, module progress,
// finance, the three narrative cards, and the meeting log — all editable where
// they are shown.
//
// The narrative cards derive themselves from the tasks unless someone has
// written an override. A card nobody maintains is still right, and one someone
// wrote wins until they clear it.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
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
  cockpitModuleHighlights,
  computeCockpitDigest,
  computeCockpitFinance,
  computeCockpitMonths,
  computeCockpitRollups,
  isCockpitMilestoneDone,
  parseDay,
  sortCockpitMilestones,
  type CockpitRollup,
  type CockpitTreeNode,
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

/** The banner's live clock. First paint shows the placeholder so server and
 * client agree; the tick fills it in once mounted. */
function BannerClock() {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date().toLocaleTimeString("zh-Hans-CN", { hour12: false }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="text-display-sm font-semibold tracking-wide tabular-nums">
      {now ?? "--:--:--"}
    </span>
  );
}

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

/** The prototype leads with two large stat cards and runs the remaining
 * modules compact below them. */
const MODULE_BIG_COUNT = 2;

interface ModuleCardProps {
  entry: CockpitTreeNode;
  rollup: CockpitRollup | undefined;
  readOnly?: boolean;
  emptyLabel: string;
  onOpenBranch: (nodeId: string) => void;
  onPatchNode: (id: string, patch: CockpitNodePatch) => void;
}

function ModuleBigCard({
  entry,
  rollup,
  readOnly,
  emptyLabel,
  onOpenBranch,
  onPatchNode,
}: ModuleCardProps) {
  const { t } = useT("cockpit");
  const pct = Math.round(rollup?.progress ?? entry.node.progress);
  const color = entry.color || "var(--color-brand)";
  const highlights = useMemo(() => cockpitModuleHighlights(entry), [entry]);
  return (
    <article
      className="rounded-lg border border-border bg-card p-4"
      style={{ borderTopColor: color, borderTopWidth: 4 }}
    >
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          onClick={() => onOpenBranch(entry.node.id)}
          aria-label={t(($) => $.overview.open_module, { code: entry.node.code })}
          className="font-mono text-micro font-medium hover:underline"
          style={{ color }}
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
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-md bg-muted/50 p-2 text-center">
          <dd className="text-body font-semibold tabular-nums">
            {rollup?.doneCount ?? 0}/{rollup?.leafCount ?? 0}
          </dd>
          <dt className="text-micro text-muted-foreground">{t(($) => $.overview.done_total)}</dt>
        </div>
        <div className="rounded-md bg-muted/50 p-2 text-center">
          <dd className="text-body font-semibold tabular-nums">{pct}%</dd>
          <dt className="text-micro text-muted-foreground">{t(($) => $.overview.progress)}</dt>
        </div>
        <div className="rounded-md bg-muted/50 p-2 text-center">
          <dd className="text-body font-semibold tabular-nums">{rollup?.activeCount ?? 0}</dd>
          <dt className="text-micro text-muted-foreground">{t(($) => $.overview.module_active)}</dt>
        </div>
        <div className="rounded-md bg-muted/50 p-2 text-center">
          <dd className="text-body font-semibold text-budget tabular-nums">
            {(rollup?.budget ?? 0) > 0 ? formatAmount(rollup!.budget) : "—"}
          </dd>
          <dt className="text-micro text-muted-foreground">{t(($) => $.overview.budget)}</dt>
        </div>
      </dl>
      <div className="mt-3 flex flex-col gap-1 border-t border-border pt-2 text-caption">
        <div className="flex items-baseline gap-2">
          <span className="w-20 shrink-0 text-micro text-muted-foreground">
            {t(($) => $.overview.module_recent)}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {highlights.recent?.name ?? "—"}
          </span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="w-20 shrink-0 text-micro text-muted-foreground">
            {t(($) => $.overview.module_next)}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {highlights.next
              ? `${highlights.next.name} · ${highlights.next.end_date}`
              : "—"}
          </span>
          {(rollup?.lateCount ?? 0) > 0 && (
            <span className="shrink-0 text-micro font-medium text-destructive tabular-nums">
              {t(($) => $.overview.overdue)} {rollup!.lateCount}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function ModuleSmallCard({
  entry,
  rollup,
  readOnly,
  emptyLabel,
  onOpenBranch,
  onPatchNode,
}: ModuleCardProps) {
  const { t } = useT("cockpit");
  const pct = Math.round(rollup?.progress ?? entry.node.progress);
  const color = entry.color || "var(--color-brand)";
  return (
    <article
      className="rounded-lg border border-border bg-card p-3"
      style={{ borderLeftColor: color, borderLeftWidth: 3 }}
    >
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          onClick={() => onOpenBranch(entry.node.id)}
          aria-label={t(($) => $.overview.open_module, { code: entry.node.code })}
          className="font-mono text-micro font-medium hover:underline"
          style={{ color }}
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
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      <dl className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-micro text-muted-foreground tabular-nums">
        <div className="flex gap-1">
          <dt>{t(($) => $.overview.tasks)}</dt>
          <dd className="font-medium text-foreground">
            {rollup?.doneCount ?? 0}/{rollup?.leafCount ?? 0}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt>{t(($) => $.overview.progress)}</dt>
          <dd className="font-medium text-foreground">{pct}%</dd>
        </div>
        <EditableText
          value={entry.node.owner}
          onCommit={(owner) => onPatchNode(entry.node.id, { owner })}
          label={t(($) => $.node.owner)}
          placeholder={emptyLabel}
          disabled={readOnly}
          displayClassName="text-micro text-muted-foreground"
        />
      </dl>
    </article>
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
  /** Locates and highlights one task row in the gantt. */
  onOpenTask?: (nodeId: string) => void;
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
  onOpenTask,
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
      {/* Annual objective — the board's masthead banner, goal in a frosted
          glass strip at the centre, clock and countdown pinned top-right. */}
      <section className="cockpit-banner flex min-h-[116px] flex-col items-center justify-center gap-2 px-24 py-5 text-white">
        <span className="absolute top-3 left-5 text-micro font-bold tracking-widest opacity-85">
          {t(($) => $.overview.mvp_label)}
        </span>
        <div className="cockpit-banner-glass">
          <span aria-hidden>🎯</span>
          <EditableText
            value={board.cockpit.goal_title}
            onCommit={(goal_title) => onPatchBoard({ goal_title })}
            label={t(($) => $.overview.annual_goal)}
            placeholder={t(($) => $.overview.annual_goal_placeholder)}
            disabled={readOnly}
            displayClassName="text-title-lg font-extrabold text-white"
          />
        </div>
        {board.cockpit.basis && (
          <p className="max-w-3xl text-center text-micro opacity-75">{board.cockpit.basis}</p>
        )}
        <div className="absolute top-3 right-5 flex flex-col items-end">
          <span className="text-micro font-bold tracking-widest opacity-85">
            {t(($) => $.overview.clock)}
          </span>
          <BannerClock />
          <div className="flex items-center gap-2 text-micro opacity-90">
            <EditableDate
              value={board.cockpit.goal_date}
              onCommit={(goal_date) => onPatchBoard({ goal_date })}
              label={t(($) => $.overview.target_date)}
              placeholder={t(($) => $.overview.target_date)}
              disabled={readOnly}
              displayClassName="text-white"
            />
            {daysLeft !== null && (
              <span className="font-semibold tabular-nums">
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
          <ol className="flex items-start overflow-x-auto pb-1">
            {/* gap-0: the connector spans node to node, so spacing lives in
                each node's own padding instead of a gap that would break the
                line. */}
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
        <div className="grid gap-3 md:grid-cols-2">
          {tree.slice(0, MODULE_BIG_COUNT).map((entry) => (
            <ModuleBigCard
              key={entry.node.id}
              entry={entry}
              rollup={rollups.get(entry.node.id)}
              readOnly={readOnly}
              emptyLabel={emptyLabel}
              onOpenBranch={onOpenBranch}
              onPatchNode={onPatchNode}
            />
          ))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {tree.slice(MODULE_BIG_COUNT).map((entry) => (
            <ModuleSmallCard
              key={entry.node.id}
              entry={entry}
              rollup={rollups.get(entry.node.id)}
              readOnly={readOnly}
              emptyLabel={emptyLabel}
              onOpenBranch={onOpenBranch}
              onPatchNode={onPatchNode}
            />
          ))}
        </div>
      </Section>

      {/* Finance */}
      <Section title={t(($) => $.overview.finance)} hint={t(($) => $.overview.finance_hint)}>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            // The budget is the figure the other three are measured against,
            // so it carries the gold the board reserves for budget.
            {
              key: "budget",
              label: t(($) => $.finance.budget),
              value: finance.budget,
              gold: true,
            },
            { key: "paid", label: t(($) => $.finance.paid), value: finance.paid, gold: false },
            {
              key: "contracted",
              label: t(($) => $.finance.contracted),
              value: finance.contracted,
              gold: false,
            },
            {
              key: "unplanned",
              label: t(($) => $.finance.unplanned),
              value: finance.unplanned,
              gold: false,
            },
          ].map((cell) => (
            <div key={cell.key} className="rounded-md border border-border p-3">
              <dt className="text-caption text-muted-foreground">{cell.label}</dt>
              <dd
                className={cn(
                  "mt-1 text-title font-semibold tabular-nums",
                  cell.gold && "text-budget",
                )}
              >
                {formatAmount(cell.value)}
              </dd>
            </div>
          ))}
        </dl>

        {months.length > 0 && (
          <>
            <div className="mt-4 mb-1 text-caption font-medium">
              {t(($) => $.finance.month_chart)}
              <span className="ml-2 font-normal text-muted-foreground">
                {t(($) => $.finance.month_basis)}
              </span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {months.map((month) => (
                <div
                  key={month.month}
                  className="flex min-w-28 flex-1 flex-col rounded-md border border-border bg-card p-2.5"
                >
                  <div className="text-micro text-muted-foreground tabular-nums">{month.month}</div>
                  <div className="mt-0.5 text-body font-semibold tabular-nums">
                    {month.amount > 0 ? formatAmount(month.amount) : "—"}
                  </div>
                  {/* The stacked column: instalments of this month by module
                      colour, one segment per root. */}
                  <div className="mt-2 flex h-20 items-end justify-center">
                    {month.amount > 0 ? (
                      <div className="flex w-6 flex-col-reverse overflow-hidden rounded-t-sm">
                        {month.byModule.map((share) => (
                          <div
                            key={share.code}
                            title={`${share.code} ${formatAmount(share.amount)}`}
                            style={{
                              height: `${(share.amount / maxMonthAmount) * 100}%`,
                              backgroundColor: share.color || "var(--color-muted-foreground)",
                            }}
                          />
                        ))}
                      </div>
                    ) : (
                      <span className="text-micro text-muted-foreground">—</span>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-col gap-0.5">
                    {month.byModule.length > 0 ? (
                      month.byModule.map((share) => (
                        <div
                          key={share.code}
                          className="flex items-center gap-1 text-micro tabular-nums"
                        >
                          <span
                            className="size-1.5 rounded-full"
                            style={{
                              backgroundColor: share.color || "var(--color-muted-foreground)",
                            }}
                            aria-hidden
                          />
                          <span className="text-muted-foreground">{share.code}</span>
                          <span className="ml-auto font-medium">
                            {formatAmount(share.amount)}
                          </span>
                        </div>
                      ))
                    ) : (
                      <span className="text-micro text-muted-foreground">—</span>
                    )}
                  </div>
                  {/* Paid share: instalments on nodes whose execution status
                      reads as paid, against the month's plan. */}
                  <div className="mt-2">
                    <div className="flex items-baseline justify-between text-micro">
                      <span className="text-muted-foreground">
                        {t(($) => $.finance.paid_label)}
                      </span>
                      <span
                        className={cn(
                          "font-medium tabular-nums",
                          month.paidAmount > 0 && "text-success",
                        )}
                      >
                        {month.paidAmount > 0 ? formatAmount(month.paidAmount) : "—"}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-success transition-[width] duration-300"
                        style={{
                          width:
                            month.amount > 0
                              ? `${Math.min(100, (month.paidAmount / month.amount) * 100)}%`
                              : "0%",
                        }}
                      />
                    </div>
                  </div>
                  <div className="mt-2 border-t border-border pt-1.5">
                    <div className="text-micro text-muted-foreground tabular-nums">
                      {t(($) => $.finance.month_tasks, {
                        done: month.doneCount,
                        total: month.dueCount,
                      })}
                      {month.activeCount > 0 && (
                        <>
                          {" · "}
                          {t(($) => $.finance.month_active, { n: month.activeCount })}
                        </>
                      )}
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-success transition-[width] duration-300"
                        style={{
                          width:
                            month.dueCount > 0
                              ? `${Math.round((month.doneCount / month.dueCount) * 100)}%`
                              : "0%",
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
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
          onOpenTask={onOpenTask}
          readOnly={readOnly}
          top={["#3b6cff", "#38bdf8"]}
        />
        <DigestCard
          title={t(($) => $.overview.card_next)}
          override={board.cockpit.summary_next}
          nodes={digest.upcoming}
          emptyLabel={t(($) => $.empty.no_upcoming)}
          onCommit={(summary_next) => onPatchBoard({ summary_next })}
          onOpenTask={onOpenTask}
          readOnly={readOnly}
          top={["#0891b2", "#22d3ee"]}
        />
        <DigestCard
          title={t(($) => $.overview.card_support)}
          override={board.cockpit.summary_support}
          nodes={digest.needsSupport}
          emptyLabel={t(($) => $.empty.no_support_needed)}
          onCommit={(summary_support) => onPatchBoard({ summary_support })}
          onOpenTask={onOpenTask}
          readOnly={readOnly}
          tone="destructive"
          top={["#d97706", "#fbbf24"]}
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
    // The track: a dot on the timeline, the card hanging below it. The
    // connector between dots lives in cockpit.css on .cockpit-ms-node.
    <li
      className="cockpit-ms-node group/ms flex min-w-56 flex-1 shrink flex-col items-center px-2"
      data-done={done || undefined}
    >
      <span className="cockpit-ms-dot" aria-hidden />
      <div className="cockpit-ms-card relative mt-2 w-full rounded-lg border p-3 transition-shadow hover:shadow-md">
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
      </div>
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
  top,
  onOpenTask,
}: {
  title: string;
  override: string;
  nodes: CockpitNode[];
  emptyLabel: string;
  onCommit: (next: string) => void;
  readOnly?: boolean;
  tone?: "destructive";
  /** Gradient cap colours [from, to], as in the prototype's narrative cards. */
  top?: [string, string];
  /** Sends a click on a task row to the gantt, which locates the row. */
  onOpenTask?: (nodeId: string) => void;
}) {
  const { t } = useT("cockpit");
  return (
    <section
      className={cn(
        "rounded-lg border border-border bg-card p-4",
        top && "cockpit-card-top",
      )}
      style={top ? ({ "--top-from": top[0], "--top-to": top[1] } as CSSProperties) : undefined}
    >
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
              {nodes.map((node) =>
                onOpenTask ? (
                  // A task row is a jump into the gantt, like the prototype's
                  // "click the card task to locate it on the chart".
                  <li key={node.id}>
                    <button
                      type="button"
                      onClick={() => onOpenTask(node.id)}
                      aria-label={t(($) => $.overview.open_task, { code: node.code })}
                      className="flex w-full items-baseline gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-accent"
                    >
                      <span className="shrink-0 font-mono text-micro text-muted-foreground">
                        {node.code}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 flex-1 truncate text-body",
                          tone === "destructive" && "text-destructive",
                        )}
                      >
                        {node.name}
                      </span>
                      {node.end_date && (
                        <span className="shrink-0 text-micro text-muted-foreground tabular-nums">
                          {node.end_date}
                        </span>
                      )}
                    </button>
                  </li>
                ) : (
                  <li key={node.id} className="flex items-baseline gap-2">
                    <span className="shrink-0 font-mono text-micro text-muted-foreground">
                      {node.code}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 text-body",
                        tone === "destructive" && "text-destructive",
                      )}
                    >
                      {node.name}
                    </span>
                    {node.end_date && (
                      <span className="shrink-0 text-micro text-muted-foreground tabular-nums">
                        {node.end_date}
                      </span>
                    )}
                  </li>
                ),
              )}
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
