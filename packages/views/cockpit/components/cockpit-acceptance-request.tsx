"use client";

import { useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import { cockpitAcceptanceDraftKey, cockpitAcceptanceRequestOptions, cockpitArtifactOptions, cockpitObjectPath, cockpitSelectedMemberOptions,
  prepareCockpitAcceptanceRequest, rebaseCockpitAcceptanceRequestDraft, settleCockpitAcceptanceRequest, updateCockpitAcceptanceRequestDraft,
  useCockpitAcceptanceDraftStore, useCreateCockpitAcceptanceRequest, type CockpitScope, type CockpitAcceptanceRequestDraft } from "@multica/core/cockpit";
import type { CockpitAcceptanceHeader, CockpitAcceptanceCriteriaView } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitReviewerSelect } from "./cockpit-reviewer-select";
import { CockpitAcceptanceEvidencePicker, approvedAcceptanceEvidence } from "./cockpit-acceptance-evidence-picker";
import { CockpitFlowError } from "./cockpit-task-flow";
import { useCockpitCommandContext } from "./use-cockpit-command-context";

const EMPTY_REQUEST: CockpitAcceptanceRequestDraft = { criteriaRevision: 0, reviewerId: "", note: "", evidence: {}, supersedesRequestId: "", pending: null };

export function CockpitAcceptanceRequestForm({ wsId, header, definition, scope, currentUserId, disabled }: {
  wsId: string; header: CockpitAcceptanceHeader; definition: CockpitAcceptanceCriteriaView; scope: CockpitScope; currentUserId: string; disabled: boolean;
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const navigation = useNavigation();
  const key = cockpitAcceptanceDraftKey(wsId, header.node_id);
  const draft = useCockpitAcceptanceDraftStore((store) => store.draft.requests[key] ?? EMPTY_REQUEST);
  const [open, setOpen] = useState(false); const [error, setError] = useState(""); const lock = useRef(false);
  const create = useCreateCockpitAcceptanceRequest(wsId);
  const captureContext = useCockpitCommandContext(JSON.stringify([wsId, header.node_id, currentUserId, scope]));
  const update = (patch: Parameters<typeof updateCockpitAcceptanceRequestDraft>[2]) => updateCockpitAcceptanceRequestDraft(key, definition.revision, patch);
  const current = header.current_request;
  const knownDecision = !current || ["pending", "approved", "changes_requested", "rejected"].includes(current.decision);
  const pendingCurrent = current?.decision === "pending" && !current.superseded_at;
  const currentDetail = useQuery({ ...cockpitAcceptanceRequestOptions(wsId, header.node_id, current?.id ?? ""), enabled: Boolean(open && pendingCurrent) });
  const canReplace = Boolean(pendingCurrent && header.can_request && (current.criteria_revision !== definition.revision
    || !currentDetail.isError && !currentDetail.isFetching && currentDetail.data?.request.id === current.id && (currentDetail.data.definition_changed || currentDetail.data.evidence_outdated)));
  const reviewer = useQuery({ ...cockpitSelectedMemberOptions(wsId, draft.reviewerId), enabled: Boolean(open && draft.reviewerId) });
  const artifactIds = [...new Set(Object.values(draft.evidence).flat().map((item) => item.artifactId))].sort();
  const selected = useQueries({ queries: artifactIds.slice(0, 200).map((id) => ({ ...cockpitArtifactOptions(wsId, id), enabled: open })) });
  const selectedById = new Map(artifactIds.slice(0, 200).map((id, index) => [id, selected[index]]));
  const allVersions = Object.values(draft.evidence).flat().map((item) => item.versionId);
  const hasDraft = Boolean(draft.pending || draft.note || draft.reviewerId || allVersions.length);
  const stale = draft !== EMPTY_REQUEST && draft.criteriaRevision !== definition.revision;
  const ownerValid = header.workspace_id === wsId && definition.workspace_id === wsId && header.node_id === definition.node_id;
  const definitionValid = ownerValid && header.criteria_revision === definition.revision && definition.items.length > 0 && definition.items.length <= Math.min(50, definition.max_items);
  const evidenceValid = artifactIds.length <= 200 && new Set(allVersions).size <= 200 && definition.items.every((criterion) => {
    const values = draft.evidence[criterion.id] ?? [];
    return values.length > 0 && values.length <= 20 && new Set(values.map((item) => item.versionId)).size === values.length && values.every((item) => {
      const query = selectedById.get(item.artifactId); const artifact = query?.data;
      return !query?.isError && !query?.isFetching && artifact?.workspace_id === wsId && approvedAcceptanceEvidence(artifact)?.id === item.versionId;
    });
  }) && Object.keys(draft.evidence).every((id) => definition.items.some((item) => item.id === id));
  const reviewerValid = !reviewer.isFetching && !reviewer.isError && reviewer.data?.items.some((member) => member.id === draft.reviewerId);
  const canStart = header.can_request && (!pendingCurrent || canReplace && draft.supersedesRequestId === current.id)
    && (pendingCurrent || !draft.supersedesRequestId);
  const noteValid = new TextEncoder().encode(draft.note.trim()).length <= 16000;
  const valid = Boolean(ownerValid && currentUserId && knownDecision && (draft.pending || definitionValid && !stale && canStart && evidenceValid && reviewerValid && noteValid));
  const locked = disabled || create.isPending || Boolean(draft.pending);
  async function save() {
    if (lock.current || disabled || !valid) return;
    const body = prepareCockpitAcceptanceRequest(key, crypto.randomUUID()); if (!body) return;
    const stillCurrent = captureContext(); lock.current = true; setError("");
    try {
      const result = await create.mutateAsync({ nodeId: header.node_id, body });
      settleCockpitAcceptanceRequest(key, body.request_key, true);
      if (stillCurrent()) { setOpen(false); navigation.push(cockpitObjectPath(paths.cockpit(), { kind: "node", id: header.node_id, view: "acceptance", requestId: result.request.id }, scope)); }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) settleCockpitAcceptanceRequest(key, body.request_key, false);
      if (stillCurrent()) setError(cause instanceof ApiError ? cause.message : t(($) => $.task_flow.unconfirmed));
    } finally { lock.current = false; }
  }
  return <Dialog open={open} onOpenChange={(next) => { if (!lock.current) { if (next && draft === EMPTY_REQUEST) update({}); setOpen(next); } }}>
    <div className="space-y-2"><DialogTrigger render={<Button type="button" size="sm" variant="outline" disabled={disabled || !currentUserId || !definition.items.length && !hasDraft} />}>{t(($) => $.acceptance_request.start)}</DialogTrigger>
      {!definition.items.length && <p className="text-caption text-muted-foreground">{t(($) => $.acceptance_request.edit_criteria_first)}</p>}</div>
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-2xl"><DialogHeader>
      <DialogTitle>{t(($) => $.acceptance_request.start)}</DialogTitle><DialogDescription>{t(($) => $.acceptance_request.hint)}</DialogDescription>
    </DialogHeader><div className="min-h-0 space-y-4 overflow-y-auto pr-1">
      {draft.pending && <p role="status" className="rounded-lg bg-warning-subtle p-3 text-caption">{t(($) => $.task_flow.pending_request)}</p>}
      {!definitionValid && <p role="alert" className="text-caption text-destructive">{t(($) => $.acceptance_request.no_criteria)}</p>}
      {stale && !draft.pending && <div role="alert" className="space-y-2 rounded-lg bg-warning-subtle p-3 text-caption"><p>{t(($) => $.acceptance_request.criteria_changed)}</p>
        <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => rebaseCockpitAcceptanceRequestDraft(key, definition.revision, definition.items.map((item) => item.id))}>{t(($) => $.acceptance_request.rebase)}</Button></div>}
      {!knownDecision && <p role="alert" className="text-caption text-destructive">{t(($) => $.acceptance_request.unknown_state)}</p>}
      {!header.can_request && !pendingCurrent && !draft.pending && <p role="status" className="text-caption text-muted-foreground">{t(($) => $.acceptance_request.unavailable)}</p>}
      {pendingCurrent && !draft.pending && <div className="space-y-2 rounded-lg bg-muted p-3 text-caption">
        {currentDetail.isError && <CockpitFlowError onRetry={() => void currentDetail.refetch()} />}
        {canReplace ? <label className="flex items-start gap-2"><Checkbox checked={draft.supersedesRequestId === current.id} disabled={locked}
          onCheckedChange={(value) => update({ supersedesRequestId: value === true ? current.id : "" })} />{t(($) => $.acceptance_request.replace_stale)}</label>
          : <p>{t(($) => $.acceptance_request.review_in_progress)}</p>}
        <DialogClose nativeButton={false} role="link" render={<AppLink href={cockpitObjectPath(paths.cockpit(), { kind: "node", id: header.node_id, view: "acceptance", requestId: current.id }, scope)}
          className="text-primary underline underline-offset-4" />}>{t(($) => $.acceptance_request.open_current)}</DialogClose>
      </div>}
      <CockpitReviewerSelect wsId={wsId} value={draft.reviewerId} disabled={locked} onChange={(reviewerId) => update({ reviewerId })} />
      <p className="text-caption text-muted-foreground">{t(($) => $.acceptance_request.limits)}</p>
      <ol className="space-y-4">{definition.items.map((criterion) => <li key={criterion.id} className="space-y-2 rounded-lg border border-border p-3">
        <h3 className="break-words text-caption font-medium">{criterion.title}</h3>{criterion.description && <p className="whitespace-pre-wrap break-words text-caption text-muted-foreground">{criterion.description}</p>}
        {(draft.evidence[criterion.id] ?? []).map((reference) => {
          const query = selectedById.get(reference.artifactId); const artifact = query?.data; const version = approvedAcceptanceEvidence(artifact);
          const ready = !query?.isError && version?.id === reference.versionId;
          return <div key={reference.versionId} className="space-y-1 rounded-md bg-muted p-2 text-caption"><div className="flex items-start gap-2"><p className="min-w-0 flex-1 break-words">{artifact?.title || reference.artifactId}
            <span className="block text-micro text-muted-foreground">{ready ? t(($) => $.workflow.version, { number: version.version_number }) : reference.versionId}</span></p>
            <Button type="button" size="xs" variant="ghost" disabled={locked} aria-label={t(($) => $.acceptance_request.remove_evidence, { title: artifact?.title || reference.artifactId })}
              onClick={() => update({ evidence: { ...draft.evidence, [criterion.id]: (draft.evidence[criterion.id] ?? []).filter((item) => item.versionId !== reference.versionId) } })}>{t(($) => $.acceptance_request.remove)}</Button></div>
            {query?.isPending ? <Spinner /> : !ready && <p role="alert" className="text-destructive">{t(($) => $.acceptance_request.evidence_changed)}</p>}
            {query?.isError && <CockpitFlowError onRetry={() => void query.refetch()} />}
          </div>;
        })}
        <CockpitAcceptanceEvidencePicker key={`${wsId}:${scope.projectId}:${scope.moduleId}:${criterion.id}`} wsId={wsId} scope={scope} criterionTitle={criterion.title} selected={draft.evidence[criterion.id] ?? []} disabled={locked || stale}
          onSelect={(reference) => update({ evidence: { ...draft.evidence, [criterion.id]: [...(draft.evidence[criterion.id] ?? []), reference] } })} />
      </li>)}</ol>
      {(artifactIds.length > 200 || new Set(allVersions).size > 200) && <p role="alert" className="text-caption text-destructive">{t(($) => $.acceptance_request.limits)}</p>}
      <label className="block space-y-1 text-caption"><span>{t(($) => $.acceptance_request.note)}</span><Textarea value={draft.note} rows={3} disabled={locked} onChange={(event) => update({ note: event.target.value })} /></label>
      {!noteValid && <p role="alert" className="text-caption text-destructive">{t(($) => $.acceptance_request.note_limit)}</p>}
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    </div><DialogFooter><DialogClose render={<Button type="button" variant="outline" disabled={create.isPending} />}>{t(($) => $.task_create.cancel)}</DialogClose>
      <Button type="button" disabled={disabled || create.isPending || !valid} aria-busy={create.isPending} onClick={() => void save()}>{create.isPending && <Spinner />}{draft.pending ? t(($) => $.acceptance_request.retry) : t(($) => $.acceptance_request.submit)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
