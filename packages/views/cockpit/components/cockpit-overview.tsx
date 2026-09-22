"use client";

// The overview: the annual objective, the milestone track, module progress,
// the four narrative cards, and finance — all editable where they are shown.
//
// The order is the order the board is read in: what the year is for, the dates
// it turns on, how each module is doing, what moved and what is coming, and
// only then the money. Finance sits last because it is the longest section and
// nobody opens the board to read it first.
//
// The narrative cards derive themselves from the tasks unless someone has
// written an override. A card nobody maintains is still right, and one someone
// wrote wins until they clear it — both go through the same line model, so
// switching a card to manual does not visibly downgrade it.

import { useEffect, useMemo, useState } from "react";
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
  addDays,
  buildCockpitDisplayCodes,
  buildCockpitTree,
  cockpitMeetingSpan,
  cockpitMilestoneStatusColor,
  cockpitModuleHighlights,
  computeCockpitDigest,
  computeCockpitFinance,
  computeCockpitMonths,
  computeCockpitRollups,
  daysBetween,
  formatDay,
  isCockpitMilestoneDone,
  parseCockpitCardText,
  parseDay,
  sortCockpitMilestones,
  splitCockpitCardNumbers,
  type CockpitCardLine,
  type CockpitDigestItem,
  type CockpitRollup,
  type CockpitTreeNode,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { useT, useLocale } from "../../i18n";
import { EditableDate, EditableSuggest, EditableText, EditableTextArea } from "./cockpit-fields";

/** The banner's live clock, read off local Date components — the wall clock
 * the room reads, not the UTC one a date formatter hands back. First paint
 * shows the placeholder so server and client agree. */
