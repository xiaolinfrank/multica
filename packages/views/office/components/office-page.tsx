"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useAuthStore } from "@multica/core/auth";
import { api } from "@multica/core/api";
import { memberListOptions, workspaceKeys } from "@multica/core/workspace/queries";
import type { MemberWithUser } from "@multica/core/types";
import { useNavigation } from "../../navigation";
import {
  assignMemberSeat,
  memberActivityFromIssues,
  monologueMessage,
  OFFICE_PHASE_MS,
  pickMonologueSlot,
  useOfficeScene,
} from "@multica/core/office";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useT } from "../../i18n";
import { buildDemoScene } from "./office-demo";
import { OfficeFloor } from "./office-floor";
import type { OfficeTranslate } from "./office-i18n";
import { OfficeRail } from "./office-rail";
import { toOfficeMembers } from "./office-users";

// The Agent Office: one glanceable floor plan of who is working, who is
// resting and who is out, plus the activity rail, tea-corner chatter and
// the token leaderboard. Wall-clock phases rotate idle agents between the
// leisure corners so the room feels inhabited without any server state.

function useOfficePhase(): number {
  // Derived from the wall clock (not a counter) so remounts keep the same
  // seating and SSR/hydration stays consistent within one phase window.
  const [phase, setPhase] = useState(() => Math.floor(Date.now() / OFFICE_PHASE_MS));
  useEffect(() => {
    const id = setInterval(
      () => setPhase(Math.floor(Date.now() / OFFICE_PHASE_MS)),
      OFFICE_PHASE_MS,
    );
    return () => clearInterval(id);
  }, []);
  return phase;
}

