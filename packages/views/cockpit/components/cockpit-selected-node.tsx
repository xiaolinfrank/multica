"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { buildCockpitDisplayCodesFromIndex, cockpitNodeDetailOptions, cockpitNodePaymentsOptions, cockpitNodeMeetingsOptions, cockpitObjectPath,
  cockpitRelationViewKey, EMPTY_COCKPIT_RELATION_PAGE, useCockpitScopeViewStore, useAppendCockpitNodeIssue, useDeleteCockpitNode,
  useCreateCockpitPayment, useUpdateCockpitNode, useUpdateCockpitPayment, useDeleteCockpitPayment, useSetCockpitNodeBinding,
  type CockpitScope, type CockpitNodeView, type CockpitPlanView } from "@multica/core/cockpit";
import { useModalStore } from "@multica/core/modals";
import type { Issue } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multica/ui/components/ui/alert-dialog";
import { toast } from "sonner";
import { X } from "lucide-react";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitNodePanel } from "./cockpit-node-panel";
import { CockpitNodeTasks } from "./cockpit-node-tasks";
import { CockpitNodeBindingField } from "./cockpit-node-binding";
import { CockpitArtifacts } from "./cockpit-artifacts";
import { CockpitArtifactCreate } from "./cockpit-artifact-create";
import { CockpitAcceptance } from "./cockpit-acceptance";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitReadFailure } from "./cockpit-read-failure";

