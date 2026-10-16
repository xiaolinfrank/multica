"use client";

import { useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { applyCockpitSavedView, captureCockpitSavedView, cockpitSavedViewPath, cockpitContextOptions, cockpitChangePageOptions, cockpitShellDestination, cockpitSurfacePath, useUpdateCockpit } from "@multica/core/cockpit";
import { Button, buttonVariants } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { toast } from "sonner";
import { Presentation } from "lucide-react";
import { useT } from "../../i18n";
import { CockpitInputInspector } from "./cockpit-input-inspector";
import { CockpitShell } from "./cockpit-shell";
import { CockpitScopeControl } from "./cockpit-scope-control";
import { CockpitPlanViews } from "./cockpit-plan-views";
import { CockpitArtifacts } from "./cockpit-artifacts";
import { CockpitArtifactDetail } from "./cockpit-artifact-detail";
import { EditableText } from "./cockpit-fields";
import { AppLink, useNavigation } from "../../navigation";
import { CockpitBoardWorkspace } from "./cockpit-page";
import { CockpitWorkOverview } from "./cockpit-work-overview";
import { CockpitSavedViewsControl } from "./cockpit-saved-views";
import { CockpitChat } from "./cockpit-chat";
import { CockpitReport } from "./cockpit-report";

function calendarDay(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function subscribeCalendarDay(refresh: () => void) {
  const interval = window.setInterval(refresh, 60_000);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    window.clearInterval(interval);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}

// SSR must not guess the viewer's day from the server's timezone. The client
// snapshot also keeps long-lived desktop tabs current across local midnight.
const serverCalendarDay = () => "";

// One cockpit shell and URL-owned scope; each surface owns only its bounded reads.
export function CockpitPage() {
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const { t } = useT("cockpit");
  const destination = cockpitShellDestination(navigation.searchParams);
  const { scope, surface, planView } = destination;
  const today = useSyncExternalStore(subscribeCalendarDay, calendarDay, serverCalendarDay);
  const context = useQuery(cockpitContextOptions(wsId, scope));
  const update = useUpdateCockpit(wsId);
  const metadata = context.data;
  const isReport = navigation.searchParams.get("report") === "1";
  const returnParams = new URLSearchParams(navigation.searchParams); returnParams.delete("report");
  const returnHref = `${navigation.pathname}${returnParams.size ? `?${returnParams}` : ""}`;
  const reportParams = new URLSearchParams(returnParams); reportParams.set("report", "1");
  const reportHref = `${navigation.pathname}?${reportParams}`;
  const pendingChanges = useQuery({ ...cockpitChangePageOptions(wsId, scope, { status: "pending", page_size: 1 }), enabled: Boolean(metadata && !isReport) });
  const artifactId = navigation.searchParams.get("artifact");
  const focusedWorkbench = Boolean(metadata && ((surface === "meetings" && navigation.searchParams.get("meeting")) || (surface === "plan" && navigation.searchParams.get("node"))));
  const projectLabel = scope.projectId ? metadata?.scope.project_title || scope.projectId : t(($) => $.shell.all_projects);
  const moduleLabel = scope.moduleId ? metadata?.scope.module_title || scope.moduleId : "";
  const scopeLabel = [projectLabel, moduleLabel].filter(Boolean).join(" / ");
  const title = metadata?.cockpit ? <EditableText value={metadata.cockpit.title} disabled={!metadata.actor.is_human}
    onCommit={(value) => update.mutate({ title: value }, { onError: () => toast.error(t(($) => $.errors.save_failed)) })}
    label={t(($) => $.header.title)} placeholder={t(($) => $.header.title_placeholder)} displayClassName="text-title-sm font-semibold" /> : undefined;
  if (isReport && metadata && today) return <><CockpitInputInspector wsId={wsId} accountId={metadata.actor.user_id} /><CockpitReport wsId={wsId} scope={scope} asOf={today} returnHref={returnHref} /></>;
  return <><CockpitInputInspector wsId={wsId} accountId={metadata?.actor.user_id ?? ""} /><CockpitShell surface={surface} scope={scope} title={title} focusedWorkbench={focusedWorkbench}
    scopeSummary={<span className="block truncate" title={scopeLabel}>{scopeLabel}</span>} pendingChangeCount={pendingChanges.data?.counts.pending} artifactsAvailable={metadata?.capabilities?.artifacts === true}
    actions={metadata && <>{metadata.actor.is_human && surface !== "chat" && <CockpitSavedViewsControl wsId={wsId} userId={metadata.actor.user_id} capture={() => captureCockpitSavedView(wsId, navigation.searchParams)}
      onApply={(definition) => { applyCockpitSavedView(wsId, definition); navigation.push(cockpitSavedViewPath(navigation.pathname, definition)); }} />}
      <AppLink href={reportHref} className={buttonVariants({ variant: "outline", size: "sm" })}><Presentation className="size-4" />{t(($) => $.report.title)}</AppLink></>}
    scopeControl={<CockpitScopeControl wsId={wsId} scope={scope} projectTitle={metadata?.scope.project_title} moduleTitle={metadata?.scope.module_title} />}
    secondaryNavigation={surface === "plan" ? <CockpitPlanViews selected={planView} scope={scope} /> : undefined}
    notice={context.isError && metadata ? <div role="alert" className="flex flex-wrap items-center gap-2 text-caption">{t(($) => $.work_overview.refresh_failed)}<Button type="button" variant="outline" size="sm" onClick={() => void context.refetch()}>{t(($) => $.binding.retry)}</Button></div> : undefined}>
    {!today || context.isPending ? <div role="status" className="flex items-center gap-2 p-6 text-caption"><Spinner />{t(($) => $.work_overview.loading)}</div>
      : !metadata ? <div role="alert" className="space-y-4 p-6"><p className="text-body">{t(($) => $.shell.invalid_scope)}</p><div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void context.refetch()}>{t(($) => $.binding.retry)}</Button>
        <AppLink href={cockpitSurfacePath(navigation.pathname, surface)} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.shell.clear_scope)}</AppLink></div></div>
        : surface === "chat" ? <div className="cockpit-chat-studio flex min-h-0 min-w-0 flex-1 flex-col"><CockpitChat scope={scope} /></div>
          : surface === "work" ? <CockpitWorkOverview key={wsId} wsId={wsId} today={today} scope={scope} />
          : surface === "artifacts" ? metadata.capabilities?.artifacts !== true ? <div role="status" className="space-y-3 p-6 text-caption"><p>{t(($) => $.feature_availability.unavailable)}</p><AppLink href={cockpitSurfacePath(navigation.pathname, "plan", scope)} className={buttonVariants({ variant: "outline", size: "sm" })}>{t(($) => $.shell.plan)}</AppLink></div> : artifactId ? <CockpitArtifactDetail key={artifactId} wsId={wsId} artifactId={artifactId} versionId={navigation.searchParams.get("artifact_version")} scope={scope} currentUserId={metadata.actor.user_id} readOnly={!metadata.actor.is_human || context.isError} />
            : <CockpitArtifacts wsId={wsId} scope={scope} nodeId={navigation.searchParams.get("artifact_node") ?? undefined} />
          : <CockpitBoardWorkspace key={`${wsId}:${surface}`} initialTab={surface === "meetings" ? "meetings" : surface === "governance" ? "changes" : planView === "operations" ? "overview" : planView === "finance" ? "finance" : "gantt"}
            today={today} />}
  </CockpitShell></>;
}
