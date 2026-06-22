"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multica/core";
import { useWorkspacePaths } from "@multica/core/paths";
import { agentWorkspacesOptions } from "@multica/core/workspace";
import type { AgentWorkspace } from "@multica/core/types";
import { Badge } from "@multica/ui/components/ui/badge";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { FolderGit2, HardDrive, Recycle } from "lucide-react";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

/** Human-readable byte size (binary units, NAS is reported in raw bytes). */
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

/** age_seconds → compact "last active" string. */
function formatAge(seconds: number): string {
  if (seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

interface IssueGroup {
  issueId: string;
  identifier: string;
  title: string;
  status: string;
  agents: AgentWorkspace[];
  sizeBytes: number;
}

function groupByIssue(workspaces: AgentWorkspace[]): IssueGroup[] {
  const map = new Map<string, IssueGroup>();
  for (const ws of workspaces) {
    const key = ws.issue_id || ws.task_short;
    let g = map.get(key);
    if (!g) {
      g = {
        issueId: ws.issue_id,
        identifier: ws.issue_identifier,
        title: ws.issue_title,
        status: ws.issue_status,
        agents: [],
        sizeBytes: 0,
      };
      map.set(key, g);
    }
    g.agents.push(ws);
    g.sizeBytes += ws.size_bytes;
  }
  // Biggest issue first (mirrors the API's per-workspace ordering).
  return [...map.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);
}

export function WorkspacesPage() {
  const { t } = useT("workspaces");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const { data, isLoading } = useQuery(agentWorkspacesOptions(wsId));

  const groups = useMemo(() => groupByIssue(data?.workspaces ?? []), [data]);
  const count = data?.workspaces.length ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{t(($) => $.title)}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t(($) => $.subtitle)}</p>
        </header>

        <div className="grid grid-cols-3 gap-3">
          <SummaryCard
            icon={<HardDrive className="size-4" />}
            label={t(($) => $.summary.used)}
            value={formatBytes(data?.total_size_bytes ?? 0)}
          />
          <SummaryCard
            icon={<Recycle className="size-4" />}
            label={t(($) => $.summary.reclaimable)}
            value={formatBytes(data?.total_repo_checkout_bytes ?? 0)}
          />
          <SummaryCard
            icon={<FolderGit2 className="size-4" />}
            label={t(($) => $.summary.count, { count })}
            value={String(count)}
          />
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-10 text-center">
            <p className="text-sm font-medium">{t(($) => $.empty.title)}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t(($) => $.empty.hint)}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {groups.map((g) => (
              <IssueGroupRow key={g.issueId || g.identifier} group={g} />
            ))}
          </div>
        )}
      </div>
    </div>
  );

  function IssueGroupRow({ group }: { group: IssueGroup }) {
    return (
      <div className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          {group.identifier ? (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{group.identifier}</span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {group.title || group.issueId}
          </span>
          {group.status ? (
            <Badge variant="secondary" className="shrink-0 capitalize">
              {group.status.replace(/_/g, " ")}
            </Badge>
          ) : null}
          <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
            {formatBytes(group.sizeBytes)}
          </span>
          {group.issueId ? (
            <AppLink
              href={paths.issueDetail(group.issueId)}
              className="shrink-0 text-xs font-medium text-brand hover:underline"
            >
              {t(($) => $.row.open_issue)}
            </AppLink>
          ) : null}
        </div>
        <ul className="divide-y divide-border">
          {group.agents.map((ws) => (
            <li
              key={ws.task_short}
              className="flex items-center gap-3 px-4 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                {ws.agent_name || ws.agent_id || "—"}
                <span className="ml-2 text-xs text-muted-foreground">
                  {t(($) => $.row.on_device, { device: ws.device_name || "—" })}
                </span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {t(($) => $.row.files, { count: ws.file_count })}
              </span>
              {ws.repo_checkout_bytes > 0 ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t(($) => $.row.reclaimable, { size: formatBytes(ws.repo_checkout_bytes) })}
                </span>
              ) : null}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatAge(ws.age_seconds)}
              </span>
              <span className="w-16 shrink-0 text-right text-sm tabular-nums">
                {formatBytes(ws.size_bytes)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
}

function SummaryCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
