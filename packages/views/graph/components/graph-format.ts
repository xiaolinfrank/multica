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
