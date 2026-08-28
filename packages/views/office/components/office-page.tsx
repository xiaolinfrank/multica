"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useNavigation } from "../../navigation";
import {
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
  const live = useOfficeScene(wsId, phase);
  const demo = useMemo(() => buildDemoScene(phase), [phase]);
  const scene = isDemo ? demo.scene : live.scene;
  const presence = isDemo ? demo.presence : live.presence;
  const loading = isDemo ? false : live.loading;

  const agentById = useMemo(
    () => new Map(scene.agents.map((a) => [a.id, a])),
    [scene.agents],
  );

  const bubbleFor = useMemo(() => {
    return (agentId: string): string | null => {
      const zone = scene.floor.zoneByAgent.get(agentId);
      if (!zone) return null;
      const slot = pickMonologueSlot(agentId, zone, presence, phase);
      const msg = monologueMessage(slot);
      return tr(msg.key, msg.params);
    };
  }, [scene.floor.zoneByAgent, presence, phase, tr]);

  const onAgentClick = (agentId: string) => {
    navigation.push(paths.agentDetail(agentId));
  };

  const stats = useMemo(() => {
    let working = 0;
    let relaxing = 0;
    let absent = 0;
    for (const zone of scene.floor.zoneByAgent.values()) {
      if (zone === "desk" || zone === "waiting" || zone === "meeting") working += 1;
      else if (zone === "lounge" || zone === "tea" || zone === "canteen") relaxing += 1;
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
        <div className="grid min-h-0 flex-1 items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_320px]">
          <OfficeFloor
            scene={scene}
            phase={phase}
            agentById={agentById}
            t={tr}
            bubbleFor={bubbleFor}
            onAgentClick={onAgentClick}
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
