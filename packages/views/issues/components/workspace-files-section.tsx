"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core";
import { agentWorkspacesOptions } from "@multica/core/workspace";
import type { AgentWorkspace } from "@multica/core/types";
import { ChevronRight, FolderOpen } from "lucide-react";
import { WorkspaceExplorerDialog } from "../../workspaces/components/workspace-file-browser";
import { useT } from "../../i18n";

/** Human-readable byte size (binary units). */
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Workspace files — the persistent agent workspace(s) for this issue. Mirrors
 * ExecutionLogSection: self-contained collapse state, hides itself when the
 * issue has no agent workspace on disk. Each workspace opens the shared
 * two-pane file explorer in a dialog (same UX as the management page) rather
 * than embedding a tree inline, so multiple workspaces don't bloat the page.
 */
export function WorkspaceFilesSection({ issueId }: { issueId: string }) {
  const { t } = useT("workspaces");
  const wsId = useWorkspaceId();
  const [open, setOpen] = useState(false);

  const { data } = useQuery(agentWorkspacesOptions(wsId));
  const workspaces = useMemo(
    () => (data?.workspaces ?? []).filter((w) => w.issue_id === issueId),
    [data, issueId],
  );

  if (workspaces.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        className={`flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors mb-2 hover:bg-accent/70 ${
          open ? "" : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => setOpen(!open)}
      >
        {t(($) => $.issue_section)}
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="ml-auto font-mono tabular-nums text-muted-foreground">
          {workspaces.length}
        </span>
      </button>
      {open ? (
        <div className="space-y-1.5 pl-2">
          {workspaces.map((ws) => (
            <WorkspaceFileRow key={ws.task_short} wsId={wsId} ws={ws} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceFileRow({ wsId, ws }: { wsId: string; ws: AgentWorkspace }) {
  const { t } = useT("workspaces");
  const [browsing, setBrowsing] = useState(false);

  const agentLabel = ws.agent_name || ws.agent_id || "—";

  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
      {/* Agent name is the primary identifier — it's what distinguishes the
          rows of a multi-agent squad. Give it the flexible space and drop the
          device name to a secondary line: within one issue the device name is
          usually the same runtime across rows, so it carries no signal and must
          not crowd out the Browse button on a narrow sidebar. */}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium" title={agentLabel}>
          {agentLabel}
        </div>
        {ws.device_name ? (
          <div className="truncate text-[11px] text-muted-foreground" title={ws.device_name}>
            {ws.device_name}
          </div>
        ) : null}
      </div>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatBytes(ws.size_bytes)}
      </span>
      <button
        type="button"
        onClick={() => setBrowsing(true)}
        className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      >
        <FolderOpen className="size-3.5" />
        {t(($) => $.row.browse)}
      </button>
      <WorkspaceExplorerDialog
        wsId={wsId}
        taskShort={ws.task_short}
        label={
          (ws.agent_name || ws.agent_id || "—") +
          (ws.issue_identifier ? ` · ${ws.issue_identifier}` : "")
        }
        open={browsing}
        onOpenChange={setBrowsing}
      />
    </div>
  );
}
