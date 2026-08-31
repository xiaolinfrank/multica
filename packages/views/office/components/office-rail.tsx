import { memo } from "react";
import type { OfficeTranslate } from "./office-i18n";
import type { Agent } from "@multica/core/types";
import {
  monologueMessage,
  type OfficeScene,
} from "@multica/core/office";
import { cn } from "@multica/ui/lib/utils";
import { agentAvatarUrl } from "./office-users";

// The right-hand rail: recent activity, tea-corner chatter, and who is out.
// All three read the same scene the floor plan renders — there is exactly one
// source of truth per workspace visit. The token leaderboard is not here: it
// hangs on the office's north wall, where a leaderboard belongs.
//
// Out-of-office belongs here rather than under the floor. Absent agents are
// the one part of the cast the scene cannot draw, and a full-width strip of
// chips below the room read as an orphaned footer while the rail beside it
// ran out of content half way down the page.

export interface OfficeRailProps {
  scene: OfficeScene;
  agentById: ReadonlyMap<string, Agent>;
  t: OfficeTranslate;
  onAgentClick?: (agentId: string) => void;
}

function RailCard({
  title,
  count,
  className,
  children,
}: {
  title: string;
  /** Shown beside the heading when the card is a roll-call rather than a feed. */
  count?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("flex shrink-0 flex-col gap-2 rounded-xl border bg-card/60 p-4", className)}>
      <h3 className="text-label font-semibold text-foreground">
        {title}
        {count === undefined ? null : (
          <span className="ml-1.5 tabular-nums font-normal text-muted-foreground">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}

function agentName(agentById: ReadonlyMap<string, Agent>, id: string): string {
  return agentById.get(id)?.name ?? "…";
}

export const OfficeRail = memo(function OfficeRail({
  scene,
  agentById,
  t,
  onAgentClick,
}: OfficeRailProps) {
  const { timeline, chatter } = scene;
  const absent = scene.floor.absent;

  return (
    // Beside the floor (@5xl) the rail is a single column that owns a
    // fixed-height grid row and scrolls inside itself. Stacked under the
    // floor it is as wide as the page, so it breaks into two columns and
    // lets the page scroll: one full-width column would strand each activity
    // row's timestamp an inch of empty card away from its name, and
    // scrolling here would clip the first card off the top.
    <div className="grid min-w-0 content-start items-start gap-4 @2xl:grid-cols-2 @5xl:flex @5xl:min-h-0 @5xl:flex-col @5xl:items-stretch @5xl:overflow-y-auto">
      <RailCard title={t("timeline.title")} className="@2xl:row-span-2">
        {timeline.length === 0 ? (
          <p className="text-caption text-muted-foreground">{t("timeline.empty")}</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {timeline.map((e) => (
              <li
                key={e.taskId}
                className="flex items-center gap-2 text-caption"
              >
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    e.kind === "completed" && "bg-success",
                    e.kind === "running" && "bg-brand animate-pulse",
                    e.kind === "failed" && "bg-destructive",
                  )}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  className="min-w-0 truncate font-medium text-foreground hover:underline"
                  onClick={onAgentClick ? () => onAgentClick(e.agentId) : undefined}
                  title={agentName(agentById, e.agentId)}
                >
                  {agentName(agentById, e.agentId)}
                </button>
                <span className="shrink-0 text-muted-foreground">{t(`timeline.${e.kind}`)}</span>
                <time className="ml-auto shrink-0 text-micro text-faint-foreground">
                  {e.at ? new Date(e.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : ""}
                </time>
              </li>
            ))}
          </ol>
        )}
      </RailCard>

      <RailCard title={t("chatter.title")}>
        {chatter ? (
          <div className="flex flex-col gap-1.5">
            {chatter.lines.map((line, i) => {
              const isA = line.speakerAgentId === chatter.aAgentId;
              const msg = monologueMessage(line.slot);
              return (
                <div
                  key={`${line.speakerAgentId}-${i}`}
                  className={cn("flex", isA ? "justify-start" : "justify-end")}
                >
                  <p
                    className={cn(
                      "max-w-[85%] rounded-xl border px-2 py-1 text-caption",
                      isA
                        ? "rounded-bl-sm bg-background text-foreground"
                        : "rounded-br-sm bg-muted/60 text-foreground",
                    )}
                  >
                    <span className="font-medium">{agentName(agentById, line.speakerAgentId)}: </span>
                    {t(msg.key, msg.params)}
                  </p>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-caption text-muted-foreground">{t("timeline.empty")}</p>
        )}
      </RailCard>

      {absent.length > 0 ? (
        <RailCard title={t("zones.absent.name")} count={absent.length}>
          <ul className="flex flex-col gap-1.5">
            {absent.map((a) => {
              const agent = agentById.get(a.agentId);
              if (!agent) return null;
              const avatar = agentAvatarUrl(agent);
              return (
                <li key={a.agentId} className="flex items-center gap-2 text-caption">
                  <span className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-micro text-muted-foreground">
                    {avatar ? (
                      <img src={avatar} alt="" className="size-full object-cover opacity-60 grayscale" />
                    ) : (
                      (agent.name || "?").trim().charAt(0).toUpperCase()
                    )}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground" title={agent.name}>
                    {agent.name}
                  </span>
                  <span className="ml-auto shrink-0 text-micro text-faint-foreground">
                    {t(`zones.absent.${a.reason}`)}
                  </span>
                </li>
              );
            })}
          </ul>
        </RailCard>
      ) : null}
    </div>
  );
});
