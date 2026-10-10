"use client";

import { cockpitSurfacePath, type CockpitPlanView, type CockpitScope } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { buttonVariants } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export function CockpitPlanViews({ selected, scope }: { selected: CockpitPlanView; scope: CockpitScope }) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const views: Array<{ value: CockpitPlanView; label: string }> = [
    { value: "gantt", label: t(($) => $.tabs.gantt) },
    { value: "table", label: t(($) => $.plan_views.table) },
    { value: "responsibility", label: t(($) => $.plan_views.responsibility) },
    { value: "milestones", label: t(($) => $.plan_views.milestones) },
    { value: "finance", label: t(($) => $.plan_views.finance) },
    { value: "operations", label: t(($) => $.work_overview.operations) },
  ];
  return <nav aria-label={t(($) => $.plan_views.navigation)} className="flex min-w-0 flex-wrap gap-1">
    {views.map((view) => <AppLink key={view.value} href={cockpitSurfacePath(paths.cockpit(), "plan", scope, view.value)} aria-current={selected === view.value ? "page" : undefined}
      className={cn(buttonVariants({ variant: selected === view.value ? "secondary" : "ghost", size: "sm" }), "rounded-md")}>{view.label}</AppLink>)}
  </nav>;
}
