import { memo } from "react";
import type { OfficeTranslate } from "./office-i18n";
import type { Agent } from "@multica/core/types";
import {
  monologueMessage,
  type OfficeScene,
} from "@multica/core/office";
import { cn } from "@multica/ui/lib/utils";

// The right-hand rail: recent activity and tea-corner chatter. Both read the
// same scene the floor plan renders — there is exactly one source of truth per
// workspace visit. The token leaderboard is not here: it hangs on the office's
// north wall, where a leaderboard belongs.

export interface OfficeRailProps {
  scene: OfficeScene;
  agentById: ReadonlyMap<string, Agent>;
  t: OfficeTranslate;
  onAgentClick?: (agentId: string) => void;
}

function RailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-card/60 p-4">
      <h3 className="text-label font-semibold text-foreground">{title}</h3>
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

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <RailCard title={t("timeline.title")}>
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
    </div>
  );
});
