"use client";

import { useState } from "react";
import { errorCode } from "@multica/core/api";
import type { CockpitScope } from "@multica/core/cockpit";
import { Button } from "@multica/ui/components/ui/button";
import { copyText } from "@multica/ui/lib/clipboard";
import { Copy, SlidersHorizontal } from "lucide-react";
import { useT } from "../../i18n";

export function CockpitReadFailure({ error, wsId, scope, resource, onRetry, onChooseScope, busy = false }: {
  error: unknown; wsId: string; scope: CockpitScope; resource: string; onRetry: () => void; onChooseScope?: () => void; busy?: boolean;
}) {
  const { t } = useT("cockpit"); const [copied, setCopied] = useState<boolean | null>(null);
  const code = errorCode(error);
  const scopeLimit = code === "scope_limit" || code === "export_limit";
  const indexLimit = code === "display_index_limit";
  const diagnostics = JSON.stringify({ code: code ?? "read_failed", workspace_id: wsId, resource, project_id: scope.projectId, module_id: scope.moduleId }, null, 2);
  return <div role="alert" className="space-y-4 rounded-xl border border-destructive/20 bg-card p-5">
    <p className="max-w-2xl text-body">{indexLimit ? t(($) => $.shell.index_limit) : scopeLimit ? t(($) => $.shell.scope_limit) : t(($) => $.errors.load_failed)}</p>
    <div className="flex flex-wrap gap-2">{scopeLimit ? <Button type="button" variant="outline" size="sm" onClick={() => {
      if (onChooseScope) { onChooseScope(); return; }
      const target = scope.projectId ? document.querySelector<HTMLButtonElement>("[data-cockpit-module-scope]") : null;
      (target ?? document.querySelector<HTMLButtonElement>("[data-cockpit-project-scope]"))?.click();
    }}><SlidersHorizontal className="size-3.5" />{t(($) => $.shell.choose_smaller_scope)}</Button>
      : !indexLimit && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRetry}>{t(($) => $.binding.retry)}</Button>}
      {(scopeLimit || indexLimit) && <Button type="button" variant="outline" size="sm" onClick={() => { void copyText(diagnostics).then(setCopied).catch(() => setCopied(false)); }}><Copy className="size-3.5" />{t(($) => $.shell.copy_diagnostics)}</Button>}
    </div>
    {copied !== null && <p role="status" className="text-caption text-muted-foreground">{copied ? t(($) => $.shell.diagnostics_copied) : t(($) => $.shell.copy_failed)}</p>}
    {(scopeLimit || indexLimit) && <details className="text-caption text-muted-foreground"><summary className="cursor-pointer">{t(($) => $.shell.diagnostic_details)}</summary><pre className="mt-2 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3">{diagnostics}</pre></details>}
  </div>;
}
