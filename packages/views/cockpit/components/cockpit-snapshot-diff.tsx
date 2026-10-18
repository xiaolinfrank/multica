"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cockpitSnapshotDiffOptions } from "@multica/core/cockpit";
import type { CockpitSnapshot, CockpitSnapshotDiffValue } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useLocale, useT } from "../../i18n";
import { CockpitFlowPaging } from "./cockpit-task-flow";

function fieldLabel(t: ReturnType<typeof useT<"cockpit">>["t"], field: string) {
  switch (field) {
    case "name": case "owner": case "collaborators": case "status": case "progress": case "start_date": case "end_date":
    case "current_progress": case "deliverable": case "dependencies": case "note": case "vendor": case "budget_category": case "exec_status": case "contract":
      return t(($) => $.node[field]);
    case "budget_amount": return t(($) => $.node.budget);
    case "code": return t(($) => $.node.stored_code);
    case "title": return t(($) => $.header.title);
    case "goal_title": return t(($) => $.overview.annual_goal);
    case "goal_date": return t(($) => $.overview.target_date);
    case "summary_overall": return t(($) => $.overview.card_overall);
    case "summary_next": return t(($) => $.overview.card_next);
    case "summary_support": return t(($) => $.overview.card_support);
    case "basis": return t(($) => $.snapshot_diff.basis);
    case "condition": return t(($) => $.snapshot_diff.condition);
    case "guard": return t(($) => $.snapshot_diff.guard);
    case "amount": return t(($) => $.payment.amount);
    case "label": return t(($) => $.payment.label);
    case "date": case "pay_date": return t(($) => $.payment.date);
    case "plan_date": return t(($) => $.milestone.plan);
    case "actual_date": return t(($) => $.milestone.actual);
    case "color": return t(($) => $.changes.field_color);
    case "source": return t(($) => $.changes.field_source);
    case "parent_id": return t(($) => $.snapshot_diff.parent);
    case "project_id": return t(($) => $.snapshot_diff.project);
    case "module_id": return t(($) => $.snapshot_diff.module);
    case "node_id": return t(($) => $.snapshot_diff.node);
    case "position": return t(($) => $.snapshot_diff.position);
    default: return field;
  }
}
function DiffValue({ entry }: { entry: CockpitSnapshotDiffValue }) {
  const { t } = useT("cockpit");
  const value = entry.value === null ? t(($) => $.common.unset) : entry.value === "" ? t(($) => $.snapshot_diff.empty_text)
    : typeof entry.value === "boolean" ? entry.value ? t(($) => $.snapshot_diff.yes) : t(($) => $.snapshot_diff.no) : String(entry.value);
  return <div className="min-w-0"><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/60 p-3 text-caption">{value}</pre>
    {entry.truncated && <p className="mt-1 text-micro text-muted-foreground">{t(($) => $.snapshot_diff.truncated)}</p>}</div>;
}

