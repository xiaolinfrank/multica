"use client";

import { useQuery } from "@tanstack/react-query";
import { cockpitNodeDetailOptions, cockpitNodeMeetingsPath, cockpitObjectPath,
  useDeleteCockpitNode, useUpdateCockpitNode,
  type CockpitScope, type CockpitNodeView, type CockpitPlanView } from "@multica/core/cockpit";
import type { CockpitPlanTaskCount } from "@multica/core/types/cockpit-read";
import { containerOperationBasisOptions, containerOperationAllowed } from "@multica/core/issues";
import { ContainerOperationRestriction } from "../../issues/components/issue-operation-restriction";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { toast } from "sonner";
import { X } from "lucide-react";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitNodePanel } from "./cockpit-node-panel";
import { CockpitNodeTasks } from "./cockpit-node-tasks";
import { CockpitDirectorySection } from "./cockpit-directory-section";
import { usePlanRowRename } from "../../plan-tree/use-plan-row-rename";
import { isCockpitRunningTasksError } from "@multica/core/cockpit";
import { RunningTasksDialog, type RunningTasksConflict } from "../../plan-tree/running-tasks-dialog";
import { useState } from "react";
import type { PlanRow } from "../../plan-tree/plan-rows";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitReadFailure } from "./cockpit-read-failure";

