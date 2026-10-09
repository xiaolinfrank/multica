"use client";

import { useSyncExternalStore } from "react";
import { useWorkspaceId } from "@multica/core/hooks";
import { cockpitAreaPath, cockpitDestination, type CockpitArea } from "@multica/core/cockpit";
import { useNavigation } from "../../navigation";
import { CockpitBoardWorkspace } from "./cockpit-page";
import { CockpitWorkOverview } from "./cockpit-work-overview";

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

// The entry point mounts one surface. Home never mounts the complete board,
// contacts, module catalog or workflow history just to display summary cards.
export function CockpitPage() {
  const wsId = useWorkspaceId();
  const navigation = useNavigation();
  const destination = cockpitDestination(navigation.searchParams);
  const today = useSyncExternalStore(subscribeCalendarDay, calendarDay, serverCalendarDay);
  const openArea = (area: CockpitArea) => navigation.push(cockpitAreaPath(navigation.pathname, area));
  if (!today) return <div className="h-full min-h-0 bg-background" aria-busy="true" />;
  if (destination.area === "work") {
    return <CockpitWorkOverview key={wsId} wsId={wsId} today={today} onOpenArea={openArea} />;
  }
  return <CockpitBoardWorkspace key={`${wsId}:${destination.key}`} initialTab={destination.boardTab} today={today}
    onWorkOverview={() => openArea("work")} onSelectTab={(tab) => openArea(tab === "overview" ? "work" : tab)} />;
}