export function CockpitSnapshotDiffDialog({ wsId, snapshot, onClose }: { wsId: string; snapshot: CockpitSnapshot; onClose: () => void }) {
  const { t } = useT("cockpit");
  const locale = useLocale(); const client = useQueryClient();
  const timestamp = (value: string) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? t(($) => $.common.unset) : date.toLocaleString(locale); };
  const [cursors, setCursors] = useState([""]);
  const query = useQuery(cockpitSnapshotDiffOptions(wsId, snapshot.id, cursors.at(-1) || undefined));
  const data = query.data;
  const errorStatus = query.error && "status" in query.error ? query.error.status : undefined;
  const terminalError = errorStatus === 413 || errorStatus === 404;
  const refresh = () => {
    if (cursors.length > 1) {
      // A conflict invalidates the comparison token, even without a realtime event.
      void client.invalidateQueries({ queryKey: cockpitSnapshotDiffOptions(wsId, snapshot.id).queryKey, exact: true, refetchType: "none" });
      setCursors([""]);
    } else void query.refetch();
  };
  const reason = (code: string) => {
    switch (code) {
      case "legacy_identity_missing": return t(($) => $.snapshot_diff.legacy);
      case "unsupported_identity_version": return t(($) => $.snapshot_diff.unsupported);
      case "cockpit_replaced": case "cockpit_missing": return t(($) => $.snapshot_diff.replaced);
      case "incomplete_identity": return t(($) => $.snapshot_diff.incomplete);
      default: return t(($) => $.snapshot_diff.invalid);
    }
  };
  const entityLabel = (kind: string) => {
    switch (kind) {
      case "board": return t(($) => $.snapshot_diff.board);
      case "node": return t(($) => $.snapshot_diff.node);
      case "payment": return t(($) => $.payment.label);
      case "milestone": return t(($) => $.milestone.name);
      default: return t(($) => $.snapshot_diff.unknown);
    }
  };
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-4xl">
    <DialogHeader><DialogTitle>{t(($) => $.snapshot_diff.title)}</DialogTitle></DialogHeader>
    <p className="text-caption text-muted-foreground">{t(($) => $.snapshot_diff.scope)}</p>
    <p className="break-words text-caption">{snapshot.label || t(($) => $.snapshot_diff.before)} · <time dateTime={snapshot.created_at}>{timestamp(snapshot.created_at)}</time></p>
    {query.isPending ? <div role="status" className="flex items-center gap-2 text-caption"><Spinner />{t(($) => $.workflow.loading)}</div>
      : query.isError ? <div role="alert" className="space-y-2 text-caption"><p>{errorStatus === 413 ? t(($) => $.snapshot_diff.limit) : errorStatus === 404 ? t(($) => $.snapshot_diff.missing) : t(($) => $.snapshot_diff.refresh_required)}</p></div>
        : data && !data.comparable ? <p role="status" className="text-caption">{reason(data.reason)}</p>
          : data && <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">{(["added", "removed", "modified", "unchanged"] as const).map((kind) => <div key={kind} className="rounded-lg border border-border p-3"><dt className="text-caption text-muted-foreground">{t(($) => $.snapshot_diff[kind])}</dt><dd className="text-title-sm font-semibold tabular-nums">{data.counts[kind]}</dd></div>)}</dl>
            <p className="text-micro text-muted-foreground">{t(($) => $.snapshot_diff.observed)} <time dateTime={data.generated_at}>{timestamp(data.generated_at)}</time></p>
            <CockpitFlowPaging page={cursors.length} shown={data.items.length} total={data.total} hasNext={Boolean(data.next_cursor)} busy={query.isFetching}
              onPrevious={() => { if (cursors.length > 1) setCursors(cursors.slice(0, -1)); }} onNext={() => { if (data.next_cursor) setCursors([...cursors, data.next_cursor]); }} />
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain">
              {data.total === 0 && <p className="py-4 text-caption text-muted-foreground">{t(($) => $.snapshot_diff.empty)}</p>}
              {data.items.map((item) => <section key={`${item.entity_kind}:${item.id}`} className="space-y-3 rounded-xl border border-border p-4">
                <h3 className="break-words text-body font-medium">{entityLabel(item.entity_kind)} · {item.code} {item.name}</h3>
                <p className="text-caption text-muted-foreground">{t(($) => $.snapshot_diff[item.change])}</p>
                {item.field_changes.map((field) => <div key={field.field} className="space-y-2"><h4 className="text-caption font-medium">{fieldLabel(t, field.field)}</h4>
                  <dl className="grid min-w-0 gap-3 sm:grid-cols-2"><div className="min-w-0"><dt className="mb-1 text-micro text-muted-foreground">{t(($) => $.snapshot_diff.before)}</dt><dd><DiffValue entry={field.before} /></dd></div>
                    <div className="min-w-0"><dt className="mb-1 text-micro text-muted-foreground">{t(($) => $.snapshot_diff.after)}</dt><dd><DiffValue entry={field.after} /></dd></div></dl>
                </div>)}
              </section>)}
            </div>
          </>}
    <DialogFooter>{!terminalError && (data?.comparable || query.isError) && <Button type="button" variant="outline" disabled={query.isFetching} onClick={refresh}>{t(($) => $.snapshot_diff.refresh)}</Button>}<DialogClose render={<Button type="button" variant="outline" />}>{t(($) => $.panel.close)}</DialogClose></DialogFooter>
  </DialogContent></Dialog>;
}
