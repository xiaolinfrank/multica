"use client";

// The pending-change review queue.
//
// Everything on this screen is a proposal, not board state: a field edit an
// agent reported back, or one a person filed by hand, waiting for a human to
// apply or reject it. The board only moves on apply — and the human entry
// form exists so the queue can be fed long before any automated writer is
// wired up.
//
// None of the writes are optimistic, by the state rules: filing may not even
// enter the queue (the server judges no-change and duplicates), and a
// decision either moves board data or removes a row the reviewer is looking
// at.

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CockpitPendingChange } from "@multica/core/types";
import {
  cockpitChangePageOptions, cockpitNodeIndexOptions, buildCockpitDisplayCodesFromIndex, cockpitNodeDetailOptions, cockpitScopeViewKey,
  useCockpitScopeViewStore, EMPTY_COCKPIT_GOVERNANCE_CONTEXT,
  useCockpitChangeDraftStore, EMPTY_COCKPIT_CHANGE_DRAFT, setCockpitChangeDraft, acknowledgeCockpitChangeDraft, type CockpitScope,
  useCreateCockpitChange,
  useRejectCockpitChange,
  useWithdrawCockpitChange,
} from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Textarea } from "@multica/ui/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { Eye, Crosshair, Undo2, X, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { useTimeAgo } from "../../i18n/use-time-ago";
import { CockpitNodeChoicePicker } from "./cockpit-node-choice";
import { useCockpitScrollMemory } from "./use-cockpit-scroll-memory";
import { CockpitChangeReview } from "./cockpit-change-review";
import { CockpitPlanQuality } from "./cockpit-plan-quality";
import { CockpitFlowError, CockpitFlowPaging, useCockpitSearch } from "./cockpit-task-flow";
import { SegmentedToggle } from "../../common/segmented-toggle";

/** The proposable fields, in the order a reviewer scans them. Mirrors the
 * server's field table in cockpit_changes.go; tree-shape fields are absent
 * there on purpose and must stay absent here too. */
const CHANGE_FIELDS = [
  "name",
  "owner",
  "collaborators",
  "status",
  "progress",
  "start_date",
  "end_date",
  "current_progress",
  "deliverable",
  "dependencies",
  "note",
  "vendor",
  "budget_category",
  "budget_amount",
  "exec_status",
  "contract",
  "color",
  "source",
] as const;


function fieldLabel(
  t: ReturnType<typeof useT<"cockpit">>["t"],
  field: string,
): string {
  // Most labels already exist in the node panel's vocabulary; the two that
  // don't live in the changes section.
  switch (field) {
    case "name":
    case "owner":
    case "collaborators":
    case "status":
    case "progress":
    case "start_date":
    case "end_date":
    case "current_progress":
    case "deliverable":
    case "dependencies":
    case "note":
    case "vendor":
    case "budget_category":
    case "exec_status":
    case "contract":
      return t(($) => $.node[field]);
    case "budget_amount":
      return t(($) => $.node.budget);
    case "color":
      return t(($) => $.changes.field_color);
    case "source":
      return t(($) => $.changes.field_source);
    default:
      // Server-driven value; an unknown field still renders, as a literal.
      return field;
  }
}

/** "40" reads as a value; "" reads as "clears the field", and a reviewer must
 * see that distinction before clicking apply. */
function valueLabel(
  t: ReturnType<typeof useT<"cockpit">>["t"],
  value: string,
): string {
  return value === "" ? t(($) => $.changes.clear_value) : value;
}

function changeType(change: CockpitPendingChange) {
  return change.new_value === "" ? "type_clear" : change.old_value === "" ? "type_add" : "type_modify";
}

function sourceBadgeClass(source: string): string {
  // An agent's proposal carries different trust than a colleague's note;
  // give it the accent family so the badge does the introducing.
  return source === "agent"
    ? "bg-accent text-accent-foreground"
    : "bg-muted text-muted-foreground";
}

