"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { taskDetailOptions } from "@multica/core/agents";
import { ApiError } from "@multica/core/api";
import { taskMessagesOptions } from "@multica/core/chat/queries";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";
import { AgentTranscriptDialog, buildTimeline } from "../../common/task-transcript";
import { CockpitFlowError } from "./cockpit-task-flow";

export function usePreparationRunStatusLabel() {
  const { t } = useT("cockpit");
  const labels: Record<string, string> = {
    queued: t(($) => $.meeting_disposition.run_queued), deferred: t(($) => $.meeting_disposition.run_deferred), dispatched: t(($) => $.meeting_disposition.run_dispatched),
    running: t(($) => $.meeting_disposition.run_running), waiting_local_directory: t(($) => $.meeting_disposition.run_waiting_local_directory),
    completed: t(($) => $.meeting_disposition.run_completed), failed: t(($) => $.meeting_disposition.run_failed), cancelled: t(($) => $.meeting_disposition.run_cancelled),
  };
  return (status: string) => labels[status] ?? t(($) => $.artifacts.unknown);
}

/** Read only this run on demand; the Issue's complete run collection is never a lookup fallback. */
export function CockpitPreparationRun({ wsId, runId, issueId }: { wsId: string; runId: string; issueId?: string | null }) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const status = usePreparationRunStatusLabel(); const [open, setOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const query = useQuery({ ...taskDetailOptions(wsId, runId), enabled: open, staleTime: 0 });
  const task = query.data; const matches = task?.id === runId && (!issueId || task.issue_id === issueId);
  const messages = useQuery({ ...taskMessagesOptions(runId), enabled: open && transcriptOpen && Boolean(matches), staleTime: 0, retry: false });
  const issueHref = issueId ? paths.issueDetail(issueId) : undefined;
  return <><Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setTranscriptOpen(false); }}><DialogTrigger render={<Button variant="outline" size="sm" />}>{t(($) => $.meeting_preparation.open_run)}</DialogTrigger>
    <DialogContent className="max-h-[85dvh] overflow-y-auto"><DialogHeader><DialogTitle>{t(($) => $.meeting_preparation.open_run)}</DialogTitle></DialogHeader>
      {query.isPending ? <Spinner /> : query.isError || !task || !matches ? <RunReadFailure error={query.error} retry={() => void query.refetch()} /> : <div className="space-y-3">
        <p className="text-body font-medium">{status(task.status)}</p><p className="text-caption text-muted-foreground">{t(($) => $.meeting_disposition.stop_hint)}</p>
        <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => setTranscriptOpen(true)}>{t(($) => $.meeting_preparation.open_transcript)}</Button><Button size="sm" variant="ghost" onClick={() => void query.refetch()}>{t(($) => $.meeting_lifecycle.refresh)}</Button></div>
        <details className="text-caption text-muted-foreground"><summary className="cursor-pointer">{t(($) => $.artifact_runtime.diagnostics)}</summary><p className="break-all">{runId}</p></details>
      </div>}
      {issueId && <AppLink target="_blank" rel="noopener noreferrer" className="text-caption text-primary underline" href={paths.issueDetail(issueId)}>{t(($) => $.meeting_preparation.open_issue)} {t(($) => $.action_flow.new_tab)}</AppLink>}
    </DialogContent>
  </Dialog>
    {open && transcriptOpen && task && matches && <AgentTranscriptDialog open onOpenChange={setTranscriptOpen} task={task} agentName="" items={buildTimeline(messages.data ?? [])} isLive={task.status === "running"}
      contentState={messages.isPending || messages.isFetching ? <Spinner /> : messages.isError ? <RunReadFailure error={messages.error} retry={() => void messages.refetch()} issueHref={issueHref} /> : undefined} />}
  </>;
}

function RunReadFailure({ error, retry, issueHref }: { error: unknown; retry: () => void; issueHref?: string }) {
  const { t } = useT("cockpit");
  return <div className="space-y-2 text-caption">{error instanceof ApiError && (error.status === 403 || error.status === 404) ? <p role="alert">{error.status === 403 ? t(($) => $.meeting_preparation.run_forbidden) : t(($) => $.meeting_preparation.run_unavailable)}</p> : <CockpitFlowError onRetry={retry} />}
    {error instanceof ApiError && error.status === 403 && <Button variant="outline" size="sm" onClick={retry}>{t(($) => $.binding.retry)}</Button>}
    {issueHref && <AppLink target="_blank" rel="noopener noreferrer" href={issueHref} className="text-primary underline">{t(($) => $.meeting_preparation.open_issue)} {t(($) => $.action_flow.new_tab)}</AppLink>}
  </div>;
}