export function OfficePage() {
  const { i18n } = useT("office");
  // All office copy goes through this one adapter — see office-i18n.ts for
  // why the namespace is dynamically keyed. Riding the provider instance's
  // `t` (with the ns option) keeps every call loose at compile time while
  // parity/monologue tests pin the bundle structure.
  // Keyed on the active language so the adapter keeps a stable identity
  // between renders — `bubbleFor` memoises on it — while still re-resolving
  // every string when the language changes. The i18n instance itself never
  // changes identity, so it cannot carry that signal on its own.
  const lang = i18n.language;
  const tr: OfficeTranslate = useCallback(
    (key, params) =>
      (i18n.t as (k: string, o?: Record<string, unknown>) => string)(key, {
        ...params,
        ns: "office",
        lng: lang,
      }),
    [i18n, lang],
  );
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const phase = useOfficePhase();
  // `?demo=1` renders a fully-staffed synthetic floor without touching the
  // API — used for visual development and screenshot verification.
  const isDemo = navigation.searchParams.get("demo") === "1";
  const live = useOfficeScene(isDemo ? undefined : wsId, phase);
  const demo = useMemo(() => buildDemoScene(phase), [phase]);
  const scene = isDemo ? demo.scene : live.scene;
  const presence = isDemo ? demo.presence : live.presence;
  const loading = isDemo ? false : live.loading;

  // Human members on the floor. The list polls gently: a status is exactly
  // the kind of thing a colleague changes while you are looking at them, and
  // there is no realtime event for profile fields — the office is the only
  // surface that wants push-freshness, so it refreshes on its own interval.
  const selfId = useAuthStore((s) => s.user?.id ?? "");
  const { data: members = [] } = useQuery({
    ...memberListOptions(wsId ?? ""),
    enabled: !!wsId && !isDemo,
    refetchInterval: 30_000,
  });
  const liveUsers = useMemo(() => toOfficeMembers(members, selfId), [members, selfId]);
// Human seating follows what each member actually has open: the pure
// classifier in core/office turns issue counts into a zone plus a
// monologue slot, so people mix into the agents' areas instead of a corner.
const { data: memberIssues = [] } = useQuery({
  queryKey: ["workspaces", wsId, "office", "member-issues"],
  queryFn: () =>
    api.listIssues({ workspace_id: wsId ?? "", assignee_types: ["member"], limit: 200 }).then((r) => r.issues),
  enabled: !!wsId && !isDemo,
  refetchInterval: 60_000,
});
const seatedLive = useMemo(() => {
  const activity = memberActivityFromIssues(
    liveUsers.map((u) => u.userId),
    memberIssues,
  );
  return liveUsers.map((u) => ({
    ...u,
    ...assignMemberSeat(
      activity.get(u.userId) ?? { userId: u.userId, inProgress: 0, open: 0, recentlyDone: 0 },
      phase,
    ),
  }));
}, [liveUsers, memberIssues, phase]);
  // Demo keeps its own local status so the editor is exercisable offline.
  const [demoStatus, setDemoStatus] = useState<string | null>(null);
  const users = useMemo(
    () =>
      isDemo
        ? demo.users.map((u, i) => (i === 0 && demoStatus !== null ? { ...u, status: demoStatus } : u))
        : seatedLive,
    [isDemo, demo.users, demoStatus, seatedLive],
  );

  const queryClient = useQueryClient();
  const statusMutation = useMutation({
    mutationFn: (status: string) => api.updateMe({ custom_status: status }),
    // The members list is a determinate cache and the viewer stays on this
    // screen — patch own row optimistically, roll back on failure.
    onMutate: async (status) => {
      if (!wsId) return;
      await queryClient.cancelQueries({ queryKey: workspaceKeys.members(wsId) });
      const prev = queryClient.getQueryData<MemberWithUser[]>(workspaceKeys.members(wsId));
      if (prev) {
        queryClient.setQueryData(
          workspaceKeys.members(wsId),
          prev.map((m) => (m.user_id === selfId ? { ...m, custom_status: status } : m)),
        );
      }
      return { prev };
    },
    onError: (_error, _status, ctx) => {
      if (wsId && ctx?.prev) {
        queryClient.setQueryData(workspaceKeys.members(wsId), ctx.prev);
      }
    },
  });
  const onUserStatusSave = useCallback(
    (status: string) => {
      if (isDemo) {
        setDemoStatus(status);
        return;
      }
      statusMutation.mutate(status);
    },
    [isDemo, statusMutation],
  );

  const agentById = useMemo(
    () => new Map(scene.agents.map((a) => [a.id, a])),
    [scene.agents],
  );

  /** Human monologue slots keyed by user id — bubbleFor checks these first. */
const humanSlots = useMemo(
  () => new Map(users.map((u) => [u.userId, u.monologue])),
  [users],
);
const bubbleFor = useMemo(() => {
    return (agentId: string): string | null => {
      const human = humanSlots.get(agentId);
    if (human) {
      const msg = monologueMessage(human);
      return tr(msg.key, msg.params);
    }
    const zone = scene.floor.zoneByAgent.get(agentId);
      if (!zone) return null;
      const slot = pickMonologueSlot(agentId, zone, presence, phase);
      const msg = monologueMessage(slot);
      return tr(msg.key, msg.params);
    };
  }, [humanSlots, scene.floor.zoneByAgent, presence, phase, tr]);

  const onAgentClick = (agentId: string) => {
    navigation.push(paths.agentDetail(agentId));
  };

  const stats = useMemo(() => {
    let working = 0;
    let relaxing = 0;
    let absent = 0;
    for (const zone of scene.floor.zoneByAgent.values()) {
      if (zone === "desk" || zone === "waiting" || zone === "meeting" || zone === "reception") working += 1;
      else if (zone === "lounge" || zone === "tea" || zone === "canteen" || zone === "gym") relaxing += 1;
      else absent += 1;
    }
    return { working, relaxing, absent, present: working + relaxing };
  }, [scene.floor.zoneByAgent]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 @container md:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold text-foreground">{tr("title")}</h1>
          <p className="text-caption text-muted-foreground">{tr("subtitle")}</p>
        </div>
        <dl className="flex gap-4 text-caption">
          {(
            [
              ["stats.present", stats.present],
              ["stats.working", stats.working],
              ["stats.relaxing", stats.relaxing],
              ["stats.absent", stats.absent],
            ] as const
          ).map(([key, value]) => (
            <div key={key} className="flex flex-col items-end">
              <dt className="text-micro text-muted-foreground">{tr(key)}</dt>
              <dd className="text-label font-semibold tabular-nums text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </header>

      {loading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <p className="text-caption text-muted-foreground">{tr("figure.loading")}</p>
        </div>
      ) : (
        // Two columns only once the container can give the scene a useful
        // width. Below that the rail would squeeze the drawing into a strip
        // and the row would take its height from the rail, letterboxing the
        // scene inside a column of dead space.
        //
        // The height mode switches with the layout. Side by side, `flex-1`
        // claims the leftover viewport height and the single 1fr row clamps
        // to it, so the stage gets a definite height and the rail scrolls
        // inside itself. Stacked, the grid must stay auto-height: `flex-1`
        // there would pin it to the viewport, the rail's cards would hold
        // the second row at its min-content height, and the aspect-ratio
        // stage would be squeezed into what was left and overflow on top of
        // the rail.
        <div className="grid gap-4 @5xl:min-h-0 @5xl:flex-1 @5xl:grid-cols-[minmax(0,1fr)_320px] @5xl:grid-rows-[minmax(0,1fr)]">
          <OfficeFloor
            scene={scene}
            phase={phase}
            agentById={agentById}
            t={tr}
            bubbleFor={bubbleFor}
            onAgentClick={onAgentClick}
            users={users}
            onUserStatusSave={onUserStatusSave}
          />
          <OfficeRail
            scene={scene}
            agentById={agentById}
            t={tr}
            onAgentClick={onAgentClick}
          />
        </div>
      )}
    </div>
  );
}
