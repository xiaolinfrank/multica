"use client";
import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@multica/core/api";
import { buildCockpitDisplayCodesFromIndex, cockpitScopeViewKey, cockpitNodeDetailOptions, cockpitSurfacePath, useCreateCockpitMilestone, useCockpitMilestoneDraftStore, setCockpitMilestoneDraft, settleCockpitMilestoneDraft, type CockpitScope } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { CockpitNodeChoicePicker } from "./cockpit-node-choice";
import { CockpitFlowError } from "./cockpit-task-flow";
import { useCockpitCommandContext } from "./use-cockpit-command-context";

export function CockpitMilestoneCreate({ wsId, scope, open, onOpenChange, initialNodeId, disabled }: {
  wsId: string; scope: CockpitScope; open: boolean; onOpenChange: (open: boolean) => void; initialNodeId: string | null; disabled: boolean;
}) {
  const { t } = useT("cockpit"); const navigation = useNavigation(); const key = cockpitScopeViewKey(wsId, scope);
  const empty = useMemo(() => ({ name: "", date: "", nodeId: initialNodeId ?? "", uncertain: false }), [initialNodeId]);
  const draft = useCockpitMilestoneDraftStore((state) => state.draft.byScope[key] ?? empty);
  const change = (patch: Partial<typeof draft>) => { if (!draft.uncertain) setCockpitMilestoneDraft(key, { ...draft, ...patch }); };
  const chosen = useQuery({ ...cockpitNodeDetailOptions(wsId, draft.nodeId, scope), enabled: Boolean(open && draft.nodeId) });
  const scoped = Boolean(scope.projectId || scope.moduleId);
  const valid = !draft.nodeId ? !scoped : Boolean(chosen.data?.scope_match) && !chosen.isError && !chosen.isFetching;
  const create = useCreateCockpitMilestone(wsId); const lock = useRef(false); const [error, setError] = useState("");
  const captureContext = useCockpitCommandContext(key);
  const save = async () => {
    if (lock.current || disabled || !valid || !draft.name.trim() || draft.uncertain) return;
    const observed = { ...draft }; setCockpitMilestoneDraft(key, observed); const stillCurrent = captureContext(); lock.current = true; setError("");
    try {
      const saved = await create.mutateAsync({ name: draft.name.trim(), node_id: draft.nodeId || null, plan_date: draft.date || null, status: "" });
      if (!saved.id || saved.name !== draft.name.trim() || saved.node_id !== (draft.nodeId || null) || saved.plan_date !== (draft.date || null)) throw new Error(t(($) => $.workflow.unconfirmed));
      settleCockpitMilestoneDraft(key, observed, "accepted"); if (stillCurrent()) onOpenChange(false);
    } catch (cause) {
      if (!(cause instanceof ApiError && [400, 403, 404, 409, 422].includes(cause.status))) settleCockpitMilestoneDraft(key, observed, "uncertain");
      if (stillCurrent()) setError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed));
    } finally { lock.current = false; }
  };
  return <Dialog open={open} onOpenChange={(next) => { if (!lock.current) onOpenChange(next); }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{t(($) => $.overview.add_milestone)}</DialogTitle></DialogHeader>
    <label className="space-y-1 text-caption">{t(($) => $.milestone.name)}<Input value={draft.name} disabled={disabled || create.isPending || draft.uncertain} onChange={(event) => change({ name: event.target.value })} /></label>
    <label className="space-y-1 text-caption">{t(($) => $.overview.milestone_plan_date)}<Input type="date" value={draft.date} disabled={disabled || create.isPending || draft.uncertain} onChange={(event) => change({ date: event.target.value })} /></label>
    <CockpitNodeChoicePicker wsId={wsId} scope={scope} eligible={false} label={t(($) => $.plan_views.item)} value={chosen.data ? `${buildCockpitDisplayCodesFromIndex(chosen.data.node_index).get(chosen.data.node.id) ?? chosen.data.node.code} ${chosen.data.node.name}` : draft.nodeId}
      disabled={disabled || create.isPending || draft.uncertain} allowClear={!scoped} onClear={() => change({ nodeId: "" })} onSelect={(node) => change({ nodeId: node.id })} />
    {scoped && !draft.nodeId && <p className="text-caption text-muted-foreground">{t(($) => $.milestone_create.anchor_required)}</p>}
    {chosen.isError && <CockpitFlowError onRetry={() => void chosen.refetch()} />}
    {chosen.data && !chosen.data.scope_match && <p role="alert" className="text-caption text-destructive">{t(($) => $.shell.scope_outside)}</p>}
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    {draft.uncertain && <div className="space-y-2 text-caption"><p>{t(($) => $.milestone_create.unknown_result)}</p><AppLink target="_blank" rel="noreferrer" href={cockpitSurfacePath(navigation.pathname, "plan", scope, "milestones")} className="text-primary underline">{t(($) => $.milestone_create.inspect)}</AppLink>
      <Button type="button" variant="ghost" size="sm" onClick={() => { settleCockpitMilestoneDraft(key, draft, "discarded"); onOpenChange(false); }}>{t(($) => $.plan_structure.discard_draft)}</Button></div>}
    <DialogFooter><DialogClose render={<Button type="button" variant="outline" disabled={create.isPending} />}>{t(($) => $.binding.cancel)}</DialogClose><Button type="button" disabled={disabled || create.isPending || draft.uncertain || !valid || !draft.name.trim()} onClick={() => void save()}>{create.isPending && <Spinner />}{t(($) => $.overview.add_milestone)}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