function decidedBadgeClass(status: string): string {
  switch (status) {
    case "applied":
      return "bg-success/10 text-success";
    case "rejected":
      return "bg-destructive/10 text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function decidedLabel(
  t: ReturnType<typeof useT<"cockpit">>["t"],
  status: string,
): string {
  switch (status) {
    case "applied":
      return t(($) => $.changes.status_applied);
    case "rejected":
      return t(($) => $.changes.status_rejected);
    case "withdrawn":
      return t(($) => $.changes.status_withdrawn);
    default:
      return status;
  }
}

function ChangeRow({
  wsId,
  change,
  onOpenTask,
  onError,
  batchBusy, readOnly, onReview,
  beginDecision,
  endDecision,
}: {
  batchBusy: boolean; readOnly?: boolean; onReview: (id: string) => void;
  beginDecision: () => boolean;
  endDecision: () => void;
  wsId: string;
  change: CockpitPendingChange;
  onOpenTask: (nodeId: string) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useT("cockpit");
  const timeAgo = useTimeAgo();
  const reject = useRejectCockpitChange(wsId);
  const withdraw = useWithdrawCockpitChange(wsId);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const paths = useWorkspacePaths();
  const busy = readOnly || !CHANGE_FIELDS.some((field) => field === change.field) || batchBusy || reject.isPending || withdraw.isPending;

  // Structural on purpose: the three decision hooks return different result
  // shapes, and the row only needs "run it and tell me".
  const decide = (
    run: {
      mutate: (
        id: string,
        options?: { onSuccess?: () => void; onError?: (error: unknown) => void },
      ) => void;
    },
    ok: string,
  ) => {
    if (busy || !beginDecision()) return;
    run.mutate(change.id, {
      onSuccess: () => { endDecision(); toast.success(ok); },
      onError: (error) => { endDecision(); onError(error); },
    });
  };

  // Rejection is a one-way door with a receipt attached, so it earns one
  // confirmation step — and the optional reason travels to the task that
  // filed the proposal.
  const confirmReject = () => {
    if (busy || !beginDecision()) return;
    const note = rejectNote.trim();
    reject.mutate({ id: change.id, note: note === "" ? undefined : note }, {
      onSuccess: () => { endDecision(); setRejectOpen(false); setRejectNote(""); toast.success(t(($) => $.changes.reject_done)); },
      onError: (error) => { endDecision(); onError(error); },
    });
  };

  const code =
    change.node_code !== "" ? (
      <button
        type="button"
        className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-micro text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        onClick={() => onOpenTask(change.node_id)}
        aria-label={t(($) => $.changes.locate, { code: change.node_code })}
      >
        {change.node_code}
      </button>
    ) : (
      <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-micro text-faint-foreground">
        {t(($) => $.changes.node_gone)}
      </span>
    );

  return (
    <li className="cockpit-review-card min-w-0 rounded-xl border border-border bg-card p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-caption">
        <div className="cockpit-review-identity flex w-full min-w-0 items-start gap-2">
          {code}
          <h3 className="min-w-0 flex-1 break-words text-body font-semibold [overflow-wrap:anywhere]">{change.node_name}</h3>
        </div>
        <span className="max-w-full break-words [overflow-wrap:anywhere]">{fieldLabel(t, change.field)}</span>
        <span className="rounded-full border border-border px-1.5 py-0.5 text-micro">
          {t(($) => $.changes[changeType(change)])}
        </span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-micro ${sourceBadgeClass(change.source)}`}
        >
          {change.source === "agent"
            ? t(($) => $.changes.source_agent)
            : t(($) => $.changes.source_manual)}
        </span>
        {change.source_issue && (
          <AppLink
            href={paths.issueDetail(change.source_issue.id)}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-micro text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title={`${change.source_issue.ref} ${change.source_issue.title}`}
          >
            {change.source_issue.ref}
          </AppLink>
        )}
        <span className="ml-auto max-w-full break-words text-caption text-muted-foreground">
          {change.created_by_label || t(($) => $.changes.by_unknown)} ·{" "}
          {timeAgo(change.created_at)}
        </span>
      </div>
      <dl className="mt-3 grid min-w-0 gap-3 @min-[32rem]/governance:grid-cols-2">
        <div className="min-w-0 rounded-lg border border-border bg-muted p-3">
          <dt className="mb-1 text-caption text-muted-foreground">{t(($) => $.governance.proposed_from)}</dt>
          <dd className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-body text-muted-foreground [overflow-wrap:anywhere]">{valueLabel(t, change.old_value)}</dd>
        </div>
        <div className="min-w-0 rounded-lg border border-border bg-background p-3">
          <dt className="mb-1 text-caption text-muted-foreground">{t(($) => $.governance.proposed_to)}</dt>
          <dd className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-body font-semibold [overflow-wrap:anywhere]">{valueLabel(t, change.new_value)}</dd>
        </div>
      </dl>
      {change.reason !== "" && (
        <p className="mt-3 line-clamp-2 break-words text-caption text-muted-foreground">{change.reason}</p>
      )}
      {(change.old_value.length > 120 || change.new_value.length > 120 || change.reason.length > 200) && <details className="mt-2 text-caption"><summary className="cursor-pointer text-primary">{t(($) => $.governance.read_change)}</summary><div className="mt-2 max-h-80 space-y-3 overflow-auto rounded bg-muted p-3"><pre className="whitespace-pre-wrap break-words">{change.old_value}</pre><p>↓</p><pre className="whitespace-pre-wrap break-words">{change.new_value}</pre>{change.reason && <p className="whitespace-pre-wrap break-words">{change.reason}</p>}</div></details>}
      {!CHANGE_FIELDS.some((field) => field === change.field) && <p className="mt-2 text-caption text-muted-foreground">{t(($) => $.governance.unsupported_field)}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => decide(withdraw, t(($) => $.changes.withdraw_done))}
        >
          <Undo2 className="size-3.5" aria-hidden />
          {t(($) => $.changes.withdraw)}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => setRejectOpen(true)}
        >
          <X className="size-3.5" aria-hidden />
          {t(($) => $.changes.reject)}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => onReview(change.id)}
        >
          <Eye className="size-3.5" aria-hidden />
          {t(($) => $.governance.review_single)}
        </Button>
      </div>
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t(($) => $.governance.reject_title, { name: change.node_name })}</DialogTitle>
          </DialogHeader>
          <p className="text-caption text-muted-foreground">
            {fieldLabel(t, change.field)}: {valueLabel(t, change.old_value)} → {valueLabel(t, change.new_value)}
          </p>
          <Textarea
            value={rejectNote}
            onChange={(event) => setRejectNote(event.target.value)}
            placeholder={t(($) => $.governance.reject_note_placeholder)}
            maxLength={500}
            rows={3}
            disabled={reject.isPending}
          />
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={reject.isPending} />}>{t(($) => $.binding.cancel)}</DialogClose>
            <Button
              type="button"
              variant="outline"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={confirmReject}
            >
              {reject.isPending && <Spinner />}
              {t(($) => $.changes.reject)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function DecidedRow({ change }: { change: CockpitPendingChange }) {
  const { t } = useT("cockpit");
  const timeAgo = useTimeAgo();
  const paths = useWorkspacePaths();
  // System withdrawals (node deleted, board replaced) carry no human name;
  // rendering the raw "system" string would read like a missing translation.
  const decider = change.decided_by_type === "system"
    ? t(($) => $.changes.by_system)
    : change.decided_by_label || t(($) => $.changes.by_unknown);
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 text-caption">
      <span
        className={`shrink-0 rounded-full px-1.5 py-0.5 text-micro ${decidedBadgeClass(change.status)}`}
      >
        {decidedLabel(t, change.status)}
      </span>
      <span className="shrink-0 font-mono text-micro text-muted-foreground">
        {change.node_code || t(($) => $.changes.node_gone)}
      </span>
      <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
        {fieldLabel(t, change.field)}: {valueLabel(t, change.old_value)} →{" "}
        {valueLabel(t, change.new_value)}
      </span>
      {change.source_issue && (
        <AppLink
          href={paths.issueDetail(change.source_issue.id)}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-micro text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          title={change.source_issue.title}
        >
          {change.source_issue.ref}
        </AppLink>
      )}
      {change.decision_note !== "" && (
        <span className="w-full break-words text-caption text-muted-foreground [overflow-wrap:anywhere]">
          {change.decision_note}
        </span>
      )}
      <span className="ml-auto max-w-full break-words text-caption text-muted-foreground">
        {decider} · {timeAgo(change.decided_at ?? change.updated_at)}
      </span>
    </li>
  );
}

/** The human entry: file one proposal through the same funnel agents will
 * use. Values are text; the server canonicalises and judges them the same
 * way it judges every other source. */
function FileChangeForm({ wsId, scope, onError, readOnly }: { wsId: string; scope: CockpitScope; onError: (error: unknown) => void; readOnly?: boolean }) {
  const { t } = useT("cockpit");
  const key = cockpitScopeViewKey(wsId, scope);
  const draft = useCockpitChangeDraftStore((state) => state.draft.byScope[key] ?? EMPTY_COCKPIT_CHANGE_DRAFT);
  const { nodeId: nodeRef, field, value, reason } = draft;
  const update = (patch: Partial<typeof draft>) => setCockpitChangeDraft(key, { ...draft, ...patch });
  const selected = useQuery({ ...cockpitNodeDetailOptions(wsId, nodeRef, scope), enabled: Boolean(nodeRef) });
  const file = useCreateCockpitChange(wsId); const [error, setError] = useState("");
  const canSubmit = !readOnly && nodeRef !== "" && selected.data?.scope_match === true && !selected.isError && !selected.isFetching && !file.isPending && CHANGE_FIELDS.some((key) => key === field);

  const submit = () => {
    setError("");
    const observed = { ...draft };
    file.mutate(
      { node: nodeRef, field, new_value: value, reason: reason.trim() || undefined },
      {
        onSuccess: (outcome) => {
          // A filed change answers a row with a real id; a skip answers an
          // ingest outcome whose id is null or empty.
          if ("id" in outcome && outcome.id !== null && outcome.id !== "") {
            toast.success(t(($) => $.changes.filed));
            acknowledgeCockpitChangeDraft(key, observed);
            return;
          }
          // The skipped answer: the board already says this, or the queue
          // already proposes it. Nothing was filed, and the reader should
          // hear why in one line.
          const skipped = "reason" in outcome ? outcome.reason : undefined;
          if (skipped === "duplicate" || skipped === "no_change") toast.info(skipped === "duplicate" ? t(($) => $.changes.skipped_duplicate) : t(($) => $.changes.skipped_no_change));
          else setError(t(($) => $.workflow.unconfirmed));
        },
        onError: (cause) => { setError(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed)); onError(cause); },
      },
    );
  };

  return (
    <form
      className="cockpit-proposal-form min-w-0 rounded-xl border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) submit();
      }}
    >
      <p className="text-title-sm font-semibold">{t(($) => $.changes.form_title)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <CockpitNodeChoicePicker wsId={wsId} scope={scope} eligible={false} label={t(($) => $.changes.form_node)}
          value={selected.data ? `${buildCockpitDisplayCodesFromIndex(selected.data.node_index).get(selected.data.node.id) ?? selected.data.node.code} ${selected.data.node.name}` : nodeRef} disabled={readOnly || file.isPending} onSelect={(node) => update({ nodeId: node.id })} />
        <Select
          items={CHANGE_FIELDS.map((key) => ({ value: key, label: fieldLabel(t, key) }))}
          value={field}
          disabled={readOnly || file.isPending}
          onValueChange={(v) => { if (CHANGE_FIELDS.some((key) => key === v)) update({ field: v ?? "status" }); }}
        >
          <SelectTrigger className="w-44 max-w-full" aria-label={t(($) => $.changes.form_field)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHANGE_FIELDS.map((key) => (
              <SelectItem key={key} value={key}>
                {fieldLabel(t, key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={value}
          disabled={readOnly || file.isPending}
          onChange={(e) => update({ value: e.target.value })}
          placeholder={t(($) => $.changes.form_value)}
          aria-label={t(($) => $.changes.form_value)}
          className="w-52 max-w-full"
        />
        {field === "budget_amount" && <p className="text-caption text-muted-foreground">{t(($) => $.governance.budget_precision)}</p>}
        <Input
          value={reason}
          disabled={readOnly || file.isPending}
          onChange={(e) => update({ reason: e.target.value })}
          placeholder={t(($) => $.changes.form_reason)}
          aria-label={t(($) => $.changes.form_reason)}
          className="min-w-0 flex-1 basis-48"
        />
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {file.isPending ? <Spinner className="size-3.5" /> : null}
          {t(($) => $.changes.form_submit)}
        </Button>
      </div>
      {selected.isError && <CockpitFlowError onRetry={() => void selected.refetch()} />}{error && <p role="alert" className="mt-2 text-caption text-destructive">{error}</p>}
      <p className="mt-3 text-caption text-muted-foreground">{t(($) => $.changes.form_hint)}</p>
    </form>
  );
}

export function CockpitChanges({ wsId, scope, onOpenTask, readOnly }: { wsId: string; scope: CockpitScope; onOpenTask: (id: string) => void; readOnly?: boolean }) {
  const { t } = useT("cockpit");
  const viewKey = cockpitScopeViewKey(wsId, scope);
  const view = useCockpitScopeViewStore((state) => state.governance[viewKey] ?? EMPTY_COCKPIT_GOVERNANCE_CONTEXT);
  const { query: text, status, cursors, qualityOpen: showQuality } = view;
  const update = (patch: Partial<typeof view>) => useCockpitScopeViewStore.getState().updateGovernance(viewKey, patch);
  const setText = (query: string) => update({ query }); const setStatus = (status: typeof view.status) => update({ status }); const setCursors = (cursors: string[]) => update({ cursors }); const setShowQuality = (qualityOpen: boolean) => update({ qualityOpen });
  const [reviewIds, setReviewIds] = useState<string[] | null>(null), [batchBusy, setBatchBusy] = useState(false);
  const batchLock = useRef(false); const q = useCockpitSearch(text); const searching = text.trim() !== q;
  const query = useQuery({ ...cockpitChangePageOptions(wsId, scope, { status, q, cursor: cursors.at(-1) || undefined, page_size: 25 }), enabled: Boolean(wsId && !searching) });
  const index = useQuery(cockpitNodeIndexOptions(wsId));
  const codes = useMemo(() => buildCockpitDisplayCodesFromIndex(index.data?.items ?? []), [index.data]);
  const page = query.data;
  const rows = useMemo(() => (page?.items ?? []).map((change) => ({ ...change, node_code: codes.get(change.node_id) ?? change.node_code })), [page, codes]);
  const listRef = useRef<HTMLUListElement>(null);
  useCockpitScrollMemory(listRef, JSON.stringify([viewKey, "changes", cursors.at(-1)]), rows.length > 0, JSON.stringify([q, status]));
  const pending = rows.filter((change) => change.status === "pending" && CHANGE_FIELDS.some((field) => field === change.field));
  const onError = (cause: unknown) => toast.error(cause instanceof Error ? cause.message : t(($) => $.errors.save_failed));
  const beginDecision = () => { if (readOnly || batchLock.current) return false; batchLock.current = true; setBatchBusy(true); return true; };
  const endDecision = () => { batchLock.current = false; setBatchBusy(false); };
  return <section className="cockpit-governance @container/governance mx-auto flex min-h-0 min-w-0 w-full max-w-[1480px] flex-1 flex-col gap-4 overflow-y-auto p-4 lg:p-6" aria-label={t(($) => $.shell.governance)}>
    <header className="cockpit-governance-heading">
      <div className="flex min-w-0 items-center gap-4"><span className="cockpit-page-symbol" aria-hidden><ShieldCheck className="size-6" /></span><h2 className="text-display-sm font-semibold tracking-tight">{t(($) => $.shell.governance)}</h2></div>
      {page && <div className="cockpit-governance-counts">
        <Button type="button" variant="ghost" aria-pressed={status === "pending"} onClick={() => setStatus("pending")} className="cockpit-governance-count h-auto"><span className="text-display-sm font-semibold tabular-nums">{page.counts.pending}</span><span className="text-caption">{t(($) => $.governance.pending)}</span></Button>
        <Button type="button" variant="ghost" aria-pressed={status === "decided"} onClick={() => setStatus("decided")} className="cockpit-governance-count h-auto"><span className="text-display-sm font-semibold tabular-nums">{page.counts.decided}</span><span className="text-caption">{t(($) => $.governance.decided)}</span></Button>
      </div>}
    </header>
    <div className="cockpit-governance-layout"><div className="cockpit-review-queue flex min-w-0 flex-col gap-4">
    <div className="flex min-w-0 flex-wrap items-center gap-3"><Input className="min-w-0 flex-1 basis-48 sm:max-w-80" name="cockpit-change-search" autoComplete="off" spellCheck={false} value={text} aria-label={t(($) => $.governance.search)} placeholder={t(($) => $.governance.search)} onChange={(event) => setText(event.target.value)} />
      <div role="group" aria-label={t(($) => $.governance.status)} className="max-w-full overflow-x-auto"><SegmentedToggle value={status} options={(["pending", "decided", "all"] as const).map((value) => [value, value === "pending" ? t(($) => $.governance.pending) : value === "decided" ? t(($) => $.governance.decided) : t(($) => $.assignee_picker.all)] as const)} onChange={setStatus}
        buttonClassName="min-h-8 whitespace-nowrap rounded-md px-3 py-1.5 text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" /></div>
    </div>
    {page && <p className="flex flex-wrap gap-x-4 gap-y-1 text-caption tabular-nums text-muted-foreground">{t(($) => $.governance.page_counts)}: {(["type_add", "type_modify", "type_clear"] as const).map((type) => <span key={type}>{t(($) => $.changes[type])} {pending.filter((change) => changeType(change) === type).length}</span>)}</p>}
    {page ? <CockpitFlowPaging page={cursors.length} shown={page.items.length} total={page.total} hasNext={Boolean(page.next_cursor)} busy={query.isFetching || searching || batchBusy}
      onPrevious={() => setCursors(cursors.slice(0, -1))} onNext={() => { if (page.next_cursor) setCursors([...cursors, page.next_cursor]); }} />
      : cursors.length > 1 && <Button type="button" variant="outline" size="sm" onClick={() => setCursors(cursors.slice(0, -1))}>{t(($) => $.task_flow.previous)}</Button>}
    {query.isError ? <CockpitFlowError onRetry={() => void query.refetch()} /> : query.isPending || searching ? <Spinner />
      : page && <><Button type="button" className="self-end" size="sm" disabled={readOnly || batchBusy || query.isFetching || !pending.length} onClick={() => setReviewIds([...pending].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id)).map((change) => change.id))}>{t(($) => $.governance.review_page)}</Button>
        {rows.length === 0 ? <p className="rounded-xl border border-dashed p-6 text-caption text-muted-foreground">{q ? t(($) => $.task_flow.no_matches) : t(($) => $.changes.queue_empty)}</p>
          : <ul ref={listRef} className="min-w-0 max-h-[60vh] space-y-3 overflow-y-auto overscroll-contain">{rows.map((change) => change.status === "pending"
            ? <ChangeRow key={change.id} wsId={wsId} change={change} readOnly={readOnly} batchBusy={batchBusy || query.isFetching} beginDecision={beginDecision} endDecision={endDecision} onOpenTask={onOpenTask} onError={onError} onReview={(id) => setReviewIds([id])} />
            : <DecidedRow key={change.id} change={change} />)}</ul>}
      </>}
    </div><aside className="cockpit-proposal-rail min-w-0 space-y-4">
    <FileChangeForm wsId={wsId} scope={scope} readOnly={readOnly} onError={onError} />
    <div><Button type="button" variant="outline" size="sm" aria-expanded={showQuality} onClick={() => setShowQuality(!showQuality)}>{t(($) => $.governance.quality)}</Button></div>
    {showQuality && <CockpitPlanQuality wsId={wsId} scope={scope} onOpenTask={onOpenTask} />}
    </aside></div>
    {reviewIds && <CockpitChangeReview key={JSON.stringify([wsId, viewKey, reviewIds])} contextKey={viewKey} wsId={wsId} scope={scope} ids={reviewIds} readOnly={readOnly} canApplyField={(field) => CHANGE_FIELDS.some((key) => key === field)} fieldLabel={(field) => fieldLabel(t, field)} beginDecision={beginDecision} endDecision={endDecision} onClose={() => setReviewIds(null)} />}
    <p className="flex items-center gap-1.5 text-caption text-muted-foreground"><Crosshair className="size-3" aria-hidden />{t(($) => $.changes.locate_hint)}</p>
  </section>;
}
