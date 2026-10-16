"use client";

import { useEffect, useRef } from "react";
import { cockpitSurfacePath, type CockpitPlanView, type CockpitScope } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { buttonVariants } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { ChartNoAxesGantt, Table2, Users, Flag, Wallet, ChartNoAxesCombined, type LucideIcon } from "lucide-react";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export function CockpitPlanViews({ selected, scope }: { selected: CockpitPlanView; scope: CockpitScope }) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const navigationRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navigationRef.current?.querySelector<HTMLAnchorElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);
  const views: Array<{ value: CockpitPlanView; label: string; icon: LucideIcon }> = [
    { value: "gantt", icon: ChartNoAxesGantt, label: t(($) => $.tabs.gantt) },
    { value: "table", icon: Table2, label: t(($) => $.plan_views.table) },
    { value: "responsibility", icon: Users, label: t(($) => $.plan_views.responsibility) },
    { value: "milestones", icon: Flag, label: t(($) => $.plan_views.milestones) },
    { value: "finance", icon: Wallet, label: t(($) => $.plan_views.finance) },
    { value: "operations", icon: ChartNoAxesCombined, label: t(($) => $.work_overview.operations) },
  ];
  return <nav ref={navigationRef} aria-label={t(($) => $.plan_views.navigation)} className="cockpit-plan-navigation flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain py-1">
    {views.map((view) => <AppLink key={view.value} href={cockpitSurfacePath(paths.cockpit(), "plan", scope, view.value)} aria-current={selected === view.value ? "page" : undefined} title={view.label}
      className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "cockpit-plan-link shrink-0 gap-2 rounded-none border-b-2 border-transparent px-3 whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", selected === view.value && "border-brand font-semibold")}><view.icon className="size-3.5" aria-hidden />{view.label}</AppLink>)}
  </nav>;
}
