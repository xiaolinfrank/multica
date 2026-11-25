"use client";

import { CalendarDays, Check, Diamond, Target, TriangleAlert } from "@multica/ui/icons";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multica/ui/components/ui/tooltip";
import { cn } from "@multica/ui/lib/utils";
import { cockpitEffectiveProgress, type CockpitCoreNodeKind, type CockpitGoalProgress, type CockpitPaymentGroup, type CockpitRollup } from "@multica/core/cockpit";
import type { CockpitNode, CockpitPayment, CockpitPlanMeetingMarkerGroup, CockpitPlanTaskCount } from "@multica/core/types";
import type { ComponentType, SVGProps } from "react";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { StatusChip } from "./cockpit-status";
import { instalmentLine, paymentLine, wan } from "./cockpit-gantt-helpers";

function TooltipRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <span className="text-caption">
      <span className="text-muted-foreground">{label}</span> {value}
    </span>
  );
}

export function BarTooltipBody({
  node,
  code,
  rollup,
  payments,
  taskCount,
}: {
  node: CockpitNode;
  code: string;
  rollup: CockpitRollup | undefined;
  payments: CockpitPayment[];
  taskCount: CockpitPlanTaskCount | undefined;
}) {
  const { t } = useT("cockpit");
  const start = node.start_date ?? rollup?.start ?? null;
  const end = node.end_date ?? rollup?.end ?? null;
  return (
    <div className="flex max-w-80 flex-col gap-1">
      <span className="font-medium">
        {code} · {node.name}
      </span>
      {code !== node.code && (
        <span className="text-caption text-muted-foreground">
          {t(($) => $.gantt.original_code, { code: node.code })}
        </span>
      )}
      {(start || end) && (
        <span className="text-caption tabular-nums">
          {start ?? "—"} → {end ?? "—"}
        </span>
      )}
      <TooltipRow label={t(($) => $.node.owner)} value={node.owner} />
      <TooltipRow label={t(($) => $.node.collaborators)} value={node.collaborators} />
      {/* The fields the board this replaces buried in a maintenance table.
          They are what a reviewer actually asks about, so they travel with the
          bar rather than waiting behind a click. */}
      <TooltipRow label={t(($) => $.node.deliverable)} value={node.deliverable} />
      <TooltipRow label={t(($) => $.node.current_progress)} value={node.current_progress} />
      <TooltipRow label={t(($) => $.node.dependencies)} value={node.dependencies} />
      <TooltipRow
        label={t(($) => $.node.linked_issues)}
        value={taskCount ? t(($) => $.plan_views.task_counts, { primary: taskCount.primary_total, reference: taskCount.reference_total }) : ""}
      />
      <TooltipRow label={t(($) => $.node.vendor)} value={node.vendor} />
      <TooltipRow
        label={t(($) => $.node.budget)}
        value={node.budget_amount == null ? "" : wan(node.budget_amount)}
      />
      <TooltipRow label={t(($) => $.node.budget_category)} value={node.budget_category} />
      <TooltipRow label={t(($) => $.node.exec_status)} value={node.exec_status} />
      <TooltipRow
        label={t(($) => $.node.payments)}
        value={payments.map(instalmentLine).join("；")}
      />
      <TooltipRow label={t(($) => $.node.contract)} value={node.contract} />
      <TooltipRow label={t(($) => $.node.note)} value={node.note} />
    </div>
  );
}

/**
 * One settled or scheduled payment group on a direction row. The disc and the
 * amount ride the top strip of the row; colour alone says whether the money
 * left (green) or is still to find (gold).
 */
