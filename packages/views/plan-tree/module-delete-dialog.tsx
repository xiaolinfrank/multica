"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDeleteModule } from "@multica/core/modules";
import { containerOperationAllowed, containerOperationBasisOptions } from "@multica/core/issues";
import type { CockpitNode, CockpitPayment } from "@multica/core/types";
import type { CockpitPlanTaskCount } from "@multica/core/types/cockpit-read";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@multica/ui/components/ui/alert-dialog";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../i18n";
import { ContainerOperationRestriction } from "../issues/components/issue-operation-restriction";
import { planNodeKind, type PlanRow } from "./plan-rows";

export interface ModuleDeleteDialogProps {
  wsId: string;
  /** The module row to delete; null keeps the dialog closed. */
  row: PlanRow | null;
  /** The plan's nodes, for counting what goes with the module. */
  nodes: readonly CockpitNode[];
  payments: readonly CockpitPayment[];
  countsById: ReadonlyMap<string, CockpitPlanTaskCount>;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}

/**
 * Deleting a module takes its work items and their payments and unfiles its
 * issues. Both surfaces that can delete one show the same dialog — the same
 * counts, the same operation basis, the same refusal text — so the gantt
 * cannot offer a lighter confirmation than the tree.
 */
export function ModuleDeleteDialog({
  wsId, row, nodes, payments, countsById, onOpenChange, onDeleted,
}: ModuleDeleteDialogProps) {
  const { t } = useT("cockpit");
  const { t: tProjects } = useT("projects");
  const deleteModule = useDeleteModule();
  const [error, setError] = useState("");
  const basis = useQuery({
    ...containerOperationBasisOptions(wsId, "module", row?.node.module_id ?? ""),
    enabled: Boolean(row?.node.module_id),
  });
  const allowed = !basis.isError && containerOperationAllowed(basis.data, "delete");

  const impact = useMemo(() => {
    const empty = { workItems: 0, payments: 0, issues: 0 };
    if (!row) return empty;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const ids = new Set<string>([row.node.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of nodes) {
        if (node.parent_id && ids.has(node.parent_id) && !ids.has(node.id)) { ids.add(node.id); grew = true; }
      }
    }
    const workItems = [...ids].filter((id) => {
      const node = byId.get(id);
      return node != null && planNodeKind(node, byId) === "work_item";
    }).length;
    const paymentCount = payments.filter((payment) => ids.has(payment.node_id)).length;
    // The read rolls counts up the tree, so the module row's primary_total
    // already covers every work item under it; summing the descendants again
    // would double the figure.
    const issues = countsById.get(row.node.id)?.primary_total ?? 0;
    return { workItems, payments: paymentCount, issues };
  }, [row, nodes, payments, countsById]);

  return (
    <AlertDialog open={row != null} onOpenChange={(open) => {
      if (!open && !deleteModule.isPending) { setError(""); onOpenChange(false); }
    }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tProjects(($) => $.module.delete_title, { title: row?.name ?? "" })}</AlertDialogTitle>
          <AlertDialogDescription>{tProjects(($) => $.module.delete_description)}</AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-caption text-muted-foreground">{t(($) => $.plan_tree.delete_module_impact, {
          work_items: impact.workItems, payments: impact.payments, issues: impact.issues,
        })}</p>
        <ContainerOperationRestriction basis={basis.isError ? undefined : basis.data} operation="delete"
          pending={basis.isPending} error={basis.isError} retry={() => void basis.refetch()} />
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteModule.isPending}>{t(($) => $.plan_tree.cancel)}</AlertDialogCancel>
          <Button type="button" variant="destructive" disabled={deleteModule.isPending || !allowed} onClick={() => {
            const moduleId = row?.node.module_id;
            if (!moduleId) return;
            setError("");
            deleteModule.mutate(moduleId, {
              onSuccess: () => { onOpenChange(false); onDeleted(); },
              onError: (cause) => setError(cause instanceof Error ? cause.message : t(($) => $.plan_tree.load_failed)),
            });
          }}>{tProjects(($) => $.module.delete_confirm)}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
