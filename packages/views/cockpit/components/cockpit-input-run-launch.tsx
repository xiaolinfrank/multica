"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import { beginCockpitInputRunLaunch, cockpitInputRunLaunchKey, settleCockpitInputRunLaunch, useCockpitInputRunLaunchStore, useRerunIssueWithInputs } from "@multica/core/cockpit";
import { issueOperationAllowed, useIssueOperationBasis } from "@multica/core/issues";
import { issueTasksOptions } from "@multica/core/issues/queries";
import type { CockpitInputManifestHeader, CockpitInputManifestVersionMetadata } from "@multica/core/types/cockpit-input";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { useT } from "../../i18n";
import { IssueRunsDialog } from "../../issues/components/issue-runs-dialog";
import { IssueOperationRestriction } from "../../issues/components/issue-operation-restriction";
import { CockpitInputManifestItems } from "./cockpit-input-manifest-items";
import { CockpitPreparationRun } from "./cockpit-preparation-run";
import { CockpitFlowError } from "./cockpit-task-flow";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { createSafeId } from "@multica/core/utils";

export function CockpitInputRunLaunch({ wsId, accountId, header, hasDraft, onRefresh, onInspect }: {
  wsId: string; accountId: string; header: CockpitInputManifestHeader; hasDraft: boolean; onRefresh: () => void; onInspect: (inputId: string, versionId: string) => void;
}) {
  const { t } = useT("cockpit"); const issueId = header.issue.id;
  const key = cockpitInputRunLaunchKey(wsId, accountId, issueId);
  const intent = useCockpitInputRunLaunchStore((state) => state.draft.intents[key]);
  const capture = useCockpitCommandContext(key); const lock = useRef(false);
  const launch = useRerunIssueWithInputs(wsId, issueId);
  const policy = useIssueOperationBasis(wsId, [issueId]); const basis = policy.byIssue.get(issueId);
  const [confirming, setConfirming] = useState<CockpitInputManifestVersionMetadata | null>(null);
  const [additional, setAdditional] = useState(false); const [additionalRequired, setAdditionalRequired] = useState(false); const [history, setHistory] = useState(false);
  const [error, setError] = useState("");
  const unresolved = intent?.state === "pending" || intent?.state === "unknown";
  const changed = Boolean(confirming && confirming.id !== header.currentVersion?.id);
  const canLaunch = issueOperationAllowed(basis, "execution") && header.issue.assigneeType === "agent" && Boolean(header.issue.assigneeId) && !hasDraft;
  async function submit() {
    if (lock.current || !confirming || changed || !canLaunch || unresolved && !additional) return;
    const next = { attemptId: createSafeId(), manifestVersionId: confirming.id, startedAt: new Date().toISOString() };
    if (!beginCockpitInputRunLaunch(key, next, intent ?? null, additional)) return;
    lock.current = true; setError(""); const current = capture();
    try {
      const run = await launch.mutateAsync(confirming.id);
      if (current()) { settleCockpitInputRunLaunch(key, next.attemptId, { state: "confirmed", runId: run.id }); setConfirming(null); }
    } catch (cause) {
      if (current()) {
        // Only the explicit manifest precondition rejection proves that no run
        // started. Network and other uncertain failures remain unresolved.
        const rejected = cause instanceof ApiError && cause.status === 409;
        settleCockpitInputRunLaunch(key, next.attemptId, { state: rejected ? "rejected" : "unknown" });
        setError(rejected ? t(($) => $.input_materials.run_manifest_changed) : t(($) => $.input_materials.run_result_unknown));
        setConfirming(null); if (rejected) onRefresh();
      }
    } finally { lock.current = false; }
  }
  return <div className="space-y-2">
    {hasDraft && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.run_save_first)}</p>}
    {unresolved && !launch.isPending && <div role="status" className="space-y-1 text-caption"><p>{t(($) => $.input_materials.run_result_unknown)}</p><p className="text-muted-foreground">{t(($) => $.input_materials.run_authorized_at, { time: intent.startedAt })}</p></div>}
    {error && !unresolved && <p role="alert" className="text-caption text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" disabled={launch.isPending || !canLaunch || !header.currentVersion} onClick={() => { setConfirming(header.currentVersion); setAdditional(false); setAdditionalRequired(Boolean(unresolved)); }}>{unresolved ? t(($) => $.input_materials.run_authorize_another) : t(($) => $.input_materials.run_with_manifest)}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setHistory(true)}>{t(($) => $.input_materials.run_history)}</Button>
      {intent?.confirmedRunId && <CockpitPreparationRun key={intent.confirmedRunId} wsId={wsId} issueId={issueId} runId={intent.confirmedRunId} context="execution" />}
    </div>
    {header.issue.assigneeType !== "agent" && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.run_assign_agent)}</p>}
    <IssueOperationRestriction observation={{ basis, pending: policy.isPending, error: policy.isError, retry: () => void policy.refetch() }} operation="execution" />
    <Dialog open={Boolean(confirming)} onOpenChange={(open) => { if (!open) setConfirming(null); }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t(($) => $.input_materials.run_with_manifest)}</DialogTitle></DialogHeader>
      {confirming && <div className="space-y-3"><p className="break-words text-caption font-medium">{header.issue.identifier} {header.issue.title}</p>
        <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.run_authorization_effect)}</p>
        <CockpitInputManifestItems key={confirming.id} wsId={wsId} version={confirming} onInspect={onInspect} />
        {changed && <p role="alert" className="text-caption text-destructive">{t(($) => $.input_materials.run_manifest_changed)}</p>}
        {additionalRequired && <label className="flex items-start gap-2 text-caption"><input type="checkbox" checked={additional} disabled={launch.isPending} onChange={(event) => setAdditional(event.target.checked)} />{t(($) => $.input_materials.run_additional_ack)}</label>}
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setConfirming(null)}>{t(($) => $.task_create.cancel)}</Button><Button type="button" disabled={launch.isPending || !canLaunch || changed || Boolean(unresolved && !additional)} aria-busy={launch.isPending} onClick={() => void submit()}>{t(($) => $.input_materials.run_confirm)}</Button></div>
      </div>}
    </DialogContent></Dialog>
    {history && <InputRunHistory issueId={issueId} identifier={header.issue.identifier} title={header.issue.title} onClose={() => setHistory(false)} />}
  </div>;
}

function InputRunHistory({ issueId, identifier, title, onClose }: { issueId: string; identifier: string; title: string; onClose: () => void }) {
  const { t } = useT("cockpit");
  // Reuse the Issue's canonical execution-history query and dialog. A history
  // row never resolves an unknown launch automatically.
  const query = useQuery({ ...issueTasksOptions(issueId), staleTime: 0 });
  if (query.isPending || query.isError) return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent><DialogHeader><DialogTitle>{t(($) => $.input_materials.run_history)}</DialogTitle></DialogHeader>
    {query.isError ? <CockpitFlowError onRetry={() => void query.refetch()} /> : <p role="status" className="text-caption">{t(($) => $.workflow.loading)}</p>}
  </DialogContent></Dialog>;
  return <IssueRunsDialog open onOpenChange={(open) => { if (!open) onClose(); }} issueId={issueId} identifier={identifier} issueTitle={title} tasks={query.data ?? []} />;
}
