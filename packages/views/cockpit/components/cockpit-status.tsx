"use client";

// Status and execution-status chips.
//
// The board's status values are the programme's own free text, not a server
// enum, so the colour is chosen by matching the words a board actually uses and
// falling back to neutral. A status nobody here knows still renders — as a plain
// chip with its own label, which is the honest answer.

import { cn } from "@multica/ui/lib/utils";

type ChipTone = "done" | "active" | "blocked" | "cancelled" | "neutral";

const TONE_CLASS: Record<ChipTone, string> = {
  done: "border-success/30 bg-success/10 text-success",
  active: "border-warning/30 bg-warning/10 text-warning",
  blocked: "border-destructive/30 bg-destructive/10 text-destructive",
  cancelled: "border-border bg-muted text-muted-foreground line-through",
  neutral: "border-border bg-muted text-muted-foreground",
};

const TONE_BY_STATUS = new Map<string, ChipTone>([
  ["已完成", "done"],
  ["完成", "done"],
  ["done", "done"],
  ["completed", "done"],
  ["进行中", "active"],
  ["执行中", "active"],
  ["in progress", "active"],
  ["in_progress", "active"],
  ["审查中", "active"],
  ["受阻", "blocked"],
  ["阻塞", "blocked"],
  ["blocked", "blocked"],
  ["已取消", "cancelled"],
  ["取消", "cancelled"],
  ["cancelled", "cancelled"],
]);

export function statusTone(status: string): ChipTone {
  const key = status.trim();
  return TONE_BY_STATUS.get(key) ?? TONE_BY_STATUS.get(key.toLowerCase()) ?? "neutral";
}

export function StatusChip({ status, className }: { status: string; className?: string }) {
  if (!status.trim()) {
    return <span className={cn("text-caption text-muted-foreground italic", className)}>—</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-px text-micro whitespace-nowrap",
        TONE_CLASS[statusTone(status)],
        className,
      )}
    >
      {status}
    </span>
  );
}

const EXEC_TONE = new Map<string, ChipTone>([
  ["完全支付", "done"],
  ["合同已定", "active"],
  ["未支付", "neutral"],
  ["规划中", "neutral"],
]);

export function ExecStatusChip({ status, className }: { status: string; className?: string }) {
  if (!status.trim()) return null;
  const tone = EXEC_TONE.get(status.trim()) ?? "neutral";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-1.5 py-px text-micro whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
    >
      {status}
    </span>
  );
}
