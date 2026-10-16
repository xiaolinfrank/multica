"use client";
import { useEffect, useRef, useState } from "react";
import { useApplyReviewedCockpitChange, usePreviewCockpitChangeBatch, cockpitSurfacePath, type CockpitScope } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Checkbox } from "@multica/ui/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { AppLink, useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { useCockpitCommandContext } from "./use-cockpit-command-context";

interface CockpitChangeReviewProps {
  wsId: string; scope: CockpitScope; contextKey: string; ids: string[]; canApplyField: (field: string) => boolean; fieldLabel: (field: string) => string;
  onClose: () => void; readOnly?: boolean; beginDecision: () => boolean; endDecision: () => void;
}
export function CockpitChangeReview(props: CockpitChangeReviewProps) {
  return <ChangeReviewSession key={JSON.stringify([props.wsId, props.contextKey, props.ids])} {...props} />;
}
function ChangeReviewSession({ wsId, scope, contextKey, ids, canApplyField, fieldLabel, onClose, readOnly, beginDecision, endDecision }: CockpitChangeReviewProps) {
  const navigation = useNavigation();
  const { t } = useT("cockpit"); const preview = usePreviewCockpitChangeBatch(wsId); const apply = useApplyReviewedCockpitChange(wsId);
  const [requestedIds] = useState(() => [...ids]);
  const captureContext = useCockpitCommandContext(JSON.stringify([wsId, contextKey, requestedIds]));
  const prepare = preview.mutate;
  useEffect(() => { prepare(requestedIds); }, [prepare, requestedIds]);
  const [confirmedOverwrite, setConfirmedOverwrite] = useState(false); const [done, setDone] = useState<string[]>([]);
  const [error, setError] = useState(""); const [stale, setStale] = useState(false); const [working, setWorking] = useState(false); const lock = useRef(false);
  const observations = preview.data ?? [];
  const remaining = observations.filter((item) => !done.includes(item.change.id));
  const outsideScope = (item: (typeof observations)[number]) => Boolean((scope.projectId && item.context.project_id !== scope.projectId) || (scope.moduleId && item.context.module_id !== scope.moduleId));
  const unavailable = remaining.some((item) => item.change.status !== "pending" || !canApplyField(item.change.field) || outsideScope(item));
  const hasConflict = remaining.some((item) => item.conflict);
  const confirm = async () => {
    if (readOnly || lock.current || stale || preview.isPending || unavailable || !remaining.length || (hasConflict && !confirmedOverwrite) || !beginDecision()) return;
    const stillCurrent = captureContext();
    lock.current = true; setWorking(true); setError("");
    try {
      for (const item of remaining) {
        await apply.mutateAsync(item);
        if (!stillCurrent()) return;
        setDone((current) => [...current, item.change.id]);
      }
      if (stillCurrent()) onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed));
      setStale(cause instanceof Error && "status" in cause && cause.status === 409);
    } finally { lock.current = false; setWorking(false); endDecision(); }
  };
  const refresh = () => {
    if (lock.current) return; setError(""); setStale(false); setConfirmedOverwrite(false);
    preview.mutate(requestedIds.filter((id) => !done.includes(id)));
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !lock.current) onClose(); }}><DialogContent className="cockpit-skin cockpit-review-dialog @container/change-review flex max-h-[85vh] flex-col overflow-hidden sm:max-w-5xl" showCloseButton={!working}>
    <DialogHeader><DialogTitle>{t(($) => $.governance.review_title)}</DialogTitle></DialogHeader>
    {preview.isPending ? <div role="status" className="flex items-center gap-2 text-caption"><Spinner />{t(($) => $.governance.loading_preview)}</div>
      : preview.isError ? <div role="alert" className="space-y-2 text-caption text-destructive"><p>{t(($) => $.errors.load_failed)}</p><Button type="button" variant="outline" size="sm" onClick={refresh}>{t(($) => $.binding.retry)}</Button></div>
        : <div className="cockpit-review-observations min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">{observations.map((item) => <section key={item.change.id} className="cockpit-review-observation min-w-0 space-y-3 rounded-xl border border-border bg-card p-4">
          <h3 className="break-words text-body font-semibold">{item.change.node_name} / {fieldLabel(item.change.field)}</h3>
          <p className="text-caption text-muted-foreground break-words">{t(($) => $.governance.current_scope)}: {item.context.project_title || item.context.project_id || t(($) => $.binding.none)}{item.context.module_id ? ` / ${item.context.module_title || item.context.module_id}` : ""}</p>
          {outsideScope(item) && <div role="alert" className="space-y-1 text-caption"><p>{t(($) => $.governance.outside_scope)}</p><AppLink href={cockpitSurfacePath(navigation.pathname, "governance", { projectId: item.context.project_id, moduleId: item.context.module_id }, "changes")} className="text-primary underline">{t(($) => $.governance.open_current_scope)}</AppLink></div>}
          {done.includes(item.change.id) ? <p className="text-caption text-success">{t(($) => $.changes.status_applied)}</p> : <>
            {(item.change.status !== "pending" || !canApplyField(item.change.field)) && <p className="text-caption text-muted-foreground">{t(($) => $.governance.preview_unavailable)}</p>}
            {item.conflict && <p className="text-caption text-warning-foreground">{t(($) => $.governance.conflict)}</p>}
            <dl className="cockpit-review-comparison grid min-w-0 gap-3 @min-[38rem]/change-review:grid-cols-3">{[{ label: t(($) => $.governance.proposed_from), value: item.change.old_value }, { label: t(($) => $.governance.current_value), value: item.current_value }, { label: t(($) => $.governance.proposed_to), value: item.change.new_value }].map((field, index) => <div key={field.label} data-comparison={index === 2 ? "proposed" : index === 1 ? "current" : "original"} className="min-w-0 rounded-lg border border-border bg-muted p-3"><dt className="mb-2 text-caption font-medium text-muted-foreground">{field.label}</dt><dd><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans text-body [overflow-wrap:anywhere]">{field.value || t(($) => $.changes.clear_value)}</pre></dd></div>)}</dl>
            {item.change.reason && <p className="whitespace-pre-wrap break-words text-caption text-muted-foreground">{item.change.reason}</p>}
          </>}
        </section>)}</div>}
    {done.length > 0 && <p role="status" className="text-caption">{t(($) => $.governance.applied_count, { count: done.length })}</p>}
    {unavailable && <p role="alert" className="text-caption text-muted-foreground">{t(($) => $.governance.preview_unavailable)}</p>}
    {hasConflict && !unavailable && <label className="flex items-start gap-2 text-caption"><Checkbox checked={confirmedOverwrite} disabled={working} onCheckedChange={(value) => setConfirmedOverwrite(value === true)} />{t(($) => $.governance.confirm_overwrite)}</label>}
    {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    {stale && <p className="text-caption text-muted-foreground">{t(($) => $.governance.preview_stale)}</p>}
    <DialogFooter className="shrink-0 border-t border-border pt-4"><DialogClose render={<Button type="button" variant="outline" disabled={working} />}>{t(($) => $.binding.cancel)}</DialogClose>
      {(stale || error) && <Button type="button" variant="outline" disabled={working || preview.isPending} onClick={refresh}>{t(($) => $.governance.refresh_preview)}</Button>}
      <Button type="button" disabled={readOnly || working || preview.isPending || preview.isError || stale || unavailable || !remaining.length || (hasConflict && !confirmedOverwrite)} onClick={() => void confirm()}>{working && <Spinner />}{t(($) => $.governance.confirm_reviewed)}</Button>
    </DialogFooter>
  </DialogContent></Dialog>;
}
