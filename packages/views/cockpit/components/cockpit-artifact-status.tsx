"use client";

import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";

export function useArtifactStatusLabel() {
  const { t } = useT("cockpit");
  const labels: Record<string, string> = {
    draft: t(($) => $.artifacts.draft), capturing: t(($) => $.artifacts.capturing), pending: t(($) => $.workflow.pending_review),
    approved: t(($) => $.workflow.approved), changes_requested: t(($) => $.workflow.changes_requested), rejected: t(($) => $.workflow.rejected),
    archived: t(($) => $.artifacts.archived), needs_attention: t(($) => $.nas.needs_attention), queued: t(($) => $.nas.queued),
    running: t(($) => $.nas.running), retry_wait: t(($) => $.nas.retry_wait), ready: t(($) => $.artifacts.fixed), not_requested: t(($) => $.artifacts.waiting_capture),
  };
  return (status: string) => labels[status] ?? t(($) => $.artifacts.unknown);
}

export function ArtifactStatus({ status }: { status: string }) {
  const label = useArtifactStatusLabel();
  return <span className={cn("inline-flex rounded-md px-2 py-1 text-caption", status === "approved" || status === "ready" ? "bg-success/10 text-success"
    : status === "needs_attention" || status === "rejected" ? "bg-destructive/10 text-destructive" : status === "pending" ? "bg-brand/10 text-brand" : "bg-muted text-muted-foreground")}>{label(status)}</span>;
}
