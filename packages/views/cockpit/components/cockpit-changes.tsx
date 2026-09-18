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
import type { CockpitNode, CockpitPendingChange } from "@multica/core/types";
import {
  buildCockpitTree,
  buildCockpitDisplayCodes,
  flattenCockpitTree,
  cockpitMissingFields,
  cockpitChangesOptions,
  useApplyCockpitChange,
  useCreateCockpitChange,
  useRejectCockpitChange,
  useWithdrawCockpitChange,
} from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel, AlertDialogAction,
} from "@multica/ui/components/ui/alert-dialog";
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
  batchBusy,
  beginDecision,
  endDecision,
}: {
  batchBusy: boolean;
  beginDecision: () => boolean;
  endDecision: () => void;
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
  const busy = batchBusy || apply.isPending || reject.isPending || withdraw.isPending;

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
    if (!beginDecision()) return;
    run.mutate(change.id, {
      onSuccess: () => { endDecision(); toast.success(ok); },
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
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex min-w-0 items-center gap-2 text-caption">
        {code}
        <span className="min-w-0 truncate font-medium">{change.node_name}</span>
        <span aria-hidden className="text-faint-foreground">
          ·
        </span>
        <span className="shrink-0">{fieldLabel(t, change.field)}</span>
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const batchLock = useRef(false);
  const applyAll = useApplyCockpitChange(wsId);
  const [showHistory, setShowHistory] = useState(false);
  const { data: rawChanges = [] } = useQuery(cockpitChangesOptions(wsId));
  const tree = useMemo(() => buildCockpitTree(nodes), [nodes]);
  const displayCodes = useMemo(() => buildCockpitDisplayCodes(tree), [tree]);
  const displayNodes = useMemo(() => nodes.map((node) => ({ ...node, code: displayCodes.get(node.id) ?? node.code })), [nodes, displayCodes]);
  const changes = useMemo(() => rawChanges.map((change) => ({ ...change, node_code: displayCodes.get(change.node_id) ?? change.node_code })), [rawChanges, displayCodes]);
  const rootById = useMemo(() => {
    const roots = new Map<string, CockpitNode>();
    for (const root of tree) for (const entry of flattenCockpitTree([root])) roots.set(entry.node.id, root.node);
    return roots;
  }, [tree]);
  const review = useMemo(() => {
    return tree.map((root) => {
      const tasks = flattenCockpitTree([root])
        .filter((entry) => entry.children.length === 0)
        .map(({ node }) => ({
          node,
          missing: cockpitMissingFields(node),
          suggested: (["collaborators", "vendor", "budget_category", "exec_status", "dependencies", "deliverable", "note", "current_progress"] as const)
            .filter((field) => !node[field].trim()),
        }));
      return { root: root.node, tasks, missing: tasks.reduce((sum, task) => sum + task.missing.length, 0),
        complete: tasks.filter((task) => task.missing.length === 0).length };
    });
  }, [tree]);
  const missingTotal = review.reduce((sum, group) => sum + group.missing, 0);
  const completeTotal = review.reduce((sum, group) => sum + group.complete, 0);
  const taskTotal = review.reduce((sum, group) => sum + group.tasks.length, 0);

  const pending = useMemo(
    () => changes.filter((c) => c.status === "pending"),
    [changes],
  );
  const decided = useMemo(
    () => changes.filter((c) => c.status !== "pending"),
    [changes],
  );

  const groups = useMemo(() => {
    const grouped = new Map<string, { root: CockpitNode | undefined; tasks: Map<string, CockpitPendingChange[]> }>();
    for (const change of pending) {
      const root = rootById.get(change.node_id);
      const key = root?.id ?? "";
      let group = grouped.get(key);
      if (!group) { group = { root, tasks: new Map() }; grouped.set(key, group); }
      const task = group.tasks.get(change.node_id) ?? [];
      task.push(change);
      group.tasks.set(change.node_id, task);
    }
    return [...grouped.entries()];
  }, [pending, rootById]);

  const onError = (error: unknown) => {
    toast.error(error instanceof Error ? error.message : t(($) => $.errors.save_failed));
  };

  const beginDecision = () => {
    if (batchLock.current) return false;
    batchLock.current = true;
    setBatchBusy(true);
    return true;
  };
  const endDecision = () => { batchLock.current = false; setBatchBusy(false); };
  const acceptAll = async () => {
    if (pending.length === 0 || !beginDecision()) return;
    try {
      // Sequential writes preserve proposal ordering for repeated edits of one field.
      // Stop on failure: applied decisions stay settled, remaining proposals stay pending.
      const oldestFirst = [...pending].sort((a, b) =>
        Date.parse(a.created_at) - Date.parse(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const change of oldestFirst) await applyAll.mutateAsync(change.id);
      setConfirmOpen(false);
      toast.success(t(($) => $.changes.apply_done));
    } catch (error) {
      onError(error);
    } finally {
      endDecision();
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 overflow-y-auto p-4">
      <FileChangeForm wsId={wsId} nodes={displayNodes} onError={onError} />

      {taskTotal > 0 && (
        <section className="rounded-lg border border-border bg-card p-3">
          <h2 className="text-caption font-medium">
            {t(($) => $.table.check)} · {t(($) => $.table.core_missing, { count: missingTotal })} · {t(($) => $.table.check_ok)} {completeTotal}/{taskTotal}
          </h2>
          <div className="mt-2 flex max-h-64 flex-col gap-2 overflow-y-auto">
            {review.map((group) => (
              <details key={group.root.id} open>
                <summary className="cursor-pointer text-caption font-medium">
                  {displayCodes.get(group.root.id) ?? group.root.code} {group.root.name} · {t(($) => $.table.core_missing, { count: group.missing })} · {t(($) => $.table.check_ok)} {group.complete}/{group.tasks.length}
                </summary>
                <ul className="mt-2 flex flex-col gap-2">
                  {group.tasks.map(({ node, missing, suggested }) => {
                    const suggestedLabels = [
                      ...suggested.map((field) => fieldLabel(t, field)),
                      ...(node.budget_amount == null ? [t(($) => $.node.budget)] : []),
                    ];
                    return (
                      <li key={node.id} className="flex flex-wrap items-center gap-2 text-caption">
                        <Button variant="ghost" size="sm" onClick={() => onOpenTask(node.id)}>
                          {displayCodes.get(node.id) ?? node.code} {node.name}
                        </Button>
                        <span>{t(($) => $.node.owner)}: {node.owner.trim() || t(($) => $.common.unset)}</span>
                        <span className="text-muted-foreground">
                          {missing.length > 0 ? `${t(($) => $.table.core_missing, { count: missing.length })}: ${missing.map((field) => fieldLabel(t, field)).join(" / ")}` : t(($) => $.table.check_ok)}
                        </span>
                        {suggestedLabels.length > 0 && (
                          <span className="text-muted-foreground">{t(($) => $.table.suggested_fields, { count: suggestedLabels.length })}: {suggestedLabels.join(" / ")}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </details>
            ))}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2 text-caption">
        <span className="rounded-full border border-border px-2 py-1">{t(($) => $.changes.queue_title, { n: pending.length })}</span>
        <span className="rounded-full border border-border px-2 py-1">{t(($) => $.changes.status_applied)} {changes.filter((change) => change.status === "applied").length}</span>
        <span className="rounded-full border border-border px-2 py-1">{t(($) => $.changes.status_rejected)} {changes.filter((change) => change.status === "rejected").length}</span>
        {(["type_add", "type_modify", "type_clear"] as const).map((type) => (
          <span key={type} className="rounded-full border border-border px-2 py-1">
            {t(($) => $.changes[type])} {pending.filter((change) => changeType(change) === type).length}
          </span>
        ))}
        <AlertDialog open={confirmOpen} onOpenChange={(open) => { if (!batchLock.current) setConfirmOpen(open); }}>
          <AlertDialogTrigger render={<Button size="sm" className="ml-auto" disabled={batchBusy || pending.length === 0} />}>
            {t(($) => $.changes.apply_all)}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t(($) => $.changes.confirm_apply_all)}</AlertDialogTitle>
              <AlertDialogDescription>{t(($) => $.changes.queue_title, { n: pending.length })}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={batchBusy}>{t(($) => $.versions.cancel)}</AlertDialogCancel>
              <AlertDialogAction disabled={batchBusy || pending.length === 0} aria-busy={batchBusy} onClick={() => void acceptAll()}>
                {batchBusy ? <Spinner className="size-3.5" /> : <Check className="size-3.5" aria-hidden />}
                {t(($) => $.changes.apply_all)}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="text-caption font-medium text-muted-foreground">
          {t(($) => $.changes.queue_title, { n: pending.length })}
        </h2>
        {pending.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-caption text-muted-foreground">
            {t(($) => $.changes.queue_empty)}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map(([key, group]) => (
              <details key={key} open className="rounded-lg border border-border bg-card p-3">
                <summary className="cursor-pointer text-caption font-medium">
                  {group.root ? `${displayCodes.get(group.root.id) ?? group.root.code} ${group.root.name}` : t(($) => $.changes.node_gone)}
                </summary>
                <div className="mt-2 flex flex-col gap-2">
                  {[...group.tasks.entries()].map(([nodeId, taskChanges]) => (
                    <details key={nodeId} open>
                      <summary className="cursor-pointer text-caption text-muted-foreground">
                        {taskChanges[0]?.node_code} {taskChanges[0]?.node_name} · {taskChanges.length}
                      </summary>
                      <ul className="mt-2 flex flex-col gap-2">
                        {taskChanges.map((change) => (
                          <ChangeRow key={change.id} wsId={wsId} change={change} batchBusy={batchBusy} beginDecision={beginDecision} endDecision={endDecision} onOpenTask={onOpenTask} onError={onError} />
                        ))}
                      </ul>
                    </details>
                  ))}
                </div>
              </details>
            ))}
          </div>
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
