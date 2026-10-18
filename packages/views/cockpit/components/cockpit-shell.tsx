"use client";

import { useEffect, useId, useRef } from "react";
import { LayoutGroup, motion, useReducedMotion } from "motion/react";
import { cockpitSurfacePath, type CockpitScope, type CockpitSurface } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { buttonVariants } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { CalendarDays, ChartNoAxesGantt, Files, LayoutDashboard, Layers3, MessageSquare, ShieldCheck } from "lucide-react";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export function CockpitShell({ surface, scope, title, scopeControl, secondaryNavigation, actions, notice, pendingChangeCount, artifactsAvailable = false, focusedWorkbench = false, scopeSummary, children }: {
  surface: CockpitSurface;
  scope: CockpitScope;
  title?: React.ReactNode;
  scopeControl: React.ReactNode;
  secondaryNavigation?: React.ReactNode;
  actions?: React.ReactNode;
  notice?: React.ReactNode;
  pendingChangeCount?: number;
  artifactsAvailable?: boolean;
  focusedWorkbench?: boolean;
  scopeSummary?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const motionId = useId();
  const reduceMotion = useReducedMotion();
  const navigationRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navigationRef.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [surface, artifactsAvailable, pendingChangeCount, scope.projectId, scope.moduleId]);
  const navigation = [
    { value: "chat" as const, label: t(($) => $.shell.chat), Icon: MessageSquare },
    { value: "work" as const, label: t(($) => $.shell.overview), Icon: LayoutDashboard },
    { value: "plan" as const, label: t(($) => $.shell.plan), Icon: ChartNoAxesGantt },
    { value: "meetings" as const, label: t(($) => $.shell.meetings), Icon: CalendarDays },
    ...(artifactsAvailable ? [{ value: "artifacts" as const, label: t(($) => $.shell.artifacts), Icon: Files }] : []),
    { value: "governance" as const, label: t(($) => $.shell.governance), Icon: ShieldCheck },
  ];
  return <section data-cockpit-design="silver" data-surface={surface} className="cockpit-skin cockpit-frame @container/cockpit-shell flex h-full min-h-0 min-w-0 flex-col" aria-label={t(($) => $.work_overview.cockpit)}>
    <header className={cn("cockpit-masthead shrink-0 px-4 pt-3 lg:px-6", focusedWorkbench && "@max-[80rem]/cockpit-shell:pt-2")}>
      <div className={cn("cockpit-identity grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-3 pb-3 @min-[40rem]/cockpit-shell:grid-cols-[auto_minmax(0,1fr)_auto]", focusedWorkbench && "@max-[80rem]/cockpit-shell:hidden")}>
        <span className="cockpit-emblem" aria-hidden><span /><Layers3 className="size-4" /></span>
        <div className="min-w-0"><p className="cockpit-eyebrow text-micro">{t(($) => $.work_overview.cockpit)}</p>
          <h1 tabIndex={0} className="max-h-20 min-w-0 overflow-y-auto break-words text-title-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&>button]:max-w-full [&>button]:whitespace-normal [&>input]:max-w-full">{title ?? t(($) => $.shell.workspace_view)}</h1></div>
        {actions && <div className="col-span-2 row-start-2 flex min-w-0 max-w-full flex-wrap items-center gap-2 @min-[40rem]/cockpit-shell:col-span-1 @min-[40rem]/cockpit-shell:col-start-3 @min-[40rem]/cockpit-shell:row-start-1 @min-[40rem]/cockpit-shell:justify-end">{actions}</div>}
      </div>
      <div className="cockpit-command-row flex min-w-0 flex-col gap-2 pb-3 @min-[64rem]/cockpit-shell:flex-row @min-[64rem]/cockpit-shell:items-center @min-[64rem]/cockpit-shell:justify-between">
      <LayoutGroup id={motionId}><nav ref={navigationRef} aria-label={t(($) => $.shell.navigation)} className="cockpit-navigation flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain p-1">
        {navigation.map(({ value, label, Icon }) => <AppLink key={value} href={cockpitSurfacePath(paths.cockpit(), value, scope)}
          aria-current={surface === value ? "page" : undefined} title={label}
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "cockpit-nav-link relative isolate shrink-0 gap-2 rounded-lg px-3 whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", surface === value && "font-semibold") }>
          {surface === value && <motion.span aria-hidden className="cockpit-nav-active" layoutId="active-surface"
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 36 }} />}
          <Icon className="size-4" aria-hidden /><span>{label}</span>
          {value === "governance" && pendingChangeCount !== undefined && pendingChangeCount > 0 && <span className="cockpit-nav-badge rounded-full px-1.5 text-micro tabular-nums" title={t(($) => $.governance.pending)}>{pendingChangeCount}</span>}
        </AppLink>)}
      </nav></LayoutGroup>
      <div className={cn("cockpit-scope min-w-0 max-w-full @min-[64rem]/cockpit-shell:max-w-[26rem] @min-[64rem]/cockpit-shell:shrink-0 @min-[64rem]/cockpit-shell:[&_button]:max-w-44", focusedWorkbench && "@max-[80rem]/cockpit-shell:hidden")}>{scopeControl}</div>
      </div>
      {focusedWorkbench && <div className="min-w-0 border-t border-border py-2 text-caption text-muted-foreground @min-[80rem]/cockpit-shell:hidden" aria-label={t(($) => $.shell.scope)}>{scopeSummary}</div>}
    </header>
    {notice && <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-3 lg:px-6">{notice}</div>}
    {secondaryNavigation && <div className="cockpit-subnavigation min-w-0 shrink-0 px-4 lg:px-6">{secondaryNavigation}</div>}
    <div className="cockpit-content flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
  </section>;
}
