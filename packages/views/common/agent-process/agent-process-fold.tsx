"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@multica/ui/components/ui/collapsible";
import type { Attachment } from "@multica/core/types";
import type { TimelineItem } from "../task-transcript";
import { FOLLOW_EDGE_THRESHOLD } from "../task-transcript/transcript-follow";
import { RichContent } from "../../rich-content";
import { ProcessItemRow } from "./process-item-rows";
import { useT } from "../../i18n";

// The "N steps" fold that holds an agent run's process — tool calls, thinking,
// and the intermediate text sandwiched between them.
//
// Open while the run streams so the user watches progress; collapsed the
// moment it settles, leaving the result to stand on its own. The fold header
// stays put either way, so the process is always one click from view.
//
// Auto-collapse is expressed here rather than falling out of a remount: both
// callers keep this row mounted across the live → persisted handoff (chat so
// Mermaid/HTML blocks survive it, the issue page so the scroll position does),
// which means nothing would reset the state on its own (MUL-4922).

export interface AgentProcessFoldProps {
  items: TimelineItem[];
  /** True while the run is still producing events. */
  isStreaming?: boolean;
  /** Attachments referenced by intermediate text blocks, when the caller has them. */
  attachments?: Attachment[];
  /** `streaming` tells RichContent a trailing markdown fence may be half-written. */
  phase?: "streaming" | "settled";
  /**
   * Controlled open state. Pass both to own it — the issue page does, because
   * opening the fold is what triggers its lazy transcript fetch, so the parent
   * has to know. Omit both for the uncontrolled auto-open/auto-collapse
   * behaviour chat relies on.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /**
   * Trigger copy to use instead of the step count. The lazy caller has no
   * count to show before its first fetch, and "0 steps" would be a lie.
   */
  triggerLabel?: string;
  /** Rendered inside the trigger, after the label (e.g. a live pulse). */
  triggerSuffix?: React.ReactNode;
  /**
   * Keep the newest row in view as output appends. Only honoured when the
   * caller also bounds the content box — an unbounded fold has nothing to
   * scroll, and the page would jump instead.
   */
  followOutput?: boolean;
  /** Rendered inside the open fold, above the rows (e.g. a loading hint). */
  children?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  contentStyle?: React.CSSProperties;
}

export function AgentProcessFold({
  items,
  isStreaming,
  attachments,
  phase = "settled",
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  triggerLabel,
  triggerSuffix,
  followOutput,
  children,
  className,
  contentClassName,
  contentStyle,
}: AgentProcessFoldProps) {
  const { t } = useT("common");
  const [uncontrolledOpen, setUncontrolledOpen] = useState(!!isStreaming);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = controlledOnOpenChange ?? setUncontrolledOpen;

  // Auto-collapse on the streaming → settled edge. Controlled callers get the
  // same edge reported through onOpenChange so their state follows too, rather
  // than the fold silently disagreeing with the parent that owns it.
  const wasStreaming = useRef(!!isStreaming);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) setOpen(false);
    wasStreaming.current = !!isStreaming;
  }, [isStreaming, setOpen]);

  // Stick to the newest row while the reader is at (or near) the bottom, and
  // stop the moment they scroll up to read something. Same edge threshold the
  // chat list and the transcript dialog follow by, so "near enough to the
  // bottom" means one thing across every live surface.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stuckToBottom = useRef(true);
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stuckToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_EDGE_THRESHOLD;
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!followOutput || !open || !el || !stuckToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [followOutput, items, open]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className}>
      <CollapsibleTrigger className="flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground transition-colors">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span>{triggerLabel ?? t(($) => $.agent_process.steps, { count: items.length })}</span>
        {triggerSuffix}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          ref={scrollRef}
          onScroll={followOutput ? handleScroll : undefined}
          style={contentStyle}
          className={cn(
            "mt-1 rounded-lg border bg-muted/20 p-2 space-y-0.5",
            contentClassName,
          )}
        >
          {children}
          {items.map((item) =>
            item.type === "text" ? (
              <ProcessTextRow
                key={item.seq}
                item={item}
                attachments={attachments}
                phase={phase}
              />
            ) : (
              <ProcessItemRow key={item.seq} item={item} />
            ),
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// Intermediate text segment rendered inside the fold. Visually down-shifted
// (caption / muted) so it reads as part of the agent's process, not the final
// answer — the answer renders outside the fold at full prose size.
function ProcessTextRow({
  item,
  attachments,
  phase = "settled",
  className,
}: {
  item: TimelineItem;
  attachments?: Attachment[];
  phase?: "streaming" | "settled";
  className?: string;
}) {
  return (
    <div className={cn("py-0.5 text-caption text-muted-foreground", className)}>
      <RichContent
        content={item.content ?? ""}
        attachments={attachments}
        density="compact"
        phase={phase}
      />
    </div>
  );
}
