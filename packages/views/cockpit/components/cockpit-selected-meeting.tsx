"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  buildCockpitDisplayCodesFromIndex, cockpitMeetingDetailOptions, cockpitMeetingIssuesOptions, cockpitMeetingNodesOptions,
  cockpitMeetingWorkflowOptions, cockpitScopeMembersOptions, cockpitRelationViewKey, cockpitMeetingOperationBasisOptions, cockpitMeetingPreparationPath,
  useCockpitScopeViewStore, EMPTY_COCKPIT_RELATION_PAGE, cockpitObjectPath, cockpitSurfacePath,
  useAppendCockpitMeetingIssue, useAppendCockpitMeetingNode, useDeleteCockpitMeetingIssue, useDeleteCockpitMeetingNode,
  useSetCockpitMeetingIssueRolesCompact, useSaveCockpitMeetingMaterials, useUpdateCockpitMeeting ,
  useDeleteCockpitMeeting, useUpsertCockpitDirectoryCompact, useDeleteCockpitDirectoryCompact, type CockpitScope,
} from "@multica/core/cockpit";
import type { CockpitDirectoryEntry } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multica/ui/components/ui/alert-dialog";
import { X } from "lucide-react";
import { toast } from "sonner";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitMeetingPanel } from "./cockpit-meeting-panel";
import { useCockpitCommandContext } from "./use-cockpit-command-context";
import { CockpitReadFailure } from "./cockpit-read-failure";
import { CockpitFlowError, CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitMeetingOperationsMenu, CockpitMeetingRetentionNotice } from "./cockpit-meeting-operations-menu";
import { CockpitPreparationReasons } from "./cockpit-preparation-preview";