export function PaymentMarker({
  group,
  left,
  onSelect,
}: {
  group: CockpitPaymentGroup;
  left: number;
  onSelect: (nodeId: string) => void;
}) {
  const { t } = useT("cockpit");
  const color = group.paid ? "var(--success)" : "var(--warning)";
  const state = group.paid ? t(($) => $.finance.payment_paid) : t(($) => $.finance.payment_planned);
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => onSelect(group.entries[0]!.node.id)}
              aria-label={`${state} · ${t(($) => $.finance.payment_on, { date: group.date })}`}
              // A marker lands either on the bar or on the bare track, so it
              // carries its own disc of card background — a gold ring on brand
              // blue alone is too close in lightness to find at a glance.
              className="absolute z-10 flex size-3 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[1.5px] bg-card text-micro leading-none font-bold shadow-sm"
              style={{ left, top: "26%", borderColor: color, color }}
            >
              ¥
            </button>
          }
        />
        <TooltipContent>
          <div className="flex max-w-80 flex-col gap-0.5">
            <span className="font-medium tabular-nums">
              {group.month
                ? t(($) => $.finance.payment_month, {
                    month: group.month,
                    count: group.entries.length,
                    total: wan(group.total),
                  })
                : `${state} · ${group.date} · ${t(($) => $.finance.payment_total, {
                    total: wan(group.total),
                  })}`}
            </span>
            {group.entries.map(({ payment, node }) => (
              <span key={payment.id} className="text-caption">
                {paymentLine(payment, node)}
              </span>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
      <span
        className="pointer-events-none absolute -translate-y-1/2 rounded-sm bg-card/85 px-1 py-px text-micro leading-none font-bold whitespace-nowrap tabular-nums shadow-sm"
        style={{ left: left + 9, top: "26%", color }}
        aria-hidden
      >
        {wan(group.total)}
      </span>
    </>
  );
}

/** The annual-objective marker's colour: the one purple the design system has no token for. */
const CORE_GOAL_COLOR = "#7c3aed";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

const CORE_KIND_META: Record<CockpitCoreNodeKind | "goal", { Icon: IconComponent; color: string }> = {
  done: { Icon: Check, color: "var(--success)" },
  blocked: { Icon: TriangleAlert, color: "var(--destructive)" },
  upcoming: { Icon: Diamond, color: "var(--brand)" },
  goal: { Icon: Target, color: CORE_GOAL_COLOR },
};

/**
 * Where the row code can stay legible. White inside the bar only works while
 * the label sits wholly on a solid status fill; a light "unstarted" bar takes
 * the foreground ink, and a bar whose recorded progress does not reach past
 * the label pushes the code out past the bar end instead — the veil over the
 * unfinished tail never gets to swallow white text again.
 */

export function MeetingMarker({ group, left, onOpenMeeting, registerHref }: {
  group: CockpitPlanMeetingMarkerGroup; left: number; onOpenMeeting: (id: string) => void; registerHref: string;
}) {
  const { t } = useT("cockpit");
  const summary = t(($) => $.gantt.meetings_on, { date: group.date, count: group.total });
  return <Dialog><Tooltip><TooltipTrigger render={<DialogTrigger render={<button type="button" aria-label={summary}
    className="absolute z-10 flex h-4 min-w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[1.5px] border-info bg-card px-1 text-micro leading-none font-bold text-info shadow-sm" style={{ left, top: "12%" }} />} />}>
    <CalendarDays className="size-2.5" strokeWidth={2.5} aria-hidden />{group.total > 1 && <span>{group.total}</span>}
  </TooltipTrigger><TooltipContent>{summary}</TooltipContent></Tooltip>
    <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{summary}</DialogTitle></DialogHeader>
      <ul className="max-h-72 divide-y overflow-y-auto">{group.items.map((meeting) => <li key={meeting.id}>
        <DialogClose render={<Button variant="link" className="h-auto w-full justify-start py-2 text-left" onClick={() => onOpenMeeting(meeting.id)} />}>
          <span className="min-w-0"><span className="line-clamp-2 break-words" title={meeting.title}>{meeting.title}</span><span className="text-caption text-muted-foreground">{meeting.start_time}</span></span>
        </DialogClose></li>)}</ul>
      <DialogClose nativeButton={false} render={<AppLink href={registerHref} className="text-caption text-primary underline" />}>{t(($) => $.meeting_center.open_register)}</DialogClose>
    </DialogContent>
  </Dialog>;
}

export function CoreMarker({
  kind,
  date,
  count,
  nodes,
  goalTitle,
  taskCounts,
  left,
  onSelect,
}: {
  kind: CockpitCoreNodeKind | "goal";
  date: string;
  count: number;
  nodes: CockpitNode[];
  goalTitle: string | null;
  taskCounts: ReadonlyMap<string, CockpitPlanTaskCount>;
  left: number;
  onSelect: (nodeId: string) => void;
}) {
  const { t } = useT("cockpit");
  const meta = CORE_KIND_META[kind];
  const summary =
    kind === "goal"
      ? t(($) => $.gantt.core_goal, { title: goalTitle ?? "", date })
      : kind === "done"
        ? t(($) => $.gantt.core_done, { date, count })
        : kind === "blocked"
          ? t(($) => $.gantt.core_blocked, { date, count })
          : t(($) => $.gantt.core_upcoming, { date, count });
  const marker = (
    <button
      type="button"
      aria-label={summary}
      className="absolute z-10 flex h-4 min-w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-px rounded-full border-[1.5px] bg-card px-1 text-micro leading-none font-bold shadow-sm"
      style={{ left, top: "76%", borderColor: meta.color, color: meta.color }}
    >
      <meta.Icon className="size-2.5" strokeWidth={2.5} aria-hidden />
      {kind !== "goal" && count > 1 && <span>{count}</span>}
    </button>
  );
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger render={<DialogTrigger render={marker} />} />
        <TooltipContent>
          <div className="flex max-w-80 flex-col gap-0.5">
            <span className="font-medium">{summary}</span>
            {nodes.slice(0, 5).map((node) => (
              <span key={node.id} className="text-caption">
                {node.name} · {node.status || t(($) => $.gantt.status_unscheduled)}
              </span>
            ))}
            {nodes.length > 5 && (
              <span className="text-caption text-muted-foreground">
                {t(($) => $.gantt.core_more, { count: nodes.length - 5 })}
              </span>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{summary}</DialogTitle>
        </DialogHeader>
        {nodes.length === 0 ? (
          <p className="text-body text-muted-foreground">{t(($) => $.gantt.core_goal_body, { title: goalTitle ?? "", date })}</p>
        ) : (
          <ul className="flex flex-col">
            {nodes.map((node) => (
              <li key={node.id} className="border-b border-border py-2 last:border-b-0">
                <DialogClose
                  render={
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto whitespace-normal text-left"
                      onClick={() => onSelect(node.id)}
                    />
                  }
                >
                  {node.name}
                </DialogClose>
                <div className="text-caption text-muted-foreground">
                  {node.end_date} · <StatusChip status={node.status} />
                </div>
                <div className="text-caption text-muted-foreground">
                  {t(($) => $.node.owner)}: {node.owner || "—"} ·{" "}
                  {t(($) => $.node.progress)}: {cockpitEffectiveProgress(node, taskCounts.get(node.id))}%
                </div>
                {node.deliverable && (
                  <div className="text-caption text-muted-foreground">
                    {t(($) => $.node.deliverable)}: {node.deliverable}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Percent plus a 22px rail — the branch read that a number alone doesn't give. */
export function MiniProgress({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-micro font-bold tabular-nums", className)}>
      {value}%
      <span className="h-1 w-[22px] overflow-hidden rounded-full bg-current/20">
        <span className="cockpit-grow block h-full rounded-full bg-current" style={{ width: `${value}%` }} />
      </span>
    </span>
  );
}

/** How a module is tracking against the annual objective, as a clickable chip. */
export function GoalChip({
  goal,
  goalDate,
  onOpen,
}: {
  goal: CockpitGoalProgress;
  goalDate: string;
  onOpen: () => void;
}) {
  const { t } = useT("cockpit");
  if (goal.actual == null) return null;
  const gap = goal.gapPts;
  const drift =
    gap == null
      ? t(($) => $.gantt.goal_on_track)
      : gap > 0
        ? t(($) => $.gantt.goal_behind, { pts: gap })
        : gap < 0
          ? t(($) => $.gantt.goal_ahead, { pts: -gap })
          : t(($) => $.gantt.goal_on_track);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              "flex items-center gap-1 rounded-sm border px-1 py-px",
              goal.behind
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-success/30 bg-success/10 text-success",
            )}
          >
            <Target className="size-3" aria-hidden />
            <MiniProgress value={goal.actual} />
          </button>
        }
      />
      <TooltipContent>
        <div className="flex max-w-80 flex-col gap-0.5">
          <span className="font-medium">{t(($) => $.gantt.goal_chip)}</span>
          <span className="text-caption">
            {t(($) => $.gantt.goal_actual, { pct: goal.actual })}
            {goal.scheduled != null && ` · ${t(($) => $.gantt.goal_scheduled, { pct: goal.scheduled })}`}
            {` · ${drift}`}
          </span>
          {goal.latestEnd && goal.planVsGoalDays != null && (
            <span className="text-caption">
              {goal.planVsGoalDays > 0
                ? t(($) => $.gantt.goal_late_days, {
                    date: goal.latestEnd,
                    days: goal.planVsGoalDays,
                  })
                : t(($) => $.gantt.goal_early_days, {
                    date: goal.latestEnd,
                    days: -goal.planVsGoalDays,
                  })}
            </span>
          )}
          {goal.crossYearCount > 0 && (
            <span className="text-caption">
              {t(($) => $.gantt.goal_cross_year, { count: goal.crossYearCount })}
            </span>
          )}
          <span className="text-caption text-muted-foreground">
            {t(($) => $.gantt.goal_basis, { date: goalDate, n: goal.taskCount })}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
