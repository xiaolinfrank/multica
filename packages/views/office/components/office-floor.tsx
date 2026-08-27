import { memo } from "react";
import type { OfficeTranslate } from "./office-i18n";
import type { Agent } from "@multica/core/types";
import type { OfficeScene } from "@multica/core/office";
import { cn } from "@multica/ui/lib/utils";
import { OfficeAgentFigure } from "./office-agent-figure";

// The floor plan proper: desks, squad meeting rooms, the three leisure
// corners, the waiting bench and the out-of-office strip. Layout is a
// responsive grid of "rooms"; each room keeps its own header + empty state
// so an empty cafeteria never looks like a broken cafeteria.

export interface OfficeFloorProps {
  scene: OfficeScene;
  agentById: ReadonlyMap<string, Agent>;
  t: OfficeTranslate;
  /** Resolves the thought bubble for an agent, or null for none. */
  bubbleFor: (agentId: string) => string | null;
  onAgentClick?: (agentId: string) => void;
}

function Room({
  title,
  hint,
  count,
  className,
  children,
}: {
  title: string;
  hint?: string;
  count: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-h-40 flex-col gap-3 rounded-xl border bg-card/60 p-4",
        className,
      )}
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-label font-semibold text-foreground">{title}</h3>
        <span className="text-caption text-muted-foreground">{count > 0 ? count : ""}</span>
      </header>
      {count === 0 ? (
        <p className="m-auto text-caption text-muted-foreground">{hint}</p>
      ) : (
        children
      )}
    </section>
  );
}

function figureProps(
  agentId: string,
  zone: Parameters<typeof OfficeAgentFigure>[0]["zone"],
  agentById: ReadonlyMap<string, Agent>,
  bubbleFor: (id: string) => string | null,
  onAgentClick?: (id: string) => void,
) {
  const agent = agentById.get(agentId);
  if (!agent) return null;
  return (
    <OfficeAgentFigure
      key={agentId}
      agent={agent}
      zone={zone}
      bubble={bubbleFor(agentId)}
      onClick={onAgentClick ? () => onAgentClick(agentId) : undefined}
    />
  );
}

export const OfficeFloor = memo(function OfficeFloor({
  scene,
  agentById,
  t,
  bubbleFor,
  onAgentClick,
}: OfficeFloorProps) {
  const { floor } = scene;
  const fp = (id: string, zone: Parameters<typeof OfficeAgentFigure>[0]["zone"]) =>
    figureProps(id, zone, agentById, bubbleFor, onAgentClick);

  return (
    <div className="flex flex-col gap-4">
      {/* Desks — the main working area, full width on top. */}
      <Room
        title={t("zones.desk.name")}
        hint={t("zones.desk.empty")}
        count={floor.desks.length}
      >
        <div className="flex flex-wrap gap-2">
          {floor.desks.map((d) => {
            const node = fp(d.agentId, "desk");
            if (!node) return null;
            return (
              <div
                key={d.agentId}
                className="flex flex-col items-center rounded-xl border bg-background/60 p-2"
              >
                {node}
                <span className="mt-1 rounded-md border bg-background px-1.5 py-0.5 text-micro text-muted-foreground">
                  {t("figure.running")} {d.runningCount}/{d.capacity}
                </span>
              </div>
            );
          })}
        </div>
      </Room>

      {/* Squad meeting rooms — one card per squad with work in flight. */}
      <Room
        title={t("zones.meeting.name")}
        hint={t("zones.meeting.empty")}
        count={floor.meetings.length}
      >
        <div className="grid gap-3 @container md:grid-cols-2">
          {floor.meetings.map((m) => (
            <div
              key={m.squadId}
              className="flex flex-col gap-2 rounded-xl border border-dashed bg-primary/5 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-label font-medium text-foreground" title={m.squadName}>
                  {m.squadName}
                </span>
                {m.supportingAgentIds.length > 0 ? (
                  <span className="shrink-0 text-micro text-muted-foreground">
                    {t("zones.meeting.supporting", { count: m.supportingAgentIds.length })}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1">
                {m.attendeeAgentIds.map((id) => fp(id, "meeting"))}
                {m.supportingAgentIds.map((id) => {
                  const agent = agentById.get(id);
                  if (!agent) return null;
                  const url = agent.avatar_url;
                  const initial = (agent.name || "?").trim().charAt(0).toUpperCase();
                  return (
                    <span
                      key={id}
                      className="flex size-7 items-center justify-center overflow-hidden rounded-full border bg-muted text-micro text-muted-foreground"
                      title={agent.name}
                    >
                      {url ? (
                        <img src={url} alt="" className="size-full object-cover" />
                      ) : (
                        initial
                      )}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </Room>

      {/* Leisure row: lounge / tea corner / canteen share one band. */}
      <div className="grid gap-4 md:grid-cols-3">
        {(
          [
            ["lounge", floor.lounge],
            ["tea", floor.tea],
            ["canteen", floor.canteen],
          ] as const
        ).map(([zone, ids]) => (
          <Room
            key={zone}
            title={t(`zones.${zone}.name`)}
            hint={t(`zones.${zone}.empty`)}
            count={ids.length}
          >
            <div className="flex flex-wrap justify-center gap-1">
              {ids.map((id) => fp(id, zone))}
            </div>
          </Room>
        ))}
      </div>

      {/* Waiting bench + out-of-office strip, compact. */}
      <div className="grid gap-4 md:grid-cols-2">
        <Room
          title={t("zones.waiting.name")}
          hint={t("zones.waiting.hint")}
          count={floor.waiting.length}
        >
          <div className="flex flex-wrap gap-1">
            {floor.waiting.map((id) => fp(id, "waiting"))}
          </div>
        </Room>
        <Room
          title={t("zones.absent.name")}
          count={floor.absent.length}
          hint=""
        >
          <div className="flex flex-wrap gap-2">
            {floor.absent.map((a) => {
              const agent = agentById.get(a.agentId);
              if (!agent) return null;
              return (
                <span
                  key={a.agentId}
                  className="flex items-center gap-1.5 rounded-full border bg-muted/40 py-1 pl-1 pr-2.5 text-caption text-muted-foreground"
                >
                  <span className="flex size-6 items-center justify-center overflow-hidden rounded-full bg-muted text-micro">
                    {agent.avatar_url ? (
                      <img src={agent.avatar_url} alt="" className="size-full object-cover opacity-60 grayscale" />
                    ) : (
                      (agent.name || "?").trim().charAt(0).toUpperCase()
                    )}
                  </span>
                  <span className="max-w-28 truncate" title={agent.name}>{agent.name}</span>
                  <span>·</span>
                  <span>{t(`zones.absent.${a.reason}`)}</span>
                </span>
              );
            })}
            {floor.absent.length === 0 ? (
              <p className="text-caption text-muted-foreground">{t("stats.absent")}: 0</p>
            ) : null}
          </div>
        </Room>
      </div>
    </div>
  );
});