export function CockpitSelectedNode({ wsId, nodeId, scope, planView, section, issueCounts, subtreeProgress, onClose }: {
  wsId: string; nodeId: string; scope: CockpitScope; planView: CockpitPlanView; section: CockpitNodeView;
  /** The plan read's issue roll-up for this row: a work item with issues
   *  takes its progress from them. */
  issueCounts?: CockpitPlanTaskCount | null;
  /** A branch's rolled-up percentage, from the same leaves the gantt counts. */
  subtreeProgress?: number | null;
  onClose: () => void;
}) {
  const { t } = useT("cockpit"); const navigation = useNavigation();
  const captureContext = useCockpitCommandContext(JSON.stringify([wsId, nodeId]));
  const stillCurrent = captureContext();
  const close = () => { if (stillCurrent()) onClose(); };
  const query = useQuery(cockpitNodeDetailOptions(wsId, nodeId, scope)); const detail = query.data;
  const operation = useQuery(containerOperationBasisOptions(wsId, "node", nodeId));
  const deleteAllowed = !operation.isError && containerOperationAllowed(operation.data, "delete");
  const updateNode = useUpdateCockpitNode(wsId); const deleteNode = useDeleteCockpitNode(wsId);
  const renameRow = usePlanRowRename(wsId);
  const [conflict, setConflict] = useState<RunningTasksConflict | null>(null);
  const fail = (cause: unknown) => {
    toast.error(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed));
  };
  const reportDirectorySync = (sync?: { status: string; reason?: string; error?: string } | null) => {
    if (sync?.status === "failed") {
      toast.error(t(($) => $.directories.sync_failed, { reason: sync.error || sync.reason || "" }));
    }
  };
  // A running-task refusal is a choice, not a failure: hold the write's own
  // arguments (not a state value that may still be empty) so the retry sends
  // the name the server refused and the chosen sync mode.
  const conflictOrFail = (cause: unknown, retry: (mode: "force" | "defer") => void) => {
    if (isCockpitRunningTasksError(cause)) {
      setConflict({ tasks: cause.runningTasks, retry: (mode) => { setConflict(null); retry(mode); } });
      return;
    }
    fail(cause);
  };
  const readonly = !detail?.actor.is_human || detail.scope_match === false || query.isError;
  if (!detail) return <aside className="flex min-w-0 w-[54rem] max-w-full shrink-0 flex-col overflow-y-auto border-l border-border bg-card p-4 @max-[80rem]/cockpit:w-full @max-[80rem]/cockpit:border-l-0">
    <Button type="button" variant="ghost" size="icon-sm" className="mb-3 ml-auto" aria-label={t(($) => $.panel.close)} onClick={close}><X /></Button>
    {query.isPending ? <div role="status" className="flex gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
      : <CockpitReadFailure error={query.error} wsId={wsId} scope={scope} resource={`node:${nodeId}`} onRetry={() => void query.refetch()} />}
  </aside>;
  const node = detail.node;
  const executionSurface = detail.children_count === 0 && !node.project_id && !node.module_id;
  // The register filters by node; the panel only says how many there are and
  // hands the reader over.
  const meetingsHref = cockpitNodeMeetingsPath(navigation.pathname, nodeId, scope);
  // The breadcrumb quotes the parent's display code like every other surface.
  const parent = detail.ancestors.find((entry) => entry.id === node.parent_id);
  const kind = detail.ancestors.length === 0 ? "project" : detail.ancestors.length === 1 ? "module" : "work_item";
  const planRow: PlanRow = {
    node, kind, depth: detail.ancestors.length, code: node.code, name: node.name,
    counts: issueCounts ?? null, hasChildren: detail.children_count > 0,
  };
  const patch = (next: Parameters<typeof updateNode.mutate>[0]["patch"]) => {
    // L1/L2 names are projections of the project/module title (I5): writing
    // the node's own name would succeed and change nothing, and it would skip
    // the folder sync only the module/project write performs.
    if (next.name !== undefined && kind !== "work_item") {
      const name = next.name;
      const attempt = (mode?: "sync" | "defer" | "force") => renameRow(planRow, name, mode);
      void attempt(next.directory_sync).then(reportDirectorySync, (cause) => conflictOrFail(cause, (mode) => {
        void attempt(mode).then(reportDirectorySync, fail);
      }));
      const { name: _name, ...rest } = next;
      if (Object.keys(rest).length > 0) updateNode.mutate({ id: nodeId, patch: rest }, { onError: fail });
      return;
    }
    if (next.name !== undefined) {
      // The work item's row owns its name; a refused rename retries with the
      // same name and the chosen mode.
      const attempt = (mode?: "sync" | "defer" | "force") => updateNode.mutateAsync({
        id: nodeId,
        patch: { ...next, ...(mode ? { directory_sync: mode } : {}) },
      });
      void attempt(next.directory_sync).then(
        (updated) => reportDirectorySync(updated?.directory_sync),
        (cause) => conflictOrFail(cause, (mode) => {
          void attempt(mode).then((updated) => reportDirectorySync(updated?.directory_sync), fail);
        }),
      );
      return;
    }
    updateNode.mutate({ id: nodeId, patch: next }, { onError: fail });
  };
  return <><CockpitNodePanel node={node} section={section} onSectionChange={(view) => navigation.push(cockpitObjectPath(navigation.pathname, { kind: "node", id: nodeId, view, planView }, scope))}
    displayCode={node.code} parent={parent} isBranch={detail.children_count > 0} depth={detail.ancestors.length}
    issueCounts={issueCounts ?? null} subtreeProgress={subtreeProgress ?? null} meetingCount={detail.meetings.total} meetingsHref={meetingsHref}
    referenceWorkspace={<CockpitNodeTasks wsId={wsId} node={node} userId={detail.actor.user_id} readOnly={readonly} referenceOnly />}
    taskWorkspace={executionSurface ? <CockpitNodeTasks wsId={wsId} node={node} userId={detail.actor.user_id} readOnly={readonly} /> : undefined}
    notice={!detail.scope_match ? <div role="status" className="space-y-2 text-caption"><p>{t(($) => $.shell.scope_outside)}</p><AppLink href={cockpitObjectPath(navigation.pathname, { kind: "node", id: nodeId, view: section, planView }, { projectId: detail.binding.project_id, moduleId: detail.binding.module_id })} className="text-primary hover:underline">{t(($) => $.shell.show_object_scope)}</AppLink></div>
      : query.isError ? <CockpitReadFailure error={query.error} wsId={wsId} scope={scope} resource={`node:${nodeId}`} onRetry={() => void query.refetch()} /> : undefined}
    statusSuggestions={[node.status].filter(Boolean)}
    ownerSuggestions={[node.owner].filter(Boolean)}
    readOnly={readonly} onPatch={patch} onDelete={() => { if (!deleteAllowed) return Promise.reject(new Error(t(($) => $.errors.save_failed))); return deleteNode.mutateAsync(nodeId); }}
    directory={kind === "project" ? undefined : <CockpitDirectorySection wsId={wsId} nodeId={nodeId} projectId={detail.binding.project_id} readOnly={readonly} />}
    deleteAllowed={deleteAllowed} deleteRestriction={<ContainerOperationRestriction basis={operation.isError ? undefined : operation.data} operation="delete" pending={operation.isPending} error={operation.isError} retry={() => void operation.refetch()} />}
    deleteConfirmationDescription={detail.children_count > 0 ? t(($) => $.confirmation.delete_branch_description, { label: node.name || node.code }) : t(($) => $.confirmation.delete_description, { label: node.name || node.code })}
    onClose={close} />
  <RunningTasksDialog conflict={conflict} onDismiss={() => setConflict(null)} />
  </>;
}
