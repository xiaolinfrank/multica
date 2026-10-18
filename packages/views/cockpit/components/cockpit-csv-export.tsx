"use client";

import { useEffect, useRef, useState } from "react";
import { buildCockpitDisplayCodesFromIndex, cockpitTasksCsv, cockpitFinanceCsv, usePrepareCockpitCsvExport, type CockpitScope } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Download } from "lucide-react";
import { useLocale, useT } from "../../i18n";
import { CockpitReadFailure } from "./cockpit-read-failure";

export function CockpitCsvExport({ wsId, scope, initialMode = "tasks" }: { wsId: string; scope: CockpitScope; initialMode?: "tasks" | "finance" }) {
  const { t } = useT("cockpit"); const locale = useLocale();
  const [open, setOpen] = useState(false); const [mode, setMode] = useState(initialMode); const [observedScope, setObservedScope] = useState(scope);
  const request = useRef<AbortController | null>(null); const prepare = usePrepareCockpitCsvExport(wsId);
  useEffect(() => () => request.current?.abort(), []);
  const start = (target: CockpitScope) => { request.current?.abort(); const controller = new AbortController(); request.current = controller;
    prepare.reset(); void prepare.mutateAsync({ scope: target, signal: controller.signal }).catch(() => undefined); };
  const data = prepare.data;
  const sameScope = scope.projectId === observedScope.projectId && scope.moduleId === observedScope.moduleId;
  function download() {
    if (!data || !sameScope || prepare.isPending) return;
    const context = new Set(data.context_node_ids);
    const options = { displayCodes: buildCockpitDisplayCodesFromIndex(data.node_index), contextNodeIds: context };
    const csv = mode === "finance" ? cockpitFinanceCsv(data, options) : cockpitTasksCsv(data, options);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob);
    const title = [data.scope.project_title, data.scope.module_title].filter(Boolean).join("_") || data.cockpit?.title || "cockpit";
    const filename = Array.from(title.replace(/[\\/:*?"<>|]/g, "_")).slice(0, 45).join("");
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${filename}-${data.generated_at.slice(0, 10)}-${mode}.csv`;
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  const modes = [{ value: "tasks", label: t(($) => $.toolbar.export_tasks) }, { value: "finance", label: t(($) => $.toolbar.export_finance) }];
  return <Dialog open={open} onOpenChange={(next) => {
    if (next) { setObservedScope(scope); setMode(initialMode); start(scope); } else { request.current?.abort(); prepare.reset(); }
    setOpen(next);
  }}><DialogTrigger render={<Button type="button" size="sm" variant="outline" />}><Download className="size-3.5" />{t(($) => $.plan_views.csv_export)}</DialogTrigger>
    <DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{t(($) => $.plan_views.csv_export)}</DialogTitle><DialogDescription>{t(($) => $.plan_views.export_basis)}</DialogDescription></DialogHeader>
      {prepare.isPending ? <div role="status" className="flex items-center gap-2 py-5 text-caption"><Spinner />{t(($) => $.plan_views.preparing_export)}</div>
        : prepare.isError || !data ? <CockpitReadFailure error={prepare.error} wsId={wsId} scope={observedScope} resource="plan-export" onRetry={() => start(observedScope)}
          onChooseScope={() => { setOpen(false); request.current?.abort(); requestAnimationFrame(() => (document.querySelector<HTMLButtonElement>(observedScope.projectId ? "[data-cockpit-module-scope]" : "[data-cockpit-project-scope]") ?? document.querySelector<HTMLButtonElement>("[data-cockpit-project-scope]"))?.click()); }} />
          : <div className="space-y-4"><dl className="space-y-2 text-caption"><div className="flex gap-3"><dt className="shrink-0 text-muted-foreground">{t(($) => $.shell.scope)}</dt><dd className="min-w-0 break-words">{[data.scope.project_title, data.scope.module_title].filter(Boolean).join(" / ") || t(($) => $.shell.all_projects)}</dd></div>
            <div className="flex gap-3"><dt className="shrink-0 text-muted-foreground">{t(($) => $.plan_views.snapshot_time)}</dt><dd>{new Date(data.generated_at).toLocaleString(locale)}</dd></div></dl>
            <p className="text-caption">{t(($) => $.plan_views.export_counts, { nodes: data.nodes.filter((node) => !data.context_node_ids.includes(node.id)).length, payments: data.payments.length, links: data.issue_link_total })}</p>
            <label className="block space-y-1 text-caption">{t(($) => $.plan_views.export_ledger)}<Select value={mode} items={modes} onValueChange={(value) => { if (value === "tasks" || value === "finance") setMode(value); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{modes.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></label>
            {!sameScope && <p role="alert" className="text-caption text-destructive">{t(($) => $.plan_views.export_scope_changed)}</p>}
          </div>}
      <DialogFooter><DialogClose render={<Button type="button" variant="outline" />}>{t(($) => $.task_create.cancel)}</DialogClose><Button type="button" disabled={!data || prepare.isPending || prepare.isError || !sameScope} onClick={download}><Download className="size-3.5" />{t(($) => $.plan_views.download_csv)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
