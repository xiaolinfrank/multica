import { memo } from "react";
import type { Agent } from "@multica/core/types";
import { resolvePublicFileUrl } from "@multica/core/workspace/avatar-url";
import type { OfficeZoneId } from "@multica/core/office";
import { cn } from "@multica/ui/lib/utils";

// One anthropomorphic agent on the office floor: avatar head on a capsule
// body, a zone-specific prop, and the occasional thought bubble. Props are
// decorative (emoji) — the person itself stays an avatar + CSS body so the
// page carries no image assets and keeps the semantic-token palette.

interface FigureLook {
  bodyClass: string;
  prop: string;
  bob: boolean;
  dim: boolean;
}

const LOOKS: Record<OfficeZoneId, FigureLook> = {
  desk: { bodyClass: "bg-brand/15 border-brand/50", prop: "🖥️", bob: true, dim: false },
  meeting: { bodyClass: "bg-primary/10 border-primary/40", prop: "📋", bob: false, dim: false },
  waiting: { bodyClass: "bg-warning/10 border-warning/50", prop: "⏳", bob: false, dim: false },
  lounge: { bodyClass: "bg-muted border-muted-foreground/30", prop: "💤", bob: false, dim: false },
  tea: { bodyClass: "bg-muted border-muted-foreground/30", prop: "☕", bob: false, dim: false },
  canteen: { bodyClass: "bg-muted border-muted-foreground/30", prop: "🍱", bob: false, dim: false },
  absent: { bodyClass: "bg-muted border-muted-foreground/20", prop: "🌙", bob: false, dim: true },
};

export interface OfficeAgentFigureProps {
  agent: Agent;
  zone: OfficeZoneId;
  /** Thought-bubble line; null renders no bubble. */
  bubble?: string | null;
  /** Small caption under the name, e.g. "2 running". */
  caption?: string | null;
  onClick?: () => void;
  className?: string;
}

function FigureHead({ agent, dim }: { agent: Agent; dim: boolean }) {
  const url = agent.avatar_url ? resolvePublicFileUrl(agent.avatar_url) : null;
  const initial = (agent.name || "?").trim().charAt(0).toUpperCase();
  return (
    <span
      className={cn(
        "flex size-10 items-center justify-center overflow-hidden rounded-full border bg-muted text-body font-semibold text-muted-foreground select-none",
        dim && "opacity-50 grayscale",
      )}
      aria-hidden="true"
    >
      {url ? (
        // Agent avatars are workspace uploads; a broken URL degrades to the
        // initial via onError swapping to the text branch.
        <img
          src={url}
          alt=""
          className="size-full object-cover"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : null}
      <span className={url ? "hidden" : undefined}>{initial}</span>
    </span>
  );
}

export const OfficeAgentFigure = memo(function OfficeAgentFigure({
  agent,
  zone,
  bubble,
  caption,
  onClick,
  className,
}: OfficeAgentFigureProps) {
  const look = LOOKS[zone];
  return (
    <div
      className={cn(
        "group relative flex w-24 shrink-0 flex-col items-center gap-1 rounded-lg p-2 text-center",
        onClick && "cursor-pointer hover:bg-muted/60",
        className,
      )}
      onClick={onClick}
    >
      {bubble ? (
        <span
          className="office-bubble pointer-events-none absolute -top-1 left-1/2 z-10 max-w-44 -translate-x-1/2 rounded-xl border bg-popover px-2 py-1 text-caption text-popover-foreground shadow-sm"
          title={bubble}
        >
          {bubble}
        </span>
      ) : null}
      <div className={cn("flex flex-col items-center", look.bob && "office-bob")}>
        <FigureHead agent={agent} dim={look.dim} />
        <span
          className={cn(
            "-mt-1 flex h-8 w-14 items-start justify-center rounded-t-full border-b-0 pt-1 text-caption",
            look.bodyClass,
            look.dim && "opacity-50",
          )}
          aria-hidden="true"
        >
          <span className="office-steam-hidden">{look.prop}</span>
        </span>
      </div>
      <span className="w-full truncate text-caption font-medium text-foreground" title={agent.name}>
        {agent.name}
      </span>
      {caption ? <span className="text-caption text-muted-foreground">{caption}</span> : null}
    </div>
  );
});