function BannerClock({ locale }: { locale: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);
  // The prototype's v1.0 clock is the day, not the second: no time-of-day,
  // so a minute's tick is all the cadence it needs.
  const pad = (value: number): string => String(value).padStart(2, "0");
  const clock = now
    ? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    : "—";
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-title-sm font-semibold tracking-wide tabular-nums">{clock}</span>
      <span className="text-micro opacity-90">
        {now ? now.toLocaleDateString(locale, { weekday: "long" }) : "—"}
      </span>
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

/** The milestone the board's countdown hangs off, matched by name like the
 * prototype: the one the annual results are reported through. */
const ANNUAL_REPORT_NAME = "年度成果汇报";

/** The interaction props a module card's root element takes when the whole
 * card opens the module's slice of the execution gantt. Keyboard-reachable
 * button semantics, and a click guard so a click that landed on an inline
 * editor or the code chip keeps its own meaning instead of navigating. */
function moduleCardInteraction(
  code: string,
  label: string,
  onOpenModule: (rootCode: string) => void,
): React.HTMLAttributes<HTMLElement> {
  return {
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    onClick: (event) => {
      if (
        event.target instanceof Element &&
        event.target.closest("button, a, input, textarea, select")
      ) {
        return;
      }
      onOpenModule(code);
    },
    onKeyDown: (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      if (
        event.target instanceof Element &&
        event.target.closest("button, a, input, textarea, select")
      ) {
        return;
      }
      event.preventDefault();
      onOpenModule(code);
    },
  };
}

function formatAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Money on this board is counted in 万 (ten-thousand yuan); the figure keeps
 * its unit wherever it is shown. */
function formatWan(value: number): string {
  return `${formatAmount(value)}万`;
}

/** "2026年9月" — the month as the reader's calendar writes it, not a raw
 * "2026-09" key. */
function monthLabel(month: string, locale: string): string {
  const [year, mon] = month.split("-").map(Number);
  const date = new Date(year!, (mon ?? 1) - 1, 1);
  return date.toLocaleDateString(locale, { year: "numeric", month: "long" });
}

/** "6/15" — the short form the cards date their lines with. */
function formatShortDate(iso: string | null | undefined, locale: string): string {
  const date = parseDay(iso ?? null);
  if (!date) return "";
  return date.toLocaleDateString(locale, { month: "numeric", day: "numeric" });
}

/** Card prose with counted quantities set in bolder type. */
function CardProse({ text }: { text: string }) {
  const runs = useMemo(() => splitCockpitCardNumbers(text), [text]);
  return (
    <>
      {runs.map((run, index) =>
        run.emphasis ? (
          <b key={index} className="font-semibold text-foreground tabular-nums">
            {run.text}
          </b>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </>
  );
}

interface CardItemProps {
  date?: string;
  code?: string;
  icon?: string;
  title: string;
  tag?: string;
  badge?: string;
  tone?: "destructive";
  onOpen?: () => void;
  openLabel?: string;
}

/** One detail line of a narrative card — the same row whether the card was
 * derived or written by hand. */
function CardItem({
  date,
  code,
  icon,
  title,
  tag,
  badge,
  tone,
  onOpen,
  openLabel,
}: CardItemProps) {
  const body = (
    <>
      {date && (
        <span className="shrink-0 rounded-sm bg-muted px-1 py-px text-micro text-muted-foreground tabular-nums">
          {date}
        </span>
      )}
      {code && (
        <span className="shrink-0 font-mono text-micro text-muted-foreground">{code}</span>
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-body",
          tone === "destructive" && "text-destructive",
        )}
      >
        {icon && <span aria-hidden>{icon} </span>}
        {title}
      </span>
      {tag && (
        <span className="shrink-0 rounded-sm border border-border px-1 text-micro text-muted-foreground">
          {tag}
        </span>
      )}
      {badge && (
        <span className="shrink-0 text-micro font-medium tabular-nums">{badge}</span>
      )}
    </>
  );
  if (!onOpen) {
    return <li className="flex items-baseline gap-2 px-1 py-0.5">{body}</li>;
  }
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={openLabel}
        className="flex w-full items-baseline gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-accent"
      >
        {body}
      </button>
    </li>
  );
}

/** A hand-written card, rendered through the same line model as a derived one. */
function ManualCardBody({
  text,
  onOpenCode,
}: {
  text: string;
  onOpenCode?: (code: string) => void;
}) {
  const lines: CockpitCardLine[] = useMemo(() => parseCockpitCardText(text), [text]);
  const items: React.ReactNode[] = [];
  const blocks: React.ReactNode[] = [];

  const flush = () => {
    if (items.length === 0) return;
    blocks.push(
      <ul key={`items-${blocks.length}`} className="flex flex-col gap-0.5">
        {items.splice(0, items.length)}
      </ul>,
    );
  };

  lines.forEach((line, index) => {
    if (line.kind === "item") {
      const open = line.code && onOpenCode ? () => onOpenCode(line.code) : undefined;
      items.push(
        <CardItem
          key={index}
          date={line.date}
          code={line.code}
          title={line.title}
          tag={line.tag}
          badge={line.badge}
          onOpen={open}
        />,
      );
      return;
    }
    flush();
    switch (line.kind) {
      case "lead":
        blocks.push(
          <p key={index} className="mb-1.5 text-caption text-muted-foreground">
            <CardProse text={line.text} />
          </p>,
        );
        break;
      case "section":
        blocks.push(
          <p key={index} className="mt-1.5 text-caption font-medium">
            <CardProse text={line.text} />
          </p>,
        );
        break;
      case "note":
        blocks.push(
          <p key={index} className="pl-5 text-micro text-muted-foreground">
            <CardProse text={line.text} />
          </p>,
        );
        break;
      case "more":
        blocks.push(
          <p key={index} className="mt-1 text-micro text-muted-foreground">
            {line.text}
          </p>,
        );
        break;
      case "empty":
        blocks.push(
          <p key={index} className="text-body text-muted-foreground">
            {line.text}
          </p>,
        );
        break;
      default:
        blocks.push(
          <p key={index} className="text-body">
            • <CardProse text={line.text} />
          </p>,
        );
    }
  });
  flush();

  return <div className="flex flex-col">{blocks}</div>;
}

/** The shell every bottom card shares: title, window hint, and the gradient
 * cap that tells the four apart at a glance. */
function NarrativeCard({
  title,
  icon,
  hint,
  cap,
  badge,
  action,
  children,
}: {
  title: string;
  icon: string;
  hint?: string;
  cap?: "next" | "meetings" | "support";
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="cockpit-card-top rounded-lg border border-border bg-card p-4" data-cap={cap}>
      <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span aria-hidden className="text-body">
          {icon}
        </span>
        <h2 className="text-title-sm font-semibold">{title}</h2>
        {hint && <span className="text-micro text-muted-foreground">{hint}</span>}
        <span className="flex-1" />
        {badge}
        {action}
      </header>
      {children}
    </section>
  );
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
  /** Opens the meeting register, on one meeting when named. */
  onOpenMeetings: (meetingId?: string) => void;
  onOpenBranch: (nodeId: string) => void;
  /** Locates and highlights one task row in the gantt. */
  onOpenTask?: (nodeId: string) => void;
  /** Opens a module's slice of the execution gantt — when wired, the whole
   * module card clicks through. */
  onOpenModule?: (rootCode: string) => void;
  /** The owners the board already uses, offered on the module cards. */
  ownerSuggestions: string[];
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
  onOpenMeetings,
  onOpenBranch,
  onOpenTask,
  onOpenModule,
  ownerSuggestions,
  readOnly,
}: CockpitOverviewProps) {
  const { t } = useT("cockpit");
  const locale = useLocale();

  const tree = useMemo(() => buildCockpitTree(board.nodes), [board.nodes]);
  const displayCodes = useMemo(() => buildCockpitDisplayCodes(tree), [tree]);
  const rollups = useMemo(() => computeCockpitRollups(tree, today), [tree, today]);
  const finance = useMemo(() => computeCockpitFinance(board), [board]);
  const months = useMemo(() => computeCockpitMonths(board), [board]);
  const digest = useMemo(() => computeCockpitDigest(board, today), [board, today]);
  const milestones = useMemo(() => sortCockpitMilestones(board.milestones), [board.milestones]);
  const nodeById = useMemo(() => new Map(board.nodes.map((n) => [n.id, n])), [board.nodes]);
  const nodeByCode = useMemo(() => new Map(board.nodes.map((n) => [n.code, n])), [board.nodes]);
  const idByDisplayCode = useMemo(() => {
    const map = new Map<string, string>();
    displayCodes.forEach((code, id) => map.set(code, id));
    return map;
  }, [displayCodes]);

  /** A card line's code back to a node: the displayed code first, then the
   * board's own code, so a hand-written line keeps working either way. */
  const openByCode = onOpenTask
    ? (code: string) => {
        const id = idByDisplayCode.get(code) ?? nodeByCode.get(code)?.id;
        if (id) onOpenTask(id);
      }
    : undefined;

  const emptyLabel = t(($) => $.common.unset);
  const dispCode = (node: CockpitNode | null | undefined): string =>
    node ? (displayCodes.get(node.id) ?? node.code) : "";
  const moduleCode = (rootCode: string): string =>
    dispCode(nodeByCode.get(rootCode)) || rootCode;

  // The countdown hangs off the annual results-report milestone while it is
  // still open — that is the one the year is counted down to — rather than
  // sitting in the banner where it competes with the objective itself.
  const countdownMilestoneId = useMemo(() => {
    const target = milestones.find(
      (milestone) =>
        !isCockpitMilestoneDone(milestone) && milestone.name.includes(ANNUAL_REPORT_NAME),
    );
    return target?.id ?? null;
  }, [milestones]);

  // Only months the ledger touches get a column — one with a payment plan or
  // an actual payment — not every month in between.
  const chartMonths = useMemo(
    () => months.filter((month) => month.amount > 0 || month.actualSpend > 0),
    [months],
  );
  const maxMonthAmount = chartMonths.reduce((max, m) => Math.max(max, m.amount), 0);
  const maxMonthSpend = chartMonths.reduce(
    (max, m) => Math.max(max, m.plannedSpend, m.actualSpend + m.projectedSpend),
    0,
  );

  const joinLead = (parts: (string | null)[]): string => parts.filter(Boolean).join(" · ");

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Annual objective — the board's masthead banner: corner label, the
          goal itself in a frosted glass strip at the centre, and the live
          clock pinned top-right. Nothing else; the banner is one glance. */}
      <section className="cockpit-banner flex min-h-[116px] flex-col items-center justify-center gap-2 px-24 py-5 text-white">
        <span className="absolute top-4 left-5 inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-2.5 py-0.5 text-micro font-bold tracking-widest">
          <span aria-hidden>🎯</span>
          {t(($) => $.overview.mvp_label)}
        </span>
        <div className="cockpit-banner-glass">
          <EditableText
            value={board.cockpit.goal_title}
            onCommit={(goal_title) => onPatchBoard({ goal_title })}
            label={t(($) => $.overview.annual_goal)}
            placeholder={t(($) => $.overview.annual_goal_placeholder)}
            disabled={readOnly}
            displayClassName="text-title-lg font-extrabold text-white"
          />
        </div>
        <div className="absolute top-4 right-5 flex flex-col items-end gap-0.5">
          <span className="text-micro font-bold tracking-widest opacity-85">
            {t(($) => $.overview.clock)}
          </span>
          <BannerClock locale={locale} />
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
            {milestones.map((milestone) => {
              const node = milestone.node_id ? nodeById.get(milestone.node_id) : undefined;
              return (
                <MilestoneCard
                  key={milestone.id}
                  milestone={milestone}
                  node={node}
                  nodeCode={dispCode(node)}
                  countdownFrom={milestone.id === countdownMilestoneId ? today : null}
                  today={today}
                  fallbackDate={board.cockpit.goal_date}
                  onPatch={(patch) => onPatchMilestone(milestone.id, patch)}
                  onDelete={() => onDeleteMilestone(milestone.id)}
                  readOnly={readOnly}
                />
              );
            })}
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
              code={displayCodes.get(entry.node.id) ?? entry.node.code}
              rollup={rollups.get(entry.node.id)}
              today={today}
              readOnly={readOnly}
              emptyLabel={emptyLabel}
              ownerSuggestions={ownerSuggestions}
              onOpenBranch={onOpenBranch}
              onOpenModule={onOpenModule}
              onPatchNode={onPatchNode}
            />
          ))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {tree.slice(MODULE_BIG_COUNT).map((entry) => (
            <ModuleSmallCard
              key={entry.node.id}
              entry={entry}
              code={displayCodes.get(entry.node.id) ?? entry.node.code}
              rollup={rollups.get(entry.node.id)}
              today={today}
              readOnly={readOnly}
              emptyLabel={emptyLabel}
              ownerSuggestions={ownerSuggestions}
              onOpenBranch={onOpenBranch}
              onOpenModule={onOpenModule}
              onPatchNode={onPatchNode}
            />
          ))}
        </div>
      </Section>

      {/* The four narrative cards: what moved, what is coming, who is meeting,
          what is stuck. */}
      <div className="grid gap-4 md:grid-cols-2">
        <DigestCard
          title={t(($) => $.overview.card_overall)}
          icon="📈"
          hint={t(($) => $.overview.card_overall_hint, {
            from: formatShortDate(digest.overall.from, locale),
            to: formatShortDate(digest.overall.to, locale),
          })}
          override={board.cockpit.summary_overall}
          lead={joinLead([
            t(($) => $.overview.lead_done, { n: digest.overall.doneCount }),
            t(($) => $.overview.lead_active, { n: digest.overall.activeCount }),
            digest.overall.milestoneCount > 0
              ? t(($) => $.overview.lead_milestones, { n: digest.overall.milestoneCount })
              : null,
            digest.overall.paidCount > 0
              ? t(($) => $.overview.lead_paid, { amount: formatWan(digest.overall.paidAmount) })
              : null,
          ])}
          items={digest.overall.items}
          overflow={
            digest.overall.totalCount > digest.overall.items.length
              ? t(($) => $.overview.more_detail)
              : null
          }
          emptyLabel={t(($) => $.overview.empty_recent)}
          dispCode={dispCode}
          onCommit={(summary_overall) => onPatchBoard({ summary_overall })}
          onOpenTask={onOpenTask}
          onOpenCode={openByCode}
          readOnly={readOnly}
        />
        <DigestCard
          title={t(($) => $.overview.card_next)}
          icon="🎯"
          cap="next"
          hint={t(($) => $.overview.card_next_hint, {
            from: formatShortDate(digest.next.from, locale),
            to: formatShortDate(digest.next.to, locale),
          })}
          override={board.cockpit.summary_next}
          lead={joinLead([
            t(($) => $.overview.lead_due, { n: digest.next.dueCount }),
            digest.next.milestoneCount > 0
              ? t(($) => $.overview.lead_milestones, { n: digest.next.milestoneCount })
              : null,
            digest.next.plannedCount > 0
              ? t(($) => $.overview.lead_planned, {
                  amount: formatWan(digest.next.plannedAmount),
                })
              : null,
          ])}
          items={digest.next.items}
          overflow={
            digest.next.totalCount > digest.next.items.length
              ? t(($) => $.overview.more_items, { n: digest.next.totalCount })
              : null
          }
          emptyLabel={t(($) => $.overview.empty_next)}
          dispCode={dispCode}
          locale={locale}
          onCommit={(summary_next) => onPatchBoard({ summary_next })}
          onOpenTask={onOpenTask}
          onOpenCode={openByCode}
          readOnly={readOnly}
        />
        <MeetingsCard
          onOpenMeetings={onOpenMeetings}
          meetings={board.meetings}
          today={today}
          locale={locale}
          onPatch={onPatchMeeting}
          onCreate={onCreateMeeting}
          onDelete={onDeleteMeeting}
          readOnly={readOnly}
        />
        <DigestCard
          title={t(($) => $.overview.card_support)}
          icon="🤝"
          cap="support"
          hint={t(($) => $.overview.card_support_hint)}
          override={board.cockpit.summary_support}
          lead={joinLead([
            t(($) => $.overview.lead_blocked, { n: digest.support.blockedCount }),
            t(($) => $.overview.lead_overdue, { n: digest.support.overdueCount }),
          ])}
          items={digest.support.items}
          overflow={
            digest.support.totalCount > digest.support.items.length
              ? t(($) => $.overview.more_items, { n: digest.support.totalCount })
              : null
          }
          emptyLabel={t(($) => $.empty.no_support_needed)}
          dispCode={dispCode}
          tone="destructive"
          onCommit={(summary_support) => onPatchBoard({ summary_support })}
          onOpenTask={onOpenTask}
          onOpenCode={openByCode}
          readOnly={readOnly}
        />
      </div>

      {/* Finance — last, and the longest section on the page. */}
      <Section title={t(($) => $.overview.finance)} hint={t(($) => $.overview.finance_hint)}>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            // The budget is the figure the other three are measured against,
            // so it carries the gold the board reserves for budget.
            {
              key: "budget",
              label: t(($) => $.overview.fin_budget),
              value: finance.budget,
              title: null as string | null,
              className: "text-budget",
            },
            {
              key: "planned",
              label: t(($) => $.overview.fin_planned, { n: finance.lineCount }),
              value: finance.planned,
              title: null,
              className: "",
            },
            {
              key: "actual",
              label: t(($) => $.overview.fin_actual, { n: finance.paidLineCount }),
              value: finance.actual,
              // The fully-paid basis is reference, not headline: it rides in
              // the tooltip, like the prototype's title hint.
              title: t(($) => $.finance.actual_basis),
              className: "text-success",
            },
            {
              key: "outstanding",
              label: t(($) => $.overview.fin_outstanding),
              value: finance.outstanding,
              title: null,
              className: "",
            },
          ].map((cell) => (
            <div
              key={cell.key}
              className="rounded-md border border-border p-3"
              title={cell.title ?? undefined}
            >
              <dt className="text-caption text-muted-foreground">{cell.label}</dt>
              <dd className={cn("mt-1 text-title font-semibold tabular-nums", cell.className)}>
                {formatWan(cell.value)}
              </dd>
            </div>
          ))}
        </dl>

        <table className="mt-3 w-full text-caption">
          <thead>
            <tr className="border-b border-border text-left text-micro text-muted-foreground">
              <th className="py-1 font-medium">{t(($) => $.table.module)}</th>
              <th className="py-1 text-right font-medium">{t(($) => $.finance.line_header)}</th>
              <th className="py-1 text-right font-medium">{t(($) => $.table.planned_amount)}</th>
              <th className="py-1 text-right font-medium">{t(($) => $.table.actual_amount)}</th>
            </tr>
          </thead>
          <tbody>
            {finance.byModule.map((module) => (
              <tr key={module.code} className="border-b border-border/60 last:border-0">
                <td className="py-1">
                  <span
                    aria-hidden
                    className="mr-1.5 inline-block size-1.5 rounded-full align-middle"
                    style={{ backgroundColor: module.color || "var(--color-muted-foreground)" }}
                  />
                  <span className="font-mono text-micro text-muted-foreground">
                    {moduleCode(module.code)}
                  </span>{" "}
                  {module.name}
                </td>
                <td className="py-1 text-right tabular-nums">{module.lineCount}</td>
                <td className="py-1 text-right tabular-nums">{formatWan(module.planned)}</td>
                <td className="py-1 text-right tabular-nums">{formatWan(module.actual)}</td>
              </tr>
            ))}
            {finance.byModule.length === 0 && (
              <tr>
                <td colSpan={4} className="py-3 text-center text-muted-foreground">
                  {t(($) => $.overview.fin_empty)}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {chartMonths.length > 0 && (
          <>
            <div className="mt-4 mb-1 text-caption font-medium">
              {t(($) => $.finance.month_chart)}
              <span className="ml-2 font-normal text-muted-foreground">
                {t(($) => $.overview.month_note)}
              </span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {chartMonths.map((month) => {
                // Ascending by module code — the order the summary table and
                // the gantt read modules in, not a ranking by amount.
                const shares = [...month.byModule].sort((a, b) => a.code.localeCompare(b.code));
                const donePct =
                  month.dueCount > 0
                    ? `${Math.round((month.doneCount / month.dueCount) * 100)}%`
                    : "—";
                return (
                  <div
                    key={month.month}
                    className="flex min-w-32 flex-1 flex-col rounded-md border border-border bg-card p-2.5"
                  >
                    <div className="text-micro text-muted-foreground tabular-nums">
                      {monthLabel(month.month, locale)}
                    </div>
                    <div className="mt-0.5 text-body font-semibold tabular-nums">
                      {month.amount > 0 ? formatWan(month.amount) : "—"}
                    </div>
                    {/* The stacked column: instalments of this month by module
                        colour, one segment per root. */}
                    <div className="mt-2 flex h-20 items-end justify-center">
                      {month.amount > 0 ? (
                        <div className="flex w-6 flex-col-reverse overflow-hidden rounded-t-sm">
                          {shares.map((share) => (
                            <div
                              key={share.code}
                              title={`${moduleCode(share.code)} ${formatWan(share.amount)}`}
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
                      {shares.length > 0 ? (
                        shares.map((share) => (
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
                            <span className="text-muted-foreground">{moduleCode(share.code)}</span>
                            <span className="ml-auto font-medium">{formatWan(share.amount)}</span>
                          </div>
                        ))
                      ) : (
                        <span className="text-micro text-muted-foreground">—</span>
                      )}
                    </div>
                    {/* Planned against actual: what the month's spend lines are
                        worth, and how much of it has actually gone out. The
                        paler tail on the second track is the part still only
                        planned. */}
                    <div className="mt-2 border-t border-border pt-1.5">
                      <div className="flex items-baseline justify-between text-micro">
                        <span className="text-muted-foreground">
                          {t(($) => $.finance.planned_short)}
                        </span>
                        <span className="font-medium tabular-nums">
                          {month.plannedSpend > 0 ? formatWan(month.plannedSpend) : "—"}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-info transition-[width] duration-300"
                          style={{
                            width:
                              maxMonthSpend > 0
                                ? `${(month.plannedSpend / maxMonthSpend) * 100}%`
                                : "0%",
                          }}
                        />
                      </div>
                      <div className="mt-1.5 flex items-baseline justify-between text-micro">
                        <span className="text-muted-foreground">
                          {t(($) => $.finance.actual_short)}
                        </span>
                        <span
                          className={cn(
                            "font-medium tabular-nums",
                            month.actualSpend > 0 && "text-success",
                          )}
                        >
                          {month.actualSpend > 0 ? formatWan(month.actualSpend) : "—"}
                          {month.projectedSpend > 0 && (
                            <span className="ml-1 font-normal text-muted-foreground">
                              {t(($) => $.finance.plus_projected, {
                                amount: formatWan(month.projectedSpend),
                              })}
                            </span>
                          )}
                        </span>
                      </div>
                      <div
                        className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-muted"
                        title={t(($) => $.finance.actual_track, {
                          n: month.actualCount,
                          amount: formatWan(month.actualSpend),
                        })}
                      >
                        <div
                          className="h-full bg-success transition-[width] duration-300"
                          style={{
                            width:
                              maxMonthSpend > 0
                                ? `${(month.actualSpend / maxMonthSpend) * 100}%`
                                : "0%",
                          }}
                        />
                        <div
                          className="h-full bg-success/35 transition-[width] duration-300"
                          style={{
                            width:
                              maxMonthSpend > 0
                                ? `${(month.projectedSpend / maxMonthSpend) * 100}%`
                                : "0%",
                          }}
                        />
                      </div>
                    </div>
                    <div className="mt-2 border-t border-border pt-1.5">
                      <div className="text-micro text-muted-foreground tabular-nums">
                        {t(($) => $.overview.month_progress, { pct: donePct })}
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
                      <div className="mt-1 text-micro text-muted-foreground tabular-nums">
                        {t(($) => $.overview.month_detail, {
                          due: month.dueCount,
                          done: month.doneCount,
                          doing: month.activeCount,
                        })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

interface ModuleCardProps {
  entry: CockpitTreeNode;
  code: string;
  rollup: CockpitRollup | undefined;
  today: string;
  readOnly?: boolean;
  emptyLabel: string;
  ownerSuggestions: string[];
  onOpenBranch: (nodeId: string) => void;
  /** When the host wires it, the whole card opens the module's gantt slice. */
  onOpenModule?: (rootCode: string) => void;
  onPatchNode: (id: string, patch: CockpitNodePatch) => void;
}

function ModuleBigCard({
  entry,
  code,
  rollup,
  today,
  readOnly,
  emptyLabel,
  ownerSuggestions,
  onOpenBranch,
  onOpenModule,
  onPatchNode,
}: ModuleCardProps) {
  const { t } = useT("cockpit");
  // Cancelled work is not work the module owes anyone, so the headline ratio
  // counts what is live — which is also what the progress bar fills to.
  const pct = rollup?.live.doneRatio ?? Math.round(entry.node.progress);
  const color = entry.color || "var(--color-brand)";
  const highlights = useMemo(() => cockpitModuleHighlights(entry, today), [entry, today]);
  const interaction = onOpenModule
    ? moduleCardInteraction(
        entry.node.code,
        t(($) => $.overview.open_module_card, { code }),
        onOpenModule,
      )
    : undefined;
  return (
    <article
      className={cn("rounded-lg border border-border bg-card p-4", interaction && "cursor-pointer")}
      style={{ borderTopColor: color, borderTopWidth: 4 }}
      {...interaction}
    >
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenBranch(entry.node.id);
          }}
          aria-label={t(($) => $.overview.open_module, { code })}
          className="font-mono text-micro font-medium hover:underline"
          style={{ color }}
        >
          {code}
        </button>
        <EditableText
          value={entry.node.name}
          onCommit={(name) => onPatchNode(entry.node.id, { name })}
          label={t(($) => $.node.name)}
          placeholder={t(($) => $.node.name_placeholder)}
          disabled={readOnly}
          displayClassName="flex-1 font-medium"
        />
        <EditableSuggest
          value={entry.node.owner}
          onCommit={(owner) => onPatchNode(entry.node.id, { owner })}
          suggestions={ownerSuggestions}
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
            {rollup?.live.doneCount ?? 0}/{rollup?.live.leafCount ?? 0}
          </dd>
          <dt className="text-micro text-muted-foreground">{t(($) => $.overview.done_total)}</dt>
        </div>
        <div className="rounded-md bg-muted/50 p-2 text-center">
          <dd className="text-body font-semibold tabular-nums">{pct}%</dd>
          <dt className="text-micro text-muted-foreground">{t(($) => $.overview.progress)}</dt>
        </div>
        <div className="rounded-md bg-muted/50 p-2 text-center">
          <dd className="text-body font-semibold tabular-nums">{rollup?.live.activeCount ?? 0}</dd>
          <dt className="text-micro text-muted-foreground">{t(($) => $.overview.module_active)}</dt>
        </div>
        <div className="rounded-md bg-muted/50 p-2 text-center">
          <dd className="text-body font-semibold text-budget tabular-nums">
            {(rollup?.budget ?? 0) > 0 ? formatWan(rollup!.budget) : "—"}
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
            {highlights.next ? `${highlights.next.name} · ${highlights.next.end_date}` : "—"}
          </span>
          {(rollup?.live.lateCount ?? 0) > 0 && (
            <span className="shrink-0 text-micro font-medium text-destructive tabular-nums">
              {t(($) => $.overview.overdue)} {rollup!.live.lateCount}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function ModuleSmallCard({
  entry,
  code,
  rollup,
  readOnly,
  emptyLabel,
  ownerSuggestions,
  onOpenBranch,
  onOpenModule,
  onPatchNode,
}: ModuleCardProps) {
  const { t } = useT("cockpit");
  const pct = rollup?.live.doneRatio ?? Math.round(entry.node.progress);
  const color = entry.color || "var(--color-brand)";
  const interaction = onOpenModule
    ? moduleCardInteraction(
        entry.node.code,
        t(($) => $.overview.open_module_card, { code }),
        onOpenModule,
      )
    : undefined;
  return (
    <article
      className={cn("rounded-lg border border-border bg-card p-3", interaction && "cursor-pointer")}
      style={{ borderLeftColor: color, borderLeftWidth: 3 }}
      {...interaction}
    >
      <div className="flex items-baseline gap-2">
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenBranch(entry.node.id);
          }}
          aria-label={t(($) => $.overview.open_module, { code })}
          className="font-mono text-micro font-medium hover:underline"
          style={{ color }}
        >
          {code}
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
      {/* "5/8 项 · 63% · 负责 李林" — the one line the prototype's compact
          cards carry; the owner stays editable inside it. */}
      <div className="mt-2 flex flex-wrap items-baseline gap-x-1 gap-y-0.5 text-micro text-muted-foreground tabular-nums">
        <span>
          {t(($) => $.overview.small_summary, {
            done: rollup?.live.doneCount ?? 0,
            total: rollup?.live.leafCount ?? 0,
            pct,
          })}
        </span>
        <EditableSuggest
          value={entry.node.owner}
          onCommit={(owner) => onPatchNode(entry.node.id, { owner })}
          suggestions={ownerSuggestions}
          label={t(($) => $.node.owner)}
          placeholder={emptyLabel}
          disabled={readOnly}
          displayClassName="text-micro text-muted-foreground"
        />
      </div>
    </article>
  );
}

function MilestoneCard({
  milestone,
  node,
  nodeCode,
  countdownFrom,
  fallbackDate,
  today,
  onPatch,
  onDelete,
  readOnly,
}: {
  milestone: CockpitMilestone;
  node: CockpitNode | undefined;
  nodeCode: string;
  /** Today, when this milestone carries the board's countdown; null otherwise. */
  countdownFrom: string | null;
  fallbackDate: string | null;
  today: string;
  onPatch: (patch: CockpitMilestonePatch) => void;
  onDelete: () => void;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const done = isCockpitMilestoneDone(milestone);
  const color = cockpitMilestoneStatusColor(milestone.status);

  const target = parseDay(milestone.plan_date ?? fallbackDate);
  const from = parseDay(countdownFrom);
  const daysLeft = countdownFrom && target && from ? daysBetween(from, target) : null;

  return (
    // The track: a dot on the timeline, the card hanging below it. The
    // connector between dots lives in cockpit.css on .cockpit-ms-node.
    <li
      className="cockpit-ms-node group/ms flex min-w-56 flex-1 shrink flex-col items-center px-2"
      data-done={done || undefined}
      // The gate condition is reference, not headline: it sits in the tooltip
      // so the card stays one glance tall.
      title={milestone.condition || undefined}
    >
      <span
        className="cockpit-ms-dot"
        style={done ? undefined : { borderColor: color }}
        aria-hidden
      />
      <div className="cockpit-ms-card relative mt-2 w-full rounded-lg border p-3 transition-shadow hover:shadow-md">
        <span
          className="inline-block rounded-sm px-1.5 py-px text-micro font-medium text-white"
          style={{ backgroundColor: color }}
        >
          {milestone.status || t(($) => $.common.unset)}
        </span>
        <EditableText
          value={milestone.name}
          onCommit={(name) => onPatch({ name })}
          label={t(($) => $.milestone.name)}
          placeholder={t(($) => $.milestone.name_placeholder)}
          disabled={readOnly}
          displayClassName="mt-1 font-medium"
        />
        {/* One date line: the date it landed on once it has — falling back to
            the plan when nobody recorded it — otherwise the date it is due.
            An open milestone does not carry an empty completion field. */}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-micro">
          <span className="text-muted-foreground">
            {done
              ? t(($) => $.overview.milestone_done_date)
              : t(($) => $.overview.milestone_plan_date)}
          </span>
          <EditableDate
            value={done ? (milestone.actual_date ?? milestone.plan_date) : milestone.plan_date}
            onCommit={(value) => onPatch(done ? { actual_date: value } : { plan_date: value })}
            label={
              done
                ? t(($) => $.overview.milestone_done_date)
                : t(($) => $.overview.milestone_plan_date)
            }
            placeholder={t(($) => $.common.unset)}
            disabled={readOnly}
            displayClassName="font-medium"
          />
          {/* The card is the only place a milestone is edited, so an open one
              still needs its way across the finish line: recording the day it
              landed. Clearing the date on a done card reopens it. */}
          {!done && !readOnly && (
            <button
              type="button"
              onClick={() => onPatch({ actual_date: today })}
              className="rounded-sm border border-border px-1 text-micro text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t(($) => $.overview.mark_done)}
            </button>
          )}
        </div>
        {daysLeft !== null && (
          <div className="mt-1.5 inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-px text-micro">
            <span aria-hidden>⏳</span>
            {daysLeft >= 0
              ? t(($) => $.overview.days_left, { days: daysLeft })
              : t(($) => $.overview.days_over, { days: -daysLeft })}
          </div>
        )}
        {node && (
          <div className="mt-1.5 flex items-center gap-1 text-micro text-muted-foreground">
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: node.color || "var(--color-muted-foreground)" }}
            />
            <span className="font-mono">{nodeCode}</span>
            <span className="truncate">{node.name}</span>
          </div>
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
  icon,
  cap,
  hint,
  override,
  lead,
  items,
  overflow,
  emptyLabel,
  dispCode,
  locale,
  onCommit,
  readOnly,
  tone,
  onOpenTask,
  onOpenCode,
}: {
  title: string;
  icon: string;
  cap?: "next" | "support";
  hint: string;
  override: string;
  /** The derived card's opening line. */
  lead: string;
  items: CockpitDigestItem[];
  /** Footnote when the window holds more than the card shows. */
  overflow: string | null;
  emptyLabel: string;
  dispCode: (node: CockpitNode | null | undefined) => string;
  /** Only the dated card needs it. */
  locale?: string;
  onCommit: (next: string) => void;
  readOnly?: boolean;
  tone?: "destructive";
  onOpenTask?: (nodeId: string) => void;
  onOpenCode?: (code: string) => void;
}) {
  const { t } = useT("cockpit");
  return (
    <NarrativeCard
      title={title}
      icon={icon}
      hint={hint}
      cap={cap}
      badge={
        <span className="text-micro text-muted-foreground">
          {override ? t(($) => $.overview.card_manual) : t(($) => $.overview.card_auto)}
        </span>
      }
    >
      {override ? (
        <>
          <EditableTextArea
            value={override}
            onCommit={onCommit}
            label={title}
            placeholder={t(($) => $.overview.card_placeholder)}
            disabled={readOnly}
            rows={5}
          />
          <div className="mt-2 border-t border-border pt-2">
            <ManualCardBody text={override} onOpenCode={onOpenCode} />
          </div>
        </>
      ) : (
        <>
          <p className="mb-1.5 text-caption text-muted-foreground">
            <CardProse text={lead} />
          </p>
          {items.length === 0 ? (
            <p className="text-body text-muted-foreground">{emptyLabel}</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {items.map((item) => (
                <CardItem
                  key={item.key}
                  date={locale ? formatShortDate(item.date, locale) : undefined}
                  code={item.kind === "task" ? dispCode(item.node) : undefined}
                  icon={item.kind === "milestone" ? "🎯" : item.kind === "payment" ? "💰" : undefined}
                  title={item.title}
                  tag={item.kind === "milestone" ? t(($) => $.overview.tag_milestone) : undefined}
                  badge={
                    item.progress != null
                      ? `${Math.round(item.progress)}%`
                      : item.amount != null
                        ? formatWan(item.amount)
                        : undefined
                  }
                  tone={tone}
                  onOpen={item.node && onOpenTask ? () => onOpenTask(item.node!.id) : undefined}
                  openLabel={t(($) => $.overview.open_task, { code: dispCode(item.node) })}
                />
              ))}
            </ul>
          )}
          {overflow && <p className="mt-1 text-micro text-muted-foreground">{overflow}</p>}
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
    </NarrativeCard>
  );
}

/** Monday of the week `iso` falls in, and the Sunday that closes it. */
function weekWindow(iso: string): [string, string] | null {
  const date = parseDay(iso);
  if (!date) return null;
  const offset = (date.getUTCDay() + 6) % 7;
  const start = addDays(date, -offset);
  return [formatDay(start), formatDay(addDays(start, 6))];
}

function MeetingsCard({
  meetings,
  today,
  locale,
  onPatch,
  onCreate,
  onDelete,
  onOpenMeetings,
  readOnly,
}: {
  meetings: CockpitMeeting[];
  today: string;
  locale: string;
  onPatch: (id: string, patch: CockpitMeetingPatch) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onOpenMeetings: (meetingId?: string) => void;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  const [showAll, setShowAll] = useState(false);

  const { shown, thisWeek } = useMemo(() => {
    const week = weekWindow(today);
    const sorted = [...meetings].sort((a, b) =>
      `${a.meet_date ?? ""}${a.time_range}`.localeCompare(`${b.meet_date ?? ""}${b.time_range}`),
    );
    const inWeek = new Set(
      week
        ? sorted.filter((m) => m.meet_date && m.meet_date >= week[0] && m.meet_date <= week[1])
        : [],
    );
    if (inWeek.size > 0) return { shown: sorted.filter((m) => inWeek.has(m)), thisWeek: inWeek };
    // Nothing this week — lead with the next one on the calendar, and say so
    // plainly when there is none either. History stays where it belongs,
    // behind the "show all" toggle.
    const next = sorted.find((m) => m.meet_date && m.meet_date > today);
    if (next) return { shown: [next], thisWeek: inWeek };
    return { shown: [], thisWeek: inWeek };
  }, [meetings, today]);

  const list = showAll ? [...meetings] : shown;

  return (
    <NarrativeCard
      title={t(($) => $.overview.card_meetings)}
      icon="📅"
      cap="meetings"
      hint={t(($) => $.overview.card_meetings_hint)}
      action={
        <>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            onClick={() => onOpenMeetings()}
          >
            {t(($) => $.meetings.open_register)}
          </Button>
          {!readOnly && (
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={onCreate}>
              <Plus className="size-3.5" />
              {t(($) => $.meeting.new)}
            </Button>
          )}
        </>
      }
    >
      {list.length === 0 ? (
        <p className="text-body text-muted-foreground">{t(($) => $.overview.meetings_empty)}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {list.map((meeting) => (
            <MeetingRow
              key={meeting.id}
              meeting={meeting}
              locale={locale}
              tag={
                thisWeek.has(meeting)
                  ? t(($) => $.meeting.this_week)
                  : meeting.meet_date && meeting.meet_date > today
                    ? t(($) => $.meeting.upcoming)
                    : null
              }
              onPatch={(patch) => onPatch(meeting.id, patch)}
              onDelete={() => onDelete(meeting.id)}
              onOpen={() => onOpenMeetings(meeting.id)}
              readOnly={readOnly}
            />
          ))}
        </ul>
      )}
      {meetings.length > shown.length && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 px-2 text-caption"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll
            ? t(($) => $.meeting.show_upcoming)
            : t(($) => $.meeting.show_all, { n: meetings.length })}
        </Button>
      )}
    </NarrativeCard>
  );
}

function MeetingRow({
  meeting,
  locale,
  tag,
  onPatch,
  onDelete,
  onOpen,
  readOnly,
}: {
  meeting: CockpitMeeting;
  locale: string;
  tag: string | null;
  onPatch: (patch: CockpitMeetingPatch) => void;
  onDelete: () => void;
  onOpen: () => void;
  readOnly?: boolean;
}) {
  const { t } = useT("cockpit");
  // The row opens the read-only detail dialog; the inline editor is reached
  // from the dialog's footer, so editing stays one hop from reading.
  const [detailOpen, setDetailOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const date = parseDay(meeting.meet_date);
  // Agenda lines are written as a list, one bullet per line or semicolon.
  const agenda = useMemo(
    () =>
      meeting.note
        .split(/\n|;|；/)
        .map((line) => line.trim())
        .filter(Boolean),
    [meeting.note],
  );

  return (
    <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
      <li className="group/meet">
        <div
          role="button"
          tabIndex={0}
          aria-label={t(($) => $.meeting.details, {
            title: meeting.title || t(($) => $.meeting.title_placeholder),
          })}
          onClick={() => setDetailOpen(true)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setDetailOpen(true);
          }}
          className="flex cursor-pointer gap-2.5 rounded-sm py-2 hover:bg-accent"
        >
          {/* A calendar chip reads faster than an ISO date in a list of five. */}
          <div className="flex size-9 shrink-0 flex-col items-center justify-center rounded-md border border-border bg-muted/50 leading-none">
            <b className="text-caption tabular-nums">{date ? date.getUTCDate() : "--"}</b>
            <span className="text-micro text-muted-foreground">
              {date ? date.toLocaleDateString(locale, { month: "short" }) : ""}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="min-w-0 flex-1 truncate text-left font-medium">
                {meeting.title || t(($) => $.meeting.title_placeholder)}
              </span>
              {tag && (
                <span className="shrink-0 rounded-sm border border-border px-1 text-micro text-muted-foreground">
                  {tag}
                </span>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-micro text-muted-foreground">
              <span>⏰ {cockpitMeetingSpan(meeting) || t(($) => $.common.unset)}</span>
              <span>👥 {meeting.parties || meeting.attendees || t(($) => $.common.unset)}</span>
              {meeting.meet_no && <span>#{meeting.meet_no}</span>}
            </div>
          </div>
        </div>
        {editOpen && (
          <div className="mb-2 flex flex-col gap-1 rounded-md border border-border p-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
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
            </div>
            <EditableText
              value={meeting.attendees}
              onCommit={(attendees) => onPatch({ attendees })}
              label={t(($) => $.meeting.attendees)}
              placeholder={t(($) => $.meeting.attendees)}
              disabled={readOnly}
              displayClassName="text-caption text-muted-foreground"
            />
            {meeting.note && (
              <p className="whitespace-pre-line text-micro text-muted-foreground">{meeting.note}</p>
            )}
            {!readOnly && (
              <button
                type="button"
                onClick={onDelete}
                aria-label={t(($) => $.meeting.delete, { title: meeting.title })}
                className="self-start rounded-sm p-1 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
        )}
      </li>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{meeting.title || t(($) => $.meeting.title_placeholder)}</DialogTitle>
        </DialogHeader>
        <p className="text-caption text-muted-foreground">
          ⏰ {meeting.meet_date || t(($) => $.meeting.date)}
          {meeting.time_range ? ` ${meeting.time_range}` : ""}
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
          <dt className="text-muted-foreground">{t(($) => $.meeting.attendees)}</dt>
          <dd className="min-w-0">{meeting.attendees || t(($) => $.common.unset)}</dd>
          <dt className="text-muted-foreground">{t(($) => $.meeting.meet_no)}</dt>
          <dd className="min-w-0 font-medium tracking-wide">
            {meeting.meet_no || t(($) => $.common.unset)}
          </dd>
        </dl>
        <div className="flex flex-col gap-1 text-caption">
          {agenda.length > 0 ? (
            agenda.map((line) => (
              <p key={line}>• {line}</p>
            ))
          ) : (
            <p className="text-muted-foreground">{t(($) => $.meeting.no_agenda)}</p>
          )}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" onClick={onOpen} />}>
            {t(($) => $.meetings.open_register)}
          </DialogClose>
          {!readOnly && (
            <DialogClose
              render={
                <Button variant="outline" size="sm" onClick={() => setEditOpen(true)} />
              }
            >
              {t(($) => $.meeting.edit)}
            </DialogClose>
          )}
          {meeting.link && (
            <Button
              size="sm"
              render={<a href={meeting.link} target="_blank" rel="noopener noreferrer" />}
            >
              {t(($) => $.meeting.open)}
              <ExternalLink className="size-3.5" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
