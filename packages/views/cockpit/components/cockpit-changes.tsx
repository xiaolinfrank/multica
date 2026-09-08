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

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CockpitNode, CockpitPendingChange } from "@multica/core/types";
import {
  cockpitChangesOptions,
  useApplyCockpitChange,
  useCreateCockpitChange,
  useRejectCockpitChange,
  useWithdrawCockpitChange,
} from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Spinner } from "@multica/ui/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { Check, ChevronDown, ChevronUp, Crosshair, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { useTimeAgo } from "../../i18n/use-time-ago";

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

type ChangeField = (typeof CHANGE_FIELDS)[number];

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
}: {
  wsId: string;
  change: CockpitPendingChange;
  onOpenTask: (nodeId: string) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useT("cockpit");
  const timeAgo = useTimeAgo();
  const apply = useApplyCockpitChange(wsId);
  const reject = useRejectCockpitChange(wsId);
  const withdraw = useWithdrawCockpitChange(wsId);
  const busy = apply.isPending || reject.isPending || withdraw.isPending;

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
  ) =>
    run.mutate(change.id, {
      onSuccess: () => toast.success(ok),
      onError,
    });

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
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex min-w-0 items-center gap-2 text-caption">
        {code}
        <span className="min-w-0 truncate font-medium">{change.node_name}</span>
        <span aria-hidden className="text-faint-foreground">
          ·
        </span>
        <span className="shrink-0">{fieldLabel(t, change.field)}</span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-micro ${sourceBadgeClass(change.source)}`}
        >
          {change.source === "agent"
            ? t(($) => $.changes.source_agent)
            : t(($) => $.changes.source_manual)}
        </span>
        <span className="ml-auto shrink-0 text-micro text-faint-foreground">
          {change.created_by_label || t(($) => $.changes.by_unknown)} ·{" "}
          {timeAgo(change.created_at)}
        </span>
      </div>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-baseline gap-x-2 text-body">
        <span className="min-w-0 truncate text-muted-foreground line-through decoration-faint-foreground/70">
          {valueLabel(t, change.old_value)}
        </span>
        <span aria-hidden className="text-faint-foreground">
          →
        </span>
        <span className="min-w-0 truncate font-medium">{valueLabel(t, change.new_value)}</span>
      </div>
      {change.reason !== "" && (
        <p className="mt-1 text-caption text-muted-foreground">{change.reason}</p>
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-caption"
          disabled={busy}
          onClick={() => decide(withdraw, t(($) => $.changes.withdraw_done))}
        >
          <Undo2 className="size-3.5" aria-hidden />
          {t(($) => $.changes.withdraw)}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 px-2 text-caption text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => decide(reject, t(($) => $.changes.reject_done))}
        >
          <X className="size-3.5" aria-hidden />
          {t(($) => $.changes.reject)}
        </Button>
        <Button
          size="sm"
          className="h-7 gap-1 px-2.5 text-caption"
          disabled={busy}
          onClick={() => decide(apply, t(($) => $.changes.apply_done))}
        >
          {apply.isPending ? <Spinner className="size-3" /> : <Check className="size-3.5" aria-hidden />}
          {t(($) => $.changes.apply)}
        </Button>
      </div>
    </li>
  );
}

function DecidedRow({ change }: { change: CockpitPendingChange }) {
  const { t } = useT("cockpit");
  const timeAgo = useTimeAgo();
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-2 px-2 py-1.5 text-caption">
      <span
        className={`shrink-0 rounded-full px-1.5 py-0.5 text-micro ${decidedBadgeClass(change.status)}`}
      >
        {decidedLabel(t, change.status)}
      </span>
      <span className="shrink-0 font-mono text-micro text-muted-foreground">
        {change.node_code || t(($) => $.changes.node_gone)}
      </span>
      <span className="min-w-0 truncate">
        {fieldLabel(t, change.field)}: {valueLabel(t, change.old_value)} →{" "}
        {valueLabel(t, change.new_value)}
      </span>
      <span className="ml-auto shrink-0 text-micro text-faint-foreground">
        {change.decided_by_label || t(($) => $.changes.by_unknown)} ·{" "}
        {timeAgo(change.decided_at ?? change.updated_at)}
      </span>
    </li>
  );
}

/** The human entry: file one proposal through the same funnel agents will
 * use. Values are text; the server canonicalises and judges them the same
 * way it judges every other source. */
function FileChangeForm({
  wsId,
  nodes,
  onError,
}: {
  wsId: string;
  nodes: CockpitNode[];
  onError: (error: unknown) => void;
}) {
  const { t } = useT("cockpit");
  const [nodeRef, setNodeRef] = useState("");
  const [field, setField] = useState<ChangeField>("status");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const file = useCreateCockpitChange(wsId);

  const canSubmit = nodeRef !== "" && !file.isPending;

  const submit = () => {
    file.mutate(
      { node: nodeRef, field, new_value: value, reason: reason.trim() || undefined },
      {
        onSuccess: (outcome) => {
          // A filed change answers a row with a real id; a skip answers an
          // ingest outcome whose id is null or empty.
          if ("id" in outcome && outcome.id !== null && outcome.id !== "") {
            toast.success(t(($) => $.changes.filed));
            setValue("");
            setReason("");
            return;
          }
          // The skipped answer: the board already says this, or the queue
          // already proposes it. Nothing was filed, and the reader should
          // hear why in one line.
          const skipped = outcome as { reason?: string };
          toast.info(
            skipped.reason === "duplicate"
              ? t(($) => $.changes.skipped_duplicate)
              : t(($) => $.changes.skipped_no_change),
          );
        },
        onError,
      },
    );
  };

  return (
    <form
      className="rounded-lg border border-border bg-card p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) submit();
      }}
    >
      <p className="text-caption font-medium">{t(($) => $.changes.form_title)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select
          items={nodes.map((node) => ({
            value: node.id,
            label: `${node.code} ${node.name}`,
          }))}
          value={nodeRef}
          onValueChange={(v) => setNodeRef(v ?? "")}
        >
          <SelectTrigger className="h-8 w-64 text-caption" aria-label={t(($) => $.changes.form_node)}>
            <SelectValue placeholder={t(($) => $.changes.form_node)} />
          </SelectTrigger>
          <SelectContent>
            {nodes.map((node) => (
              <SelectItem key={node.id} value={node.id}>
                {node.code} {node.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          items={CHANGE_FIELDS.map((key) => ({ value: key, label: fieldLabel(t, key) }))}
          value={field}
          onValueChange={(v) => setField((v as ChangeField) ?? "status")}
        >
          <SelectTrigger className="h-8 w-44 text-caption" aria-label={t(($) => $.changes.form_field)}>
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
          onChange={(e) => setValue(e.target.value)}
          placeholder={t(($) => $.changes.form_value)}
          aria-label={t(($) => $.changes.form_value)}
          className="h-8 w-52 text-caption"
        />
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t(($) => $.changes.form_reason)}
          aria-label={t(($) => $.changes.form_reason)}
          className="h-8 min-w-40 flex-1 text-caption"
        />
        <Button type="submit" size="sm" className="h-8 px-3 text-caption" disabled={!canSubmit}>
          {file.isPending ? <Spinner className="size-3.5" /> : null}
          {t(($) => $.changes.form_submit)}
        </Button>
      </div>
      <p className="mt-2 text-micro text-faint-foreground">{t(($) => $.changes.form_hint)}</p>
    </form>
  );
}

export function CockpitChanges({
  wsId,
  nodes,
  onOpenTask,
}: {
  wsId: string;
  nodes: CockpitNode[];
  onOpenTask: (nodeId: string) => void;
}) {
  const { t } = useT("cockpit");
  const [showHistory, setShowHistory] = useState(false);
  const { data: changes = [] } = useQuery(cockpitChangesOptions(wsId));

  const pending = useMemo(
    () => changes.filter((c) => c.status === "pending"),
    [changes],
  );
  const decided = useMemo(
    () => changes.filter((c) => c.status !== "pending"),
    [changes],
  );

  const onError = (error: unknown) => {
    toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed));
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 overflow-y-auto p-4">
      <FileChangeForm wsId={wsId} nodes={nodes} onError={onError} />

      <section className="flex flex-col gap-2">
        <h2 className="text-caption font-medium text-muted-foreground">
          {t(($) => $.changes.queue_title, { n: pending.length })}
        </h2>
        {pending.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-caption text-muted-foreground">
            {t(($) => $.changes.queue_empty)}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pending.map((change) => (
              <ChangeRow
                key={change.id}
                wsId={wsId}
                change={change}
                onOpenTask={onOpenTask}
                onError={onError}
              />
            ))}
          </ul>
        )}
      </section>

      {decided.length > 0 && (
        <section className="flex flex-col gap-1">
          <button
            type="button"
            className="flex items-center gap-1 self-start text-caption text-muted-foreground hover:text-foreground"
            onClick={() => setShowHistory((on) => !on)}
            aria-expanded={showHistory}
          >
            {showHistory ? (
              <ChevronUp className="size-3.5" aria-hidden />
            ) : (
              <ChevronDown className="size-3.5" aria-hidden />
            )}
            {t(($) => $.changes.history_title, { n: decided.length })}
          </button>
          {showHistory && (
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card px-2 py-1">
              {decided.map((change) => (
                <DecidedRow key={change.id} change={change} />
              ))}
            </ul>
          )}
        </section>
      )}

      <p className="flex items-center gap-1.5 text-micro text-faint-foreground">
        <Crosshair className="size-3" aria-hidden />
        {t(($) => $.changes.locate_hint)}
      </p>
    </div>
  );
}
