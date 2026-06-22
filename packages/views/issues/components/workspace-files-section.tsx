"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core";
import { agentWorkspacesOptions } from "@multica/core/workspace";
import { ChevronRight } from "lucide-react";
import { WorkspaceFileBrowser } from "../../workspaces/components/workspace-file-browser";
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
 * issue has no agent workspace on disk. The file tree RPC only fires once the
 * section is expanded, so a collapsed section costs nothing.
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
        <div className="space-y-3 pl-2">
          {workspaces.map((ws) => (
            <div key={ws.task_short} className="rounded-md border border-border">
              <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate font-medium">
                  {ws.agent_name || ws.agent_id || "—"}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {ws.device_name}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatBytes(ws.size_bytes)}
                </span>
              </div>
              <WorkspaceFileBrowser wsId={wsId} taskShort={ws.task_short} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
