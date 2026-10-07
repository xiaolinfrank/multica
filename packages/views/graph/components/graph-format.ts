// Presentational helpers shared by the graph page and canvas: status dot
// classes (Tailwind semantic tokens, same mapping the legend uses) and the
// compact timestamp format both the hover tooltip and the node card show.

const STATUS_DOT_CLASSES: Record<string, string> = {
  backlog: "bg-muted-foreground",
  todo: "bg-muted-foreground",
  in_progress: "bg-warning",
  in_review: "bg-success",
  done: "bg-info",
  blocked: "bg-destructive",
  cancelled: "bg-muted-foreground",
};

export function statusDotClass(statusCategory: string): string {
  return STATUS_DOT_CLASSES[statusCategory] ?? "bg-muted-foreground";
}

/** "Aug 29 14:32" for an ISO timestamp; "" when absent or unparseable. */
export function formatGraphTimestamp(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

const RUN_STATUS_DOT_CLASSES: Record<string, string> = {
  queued: "bg-muted-foreground",
  dispatched: "bg-warning",
  running: "bg-warning",
  completed: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-muted-foreground",
};

/** Dot class for an execution node's run status (the run status semantics
 *  mirror the canvas's RUN_STATUS_VARS token mapping). */
export function runStatusDotClass(status: string): string {
  return RUN_STATUS_DOT_CLASSES[status] ?? "bg-muted-foreground";
}

/** Compact "3m 12s"-style duration between two ISO timestamps; "" when either
 *  is absent/unparseable or the run has not ended. */
export function formatRunDuration(startedAt: string, completedAt: string): string {
  if (!startedAt || !completedAt) return "";
  const start = new Date(startedAt).getTime();
  const end = new Date(completedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
  const totalSeconds = Math.round((end - start) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