export function CockpitSelectedNode({ wsId, nodeId, scope, planView, section, onClose, onOpenNode, onOpenMeeting }: {
  wsId: string; nodeId: string; scope: CockpitScope; planView: CockpitPlanView; section: CockpitNodeView;
  onClose: () => void; onOpenNode: (id: string) => void; onOpenMeeting: (id: string) => void;
}) {
  const { t } = useT("cockpit"); const navigation = useNavigation();
  const captureContext = useCockpitCommandContext(JSON.stringify([wsId, nodeId]));
  const stillCurrent = captureContext();
  const close = () => { if (stillCurrent()) onClose(); };
  const query = useQuery(cockpitNodeDetailOptions(wsId, nodeId, scope)); const detail = query.data;
  const paymentKey = cockpitRelationViewKey(wsId, "payments", nodeId); const meetingKey = cockpitRelationViewKey(wsId, "node-meetings", nodeId);
  const paymentCursors = useCockpitScopeViewStore((state) => state.relations[paymentKey] ?? EMPTY_COCKPIT_RELATION_PAGE);
  const meetingCursors = useCockpitScopeViewStore((state) => state.relations[meetingKey] ?? EMPTY_COCKPIT_RELATION_PAGE);
  const setPage = useCockpitScopeViewStore((state) => state.setRelationPage);
  const paymentQuery = useQuery({ ...cockpitNodePaymentsOptions(wsId, nodeId, paymentCursors.at(-1) || undefined), enabled: paymentCursors.length > 1 && Boolean(detail) });
  const meetingQuery = useQuery({ ...cockpitNodeMeetingsOptions(wsId, nodeId, meetingCursors.at(-1) || undefined), enabled: meetingCursors.length > 1 && Boolean(detail) });
  const payments = paymentCursors.length === 1 ? detail?.payments : paymentQuery.data;
  const meetings = meetingCursors.length === 1 ? detail?.meetings : meetingQuery.data;
  const codes = useMemo(() => buildCockpitDisplayCodesFromIndex(detail?.node_index ?? []), [detail?.node_index]);
  const updateNode = useUpdateCockpitNode(wsId); const deleteNode = useDeleteCockpitNode(wsId); const setBinding = useSetCockpitNodeBinding(wsId);
  const appendIssue = useAppendCockpitNodeIssue(wsId); const createPayment = useCreateCockpitPayment(wsId); const patchPayment = useUpdateCockpitPayment(wsId); const deletePayment = useDeleteCockpitPayment(wsId);
  const [removingPayment, setRemovingPayment] = useState<{ id: string; label: string } | null>(null); const deletionLock = useRef(false); const [deleteError, setDeleteError] = useState("");
  const fail = (cause: unknown) => toast.error(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed));
  const readonly = !detail?.actor.is_human || detail.scope_match === false || query.isError;
  if (!detail) return <aside className="flex w-[min(54rem,70vw)] max-w-full shrink-0 flex-col border-l border-border bg-card p-4 max-xl:w-full">
    <Button type="button" variant="ghost" size="icon-sm" className="mb-3 ml-auto" aria-label={t(($) => $.panel.close)} onClick={close}><X /></Button>
    {query.isPending ? <div role="status" className="flex gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
      : <CockpitReadFailure error={query.error} wsId={wsId} scope={scope} resource={`node:${nodeId}`} onRetry={() => void query.refetch()} />}
  </aside>;
  const node = detail.node; const binding = detail.binding;
  const nodeLabel = `${codes.get(node.id) ?? node.code} ${node.name}`.trim();
  const executionSurface = detail.children_count === 0 && !node.project_id && !node.module_id;
  const canFile = Boolean(binding.project_id && binding.module_id);
  const filingProjectId = binding.project_id; const filingModuleId = binding.module_id;
  const createReference = canFile && !node.project_id && !node.module_id ? () => {
    useModalStore.getState().open("create-issue", { title: codes.get(node.id) ?? node.code, project_id: filingProjectId, module_id: filingModuleId,
      cockpit_node: { node_id: node.id, code: codes.get(node.id) ?? node.code, label: nodeLabel, project_id: filingProjectId, module_id: filingModuleId },
      on_created: (issue: Issue, state: { cockpit_node_id: string | null }) => { if (state.cockpit_node_id) void appendIssue.mutateAsync({ nodeId: state.cockpit_node_id, issueId: issue.id }).catch(fail); } });
  } : undefined;
  const relationPager = (kind: "payments" | "meetings") => {
    const rows = kind === "payments" ? payments : meetings; const cursors = kind === "payments" ? paymentCursors : meetingCursors;
    const pageQuery = kind === "payments" ? paymentQuery : meetingQuery; const key = kind === "payments" ? paymentKey : meetingKey;
    return <div className="mb-3 space-y-2">{rows ? <CockpitFlowPaging page={cursors.length} shown={rows.items.length} total={rows.total} hasNext={Boolean(rows.next_cursor)} busy={pageQuery.isFetching || query.isFetching}
      onPrevious={() => { if (cursors.length > 1) setPage(key, cursors.slice(0, -1)); }} onNext={() => { if (rows.next_cursor) setPage(key, [...cursors, rows.next_cursor]); }} />
      : cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => setPage(key, cursors.slice(0, -1))}>{t(($) => $.task_flow.previous)}</Button>}
      {cursors.length > 1 && (pageQuery.isError ? <CockpitFlowError onRetry={() => void pageQuery.refetch()} /> : pageQuery.isPending ? <Spinner /> : null)}</div>;
  };
  return <><CockpitNodePanel node={node} section={section} onSectionChange={(view) => navigation.push(cockpitObjectPath(navigation.pathname, { kind: "node", id: nodeId, view, planView }, scope))}
    displayCode={codes.get(node.id)} parent={detail.ancestors.find((entry) => entry.id === node.parent_id)} isBranch={detail.children_count > 0} depth={detail.ancestors.length}
    payments={payments?.items ?? []} paymentTotal={paymentCursors.length === 1 ? detail.payment_total : paymentQuery.data?.payment_total ?? detail.payment_total}
    paymentPaging={relationPager("payments")} meetings={meetings?.items ?? []} meetingPaging={relationPager("meetings")}
    referenceWorkspace={<CockpitNodeTasks wsId={wsId} node={node} userId={detail.actor.user_id} readOnly={readonly} referenceOnly onCreateReference={createReference} />}
    taskWorkspace={executionSurface ? <CockpitNodeTasks wsId={wsId} node={node} userId={detail.actor.user_id} readOnly={readonly} /> : undefined}
    artifactWorkspace={executionSurface && detail.capabilities?.artifacts === true ? <CockpitArtifacts wsId={wsId} scope={scope} nodeId={nodeId}
      registration={filingProjectId && filingModuleId && binding.eligible ? <CockpitArtifactCreate wsId={wsId} nodeId={nodeId} nodeLabel={nodeLabel} projectId={filingProjectId} moduleId={filingModuleId} scope={scope} disabled={readonly} />
        : <AppLink href={cockpitObjectPath(navigation.pathname, { kind: "node", id: nodeId, view: "details", planView }, scope)} className="text-caption text-primary hover:underline">{t(($) => $.binding.configure)}</AppLink>} /> : undefined}
    acceptanceWorkspace={executionSurface && detail.capabilities?.acceptance === true ? <CockpitAcceptance wsId={wsId} nodeId={nodeId} scope={scope} currentUserId={detail.actor.user_id} readOnly={readonly} /> : undefined}
    binding={<CockpitNodeBindingField wsId={wsId} node={node} ancestors={detail.ancestors} binding={binding} onSave={(next) => setBinding.mutateAsync({ id: nodeId, ...next })} onOpenNode={onOpenNode} readOnly={readonly} />}
    notice={!detail.scope_match ? <div role="status" className="space-y-2 text-caption"><p>{t(($) => $.shell.scope_outside)}</p><AppLink href={cockpitObjectPath(navigation.pathname, { kind: "node", id: nodeId, view: section, planView }, { projectId: binding.project_id, moduleId: binding.module_id })} className="text-primary hover:underline">{t(($) => $.shell.show_object_scope)}</AppLink></div>
      : query.isError ? <CockpitReadFailure error={query.error} wsId={wsId} scope={scope} resource={`node:${nodeId}`} onRetry={() => void query.refetch()} /> : undefined}
    statusSuggestions={[node.status].filter(Boolean)} execStatusSuggestions={[node.exec_status].filter(Boolean)} budgetCategorySuggestions={[node.budget_category].filter(Boolean)} ownerSuggestions={[node.owner].filter(Boolean)} vendorSuggestions={[node.vendor].filter(Boolean)}
    readOnly={readonly} onPatch={(patch) => updateNode.mutate({ id: nodeId, patch }, { onError: fail })} onDelete={() => deleteNode.mutateAsync(nodeId)}
    deleteConfirmationDescription={detail.children_count > 0 ? t(($) => $.confirmation.delete_branch_description, { label: node.name || node.code }) : t(($) => $.confirmation.delete_description, { label: node.name || node.code })}
    onClose={close} onOpenMeeting={onOpenMeeting}
    onCreatePayment={() => createPayment.mutate({ nodeId, body: { label: t(($) => $.payment.new_label, { index: detail.payments.total + 1 }), amount: 0, position: detail.payments.total } }, { onError: fail })}
    onPatchPayment={(id, patch) => patchPayment.mutate({ id, patch }, { onError: fail })} onDeletePayment={(id) => { const found = payments?.items.find((item) => item.id === id); if (found) { setDeleteError(""); setRemovingPayment({ id, label: found.label }); } }} />
    <AlertDialog open={Boolean(removingPayment)} onOpenChange={(open) => { if (!open && !deletionLock.current) setRemovingPayment(null); }}><AlertDialogContent><AlertDialogHeader>
      <AlertDialogTitle>{t(($) => $.payment.delete)}</AlertDialogTitle><AlertDialogDescription>{t(($) => $.confirmation.delete_description, { label: removingPayment?.label ?? "" })}</AlertDialogDescription></AlertDialogHeader>
      {deleteError && <p role="alert" className="text-caption text-destructive">{deleteError}</p>}
      <AlertDialogFooter><AlertDialogCancel render={<Button type="button" variant="outline" disabled={deletePayment.isPending} />}>{t(($) => $.task_create.cancel)}</AlertDialogCancel>
        <Button type="button" variant="destructive" disabled={deletePayment.isPending || !removingPayment} onClick={() => {
          if (!removingPayment || deletionLock.current) return; deletionLock.current = true;
          void deletePayment.mutateAsync(removingPayment.id).then(() => setRemovingPayment(null)).catch(() => setDeleteError(t(($) => $.errors.save_failed))).finally(() => { deletionLock.current = false; });
        }}>{deletePayment.isPending && <Spinner />}{t(($) => $.payment.delete)}</Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </>;
}
