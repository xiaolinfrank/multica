"use client";

import { cockpitSurfacePath, type CockpitScope, type CockpitSurface } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { buttonVariants } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { CalendarDays, ChartNoAxesGantt, Files, LayoutDashboard, Layers3, MessageSquare, ShieldCheck } from "lucide-react";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export function CockpitShell({ surface, scope, title, scopeControl, secondaryNavigation, actions, notice, pendingChangeCount, artifactsAvailable = false, focusedMeeting = false, scopeSummary, children }: {
  surface: CockpitSurface;
  scope: CockpitScope;
  title?: React.ReactNode;
  scopeControl: React.ReactNode;
  secondaryNavigation?: React.ReactNode;
  actions?: React.ReactNode;
  notice?: React.ReactNode;
  pendingChangeCount?: number;
  artifactsAvailable?: boolean;
  focusedMeeting?: boolean;
  scopeSummary?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const navigation = [
    { value: "chat" as const, label: t(($) => $.shell.chat), Icon: MessageSquare },
    { value: "work" as const, label: t(($) => $.shell.overview), Icon: LayoutDashboard },
    { value: "plan" as const, label: t(($) => $.shell.plan), Icon: ChartNoAxesGantt },
    { value: "meetings" as const, label: t(($) => $.shell.meetings), Icon: CalendarDays },
    ...(artifactsAvailable ? [{ value: "artifacts" as const, label: t(($) => $.shell.artifacts), Icon: Files }] : []),
    { value: "governance" as const, label: t(($) => $.shell.governance), Icon: ShieldCheck },
  ];
  return <section className="cockpit-skin flex h-full min-h-0 min-w-0 flex-col" aria-label={t(($) => $.work_overview.cockpit)}>
    <header className={cn("shrink-0 border-b border-border bg-card/90 px-4 pt-4 lg:px-6", focusedMeeting && "max-xl:pt-2")}>
      <div className={cn("grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 pb-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]", focusedMeeting && "max-xl:hidden")}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand"><Layers3 className="size-4" aria-hidden /></span>
        <div className="min-w-0 flex-1"><p className="text-micro text-muted-foreground">{t(($) => $.work_overview.cockpit)}</p>
          <div className="min-w-0 break-words text-title-sm font-semibold [&>button]:max-w-full [&>input]:max-w-full">{title ?? t(($) => $.shell.workspace_view)}</div></div>
        {actions && <div className="col-span-2 flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:col-span-1 sm:justify-end">{actions}</div>}
      </div>
      <nav aria-label={t(($) => $.shell.navigation)} className={cn("flex min-w-0 flex-wrap gap-1 pb-3", focusedMeeting && "max-xl:pb-2")}>
        {navigation.map(({ value, label, Icon }) => <AppLink key={value} href={cockpitSurfacePath(paths.cockpit(), value, scope)}
          aria-current={surface === value ? "page" : undefined}
          className={cn(buttonVariants({ variant: surface === value ? "brandSubtle" : "ghost", size: "sm" }), "gap-2 rounded-lg px-3") }>
          <Icon className="size-4" aria-hidden />{label}
          {value === "governance" && pendingChangeCount !== undefined && pendingChangeCount > 0 && <span className="rounded-full bg-brand/10 px-1.5 text-micro tabular-nums text-brand" title={t(($) => $.governance.pending)}>{pendingChangeCount}</span>}
        </AppLink>)}
      </nav>
      <div className={cn("flex min-w-0 flex-wrap items-center gap-3 border-t border-border/70 py-3", focusedMeeting && "max-xl:hidden")}>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{scopeControl}</div>
        {secondaryNavigation && <div className="flex min-w-0 max-w-full basis-full flex-wrap gap-1 sm:flex-1 sm:basis-0 sm:justify-end">{secondaryNavigation}</div>}
      </div>
      {focusedMeeting && <div className="min-w-0 border-t border-border/70 py-2 text-caption text-muted-foreground xl:hidden" aria-label={t(($) => $.shell.scope)}>{scopeSummary}</div>}
    </header>
    {notice && <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-3 lg:px-6">{notice}</div>}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
  </section>;
}