export function CockpitSelectedMeeting({ wsId, meetingId, scope, onClose, onOpenNode }: {
  wsId: string; meetingId: string; scope: CockpitScope; onClose: () => void; onOpenNode: (id: string) => void;
}) {
  const { t } = useT("cockpit"); const navigation = useNavigation();
  const captureContext = useCockpitCommandContext(JSON.stringify([wsId, meetingId]));
  const stillCurrent = captureContext();
  const close = () => { if (stillCurrent()) onClose(); };
  const query = useQuery(cockpitMeetingDetailOptions(wsId, meetingId, scope));
  const detail = query.data;
  const preparationAvailable = detail?.capabilities?.meeting_disposition === true || detail?.capabilities?.meeting_directory_preparation === true;
  const basis = useQuery({ ...cockpitMeetingOperationBasisOptions(wsId, meetingId), enabled: preparationAvailable });
  const [actionsOpen, setActionsOpen] = useState(false);
  const workflow = useQuery(cockpitMeetingWorkflowOptions(wsId, meetingId));
  const actorId = detail?.actor.user_id ?? "";
  const memberIds = [...new Set([actorId, workflow.data?.reviewer_id, workflow.data?.current_version?.reviewer_id,
    workflow.data?.minutes_issue?.assignee_type === "member" ? workflow.data.minutes_issue.assignee_id : null].filter((id): id is string => Boolean(id)))];
  const members = useQuery({ ...cockpitScopeMembersOptions(wsId, { ids: memberIds, page_size: 20 }), enabled: memberIds.length > 0 });
  const people = useMemo(() => (members.data?.items ?? []).map((member) => ({ user_id: member.id, name: member.title, avatar_url: member.avatar_url })), [members.data]);
  const issueKey = cockpitRelationViewKey(wsId, "meeting-issues", meetingId), nodeKey = cockpitRelationViewKey(wsId, "meeting-nodes", meetingId);
  const issueCursors = useCockpitScopeViewStore((state) => state.relations[issueKey] ?? EMPTY_COCKPIT_RELATION_PAGE);
  const nodeCursors = useCockpitScopeViewStore((state) => state.relations[nodeKey] ?? EMPTY_COCKPIT_RELATION_PAGE);
  const issues = useQuery({ ...cockpitMeetingIssuesOptions(wsId, meetingId, issueCursors.at(-1) || undefined), enabled: issueCursors.length > 1 });
  const nodes = useQuery({ ...cockpitMeetingNodesOptions(wsId, meetingId, nodeCursors.at(-1) || undefined), enabled: nodeCursors.length > 1 });
  const issuePage = issueCursors.length === 1 ? detail?.linked_issues : issues.data;
  const nodePage = nodeCursors.length === 1 ? detail?.linked_nodes : nodes.data;
  const appendIssue = useAppendCockpitMeetingIssue(wsId), appendNode = useAppendCockpitMeetingNode(wsId);
  const unlinkIssue = useDeleteCockpitMeetingIssue(wsId), unlinkNode = useDeleteCockpitMeetingNode(wsId);
  const roles = useSetCockpitMeetingIssueRolesCompact(wsId), update = useUpdateCockpitMeeting(wsId);
  const saveMaterial = useSaveCockpitMeetingMaterials(wsId);
  const remove = useDeleteCockpitMeeting(wsId), upsertDirectory = useUpsertCockpitDirectoryCompact(wsId), deleteContact = useDeleteCockpitDirectoryCompact(wsId);
  const [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState(""); const deleteLock = useRef(false);
  const fail = (cause: unknown) => toast.error(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed));
  const saveContacts = async (entries: (CockpitDirectoryEntry & { clear_position?: boolean })[]) => {
    try { await upsertDirectory.mutateAsync({ entries: entries.map(({ party, name, position, clear_position }) => ({ party, name, position, clear_position })) }); return true; } catch { toast.error(t(($) => $.meetings.directory_save_failed)); return false; }
  };
  const codes = useMemo(() => buildCockpitDisplayCodesFromIndex(detail?.node_index ?? []), [detail?.node_index]);
  const labels = new Map((nodePage?.items ?? []).map((link) => [link.node_id, `${codes.get(link.node_id) ?? link.code} ${link.name}`.trim()]));
  if (!detail) return <aside className="min-w-0 w-[46rem] max-w-full shrink-0 space-y-4 overflow-y-auto border-l border-border bg-card p-4 @max-[80rem]/cockpit:w-full @max-[80rem]/cockpit:border-l-0">
    <Button type="button" variant="ghost" size="icon-sm" onClick={close} aria-label={t(($) => $.panel.close)}><X className="size-4" /></Button>
    {query.isError ? <CockpitReadFailure error={query.error} wsId={wsId} scope={scope} resource={`meeting:${meetingId}`} onRetry={() => void query.refetch()} onClose={close} /> : <Spinner />}
  </aside>;
  const readOnly = !detail.actor.is_human || !detail.scope_match || query.isError;
  const defaults = detail.cockpit;
  const projectId = scope.projectId ?? defaults?.meeting_project_id ?? null;
  const moduleId = scope.moduleId ?? (!scope.projectId || scope.projectId === defaults?.meeting_project_id ? defaults?.meeting_module_id ?? null : null);
  const defaultNodeId = projectId === defaults?.meeting_project_id && moduleId === defaults?.meeting_module_id ? defaults?.meeting_node_id ?? null : null;
  const pager = (kind: "issues" | "nodes") => {
    const cursors = kind === "issues" ? issueCursors : nodeCursors, key = kind === "issues" ? issueKey : nodeKey;
    const page = kind === "issues" ? issuePage : nodePage, active = kind === "issues" ? issues : nodes;
    const failed = cursors.length > 1 && active.isError;
    return <div className="mb-3 space-y-2">{failed && <CockpitFlowError onRetry={() => void active.refetch()} />}
      <CockpitFlowPaging page={cursors.length} shown={page?.items.length ?? 0} total={page?.total} hasNext={Boolean(page?.next_cursor) && !failed} busy={active.isFetching}
        onPrevious={() => useCockpitScopeViewStore.getState().setRelationPage(key, cursors.slice(0, -1))}
        onNext={() => { if (page?.next_cursor) useCockpitScopeViewStore.getState().setRelationPage(key, [...cursors, page.next_cursor]); }} />
    </div>;
  };
  return <><CockpitMeetingPanel wsId={wsId} currentUserId={actorId} meeting={detail.meeting}
    lifecycleAvailable={detail.capabilities?.meeting_lifecycle === true}
    directoryPreparationAvailable={detail.capabilities?.meeting_directory_preparation === true} onManageMeeting={() => setActionsOpen(true)}
    meetingActions={<CockpitMeetingOperationsMenu wsId={wsId} meeting={detail.meeting} open={actionsOpen} onOpenChange={setActionsOpen} available={preparationAvailable} dispositionAvailable={detail.capabilities?.meeting_disposition === true} readOnly={readOnly} legacyDeleteAllowed={workflow.data?.enabled === false && !workflow.isError} onDelete={() => { setDeleteError(""); setDeleting(true); }} onPrepared={(id) => { navigation.push(cockpitMeetingPreparationPath(navigation.pathname, meetingId, id, navigation.searchParams)); }} />}
    meetings={[detail.meeting]} members={people}
    defaultPlacement={{ project_id: projectId, module_id: moduleId, node_id: defaultNodeId }}
    defaultAssigneeType={defaults?.meeting_assignee_type || null} defaultAssigneeId={defaults?.meeting_assignee_id ?? null}
    issueLinks={issuePage?.items ?? []} nodeLinks={nodePage?.items ?? []} nodeLabels={labels} nodeCodes={codes} issuePaging={pager("issues")} nodePaging={pager("nodes")} issuePageReady={Boolean(issuePage)} nodePageReady={Boolean(nodePage)}
    onSaveDirectory={(nas_dir) => saveMaterial.mutateAsync({ id: meetingId, patch: { nas_dir } }).then(() => undefined)}
    readOnly={readOnly} onClose={close} onOpenNode={onOpenNode} onPatch={(patch) => update.mutate({ id: meetingId, patch }, { onError: fail })}
    onLinkIssue={(issueId) => appendIssue.mutateAsync({ meetingId, issueId })}
    onUnlinkIssue={(issueId) => unlinkIssue.mutate({ meetingId, issueId }, { onError: fail })}
    onSaveIssueRoles={(issueId, nextRoles) => roles.mutateAsync({ meetingId, issueId, roles: nextRoles })}
    onLinkNode={(nodeId) => appendNode.mutateAsync({ meetingId, nodeId })}
    onUnlinkNode={(nodeId) => unlinkNode.mutate({ meetingId, nodeId }, { onError: fail })}
    onSaveDirectoryEntry={(entry) => saveContacts([entry])} onAutoSaveDirectory={(entries) => upsertDirectory.mutate({ entries: entries.map(({ party, name, position }) => ({ party, name, position })), only_unknown_names: true }, { onError: fail })}
    onDeleteDirectoryEntry={async (entry) => { try { await deleteContact.mutateAsync(entry); return true; } catch { toast.error(t(($) => $.meetings.directory_delete_failed)); return false; } }}
    onDelete={() => { setDeleteError(""); setDeleting(true); }}
    notice={!detail.scope_match || query.isError || detail.meeting.archived_at || detail.meeting.occurrence_state === "cancelled" ? <>{!detail.scope_match ? <div role="status" className="space-y-2 text-caption"><p>{t(($) => $.shell.scope_outside)}</p><AppLink href={cockpitObjectPath(navigation.pathname, { kind: "meeting", id: meetingId }, { projectId: null, moduleId: null })} className="text-primary underline">{t(($) => $.shell.clear_scope)}</AppLink></div>
      : query.isError ? <CockpitReadFailure error={query.error} wsId={wsId} scope={scope} resource={`meeting:${meetingId}`} onRetry={() => void query.refetch()} /> : null}<CockpitMeetingRetentionNotice meeting={detail.meeting} basis={basis.data} onManage={() => setActionsOpen(true)} /></> : undefined} />
    <AlertDialog open={deleting} onOpenChange={(open) => { if (!deleteLock.current) setDeleting(open); }}><AlertDialogContent><AlertDialogHeader>
      <AlertDialogTitle>{t(($) => $.meeting.delete, { title: detail.meeting.title || detail.meeting.code })}</AlertDialogTitle><AlertDialogDescription>{t(($) => $.confirmation.delete_description, { label: detail.meeting.title || detail.meeting.code })}</AlertDialogDescription></AlertDialogHeader>
      {preparationAvailable && (basis.isError ? <CockpitFlowError onRetry={() => void basis.refetch()} /> : basis.data?.delete.state !== "allowed" ? <CockpitPreparationReasons codes={basis.data?.delete.reason_codes ?? []} targets={basis.data?.targets ?? []} /> : null)}
      {deleteError && <p role="alert" className="text-caption text-destructive">{deleteError}</p>}
      <AlertDialogFooter><AlertDialogCancel render={<Button type="button" variant="outline" disabled={remove.isPending} />}>{t(($) => $.task_create.cancel)}</AlertDialogCancel>
        <Button type="button" variant="destructive" disabled={remove.isPending || readOnly || (preparationAvailable ? basis.isError || basis.data?.availability !== "available" || basis.data.delete.state !== "allowed" : workflow.data?.enabled !== false || workflow.isError)} onClick={() => {
          if (deleteLock.current || readOnly || (preparationAvailable ? basis.isError || basis.data?.availability !== "available" || basis.data.delete.state !== "allowed" : workflow.data?.enabled !== false || workflow.isError)) return; deleteLock.current = true;
          void remove.mutateAsync(meetingId).then(() => { if (stillCurrent()) { setDeleting(false); navigation.push(cockpitSurfacePath(navigation.pathname, "meetings", scope)); } })
            .catch((cause: unknown) => { if (stillCurrent()) setDeleteError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed)); }).finally(() => { deleteLock.current = false; });
        }}>{remove.isPending && <Spinner />}{t(($) => $.meeting.delete, { title: detail.meeting.title || detail.meeting.code })}</Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </>;
}
