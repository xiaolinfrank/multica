"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  KeyRound,
  Bot,
  Search,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  AlertCircle,
  Plug,
} from "lucide-react";
import type { WorkspaceEnvAgentGroup } from "@multica/core/types";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import { ApiError } from "@multica/core/api";
import {
  memberListOptions,
  workspaceEnvOptions,
} from "@multica/core/workspace/queries";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { PageHeader } from "../../layout/page-header";
import { useT } from "../../i18n";

// Values never travel to this page (the server sends key names only), so the
// "value" column is a fixed cosmetic mask. There is nothing real to reveal
// here — revealing an actual value is a per-agent, audited action elsewhere.
const MASK = "••••••••";

// Total named secret keys an agent carries, across custom_env and every MCP
// server's env block. The gateway token is a presence flag, not a named key,
// so it's surfaced as its own badge rather than counted here.
function keyCount(g: WorkspaceEnvAgentGroup): number {
  return (
    g.keys.length + g.mcp_servers.reduce((sum, m) => sum + m.keys.length, 0)
  );
}

function hasSecrets(g: WorkspaceEnvAgentGroup): boolean {
  return keyCount(g) > 0 || g.gateway_token;
}

function matchesQuery(g: WorkspaceEnvAgentGroup, q: string): boolean {
  if (g.agent_name.toLowerCase().includes(q)) return true;
  if (g.keys.some((k) => k.toLowerCase().includes(q))) return true;
  return g.mcp_servers.some(
    (m) =>
      m.name.toLowerCase().includes(q) ||
      m.keys.some((k) => k.toLowerCase().includes(q)),
  );
}

// A single secret key row: name in mono + a fixed mask standing in for the
// (never-transmitted) value.
function KeyRow({ name, hidden }: { name: string; hidden: string }) {
  return (
    <li className="flex items-center gap-3 px-4 py-2 text-sm">
      <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      <span className="min-w-0 flex-1 truncate font-mono">{name}</span>
      <span
        className="shrink-0 font-mono text-xs tracking-widest text-muted-foreground/60 select-none"
        aria-label={hidden}
      >
        {MASK}
      </span>
    </li>
  );
}

// A labelled group of keys within an agent card (the custom_env block, or one
// MCP server's env block). `icon` + `label` head the section; `hint` says where
// the keys are actually edited (Environment tab vs MCP Config) so the overview
// doesn't read as the place to change them.
function SecretSection({
  icon,
  label,
  hint,
  keys,
  hidden,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  hint: string;
  keys: string[];
  hidden: string;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 pt-2.5 pb-1">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {icon}
          <span className="min-w-0 truncate">{label}</span>
        </span>
        <span className="text-[11px] text-muted-foreground/70">{hint}</span>
      </div>
      <ul className="divide-y border-t">
        {keys.map((k) => (
          <KeyRow key={k} name={k} hidden={hidden} />
        ))}
      </ul>
    </div>
  );
}

// One agent's card: header (name, optional gateway badge, key count) followed
// by a section for the agent's process env (custom_env) and a section per MCP
// server that declares env vars.
function AgentEnvCard({ group }: { group: WorkspaceEnvAgentGroup }) {
  const { t } = useT("env");
  const hidden = t(($) => $.page.value_hidden);
  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {group.agent_name}
        </span>
        {group.gateway_token && (
          <Badge variant="outline" className="shrink-0 gap-1">
            <ShieldCheck className="h-3 w-3" />
            {t(($) => $.page.gateway_configured)}
          </Badge>
        )}
        <Badge variant="secondary" className="shrink-0 font-mono">
          {t(($) => $.page.variable_count, { count: keyCount(group) })}
        </Badge>
      </div>

      {group.keys.length > 0 && (
        <SecretSection
          icon={<KeyRound className="h-3 w-3" />}
          label={t(($) => $.page.section_process)}
          hint={t(($) => $.page.section_process_hint)}
          keys={group.keys}
          hidden={hidden}
        />
      )}

      {group.mcp_servers.map((server) => (
        <SecretSection
          key={server.name}
          icon={<Plug className="h-3 w-3" />}
          label={
            <span className="font-mono">
              {t(($) => $.page.section_mcp, { name: server.name })}
            </span>
          }
          hint={t(($) => $.page.section_mcp_hint)}
          keys={server.keys}
          hidden={hidden}
        />
      ))}
    </div>
  );
}

function CenteredState({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-dashed px-4 py-12 text-center">
      <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-full bg-muted/50 text-muted-foreground">
        {icon}
      </div>
      <p className="text-sm font-medium">{title}</p>
      {hint && (
        <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-lg border">
          <div className="border-b px-4 py-2.5">
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="space-y-2 px-4 py-3">
            <Skeleton className="h-3 w-56" />
            <Skeleton className="h-3 w-44" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only "Environment variables" page. Surfaces every secret configured on
 * each agent across the workspace — grouped by agent, values masked (the
 * server sends key names only) — across the three distinct places a key can
 * live:
 *   - the agent's process env (custom_env; inherited by skill scripts),
 *   - each MCP server's own env block (e.g. TAVILY_API_KEY for tavily-mcp),
 *   - whether an OpenClaw runtime gateway token is configured.
 *
 * Browse-only: there is no add/edit/delete here. Keys are configured per agent
 * from the agent's settings tabs (Environment / MCP Config / Runtime Config);
 * this page is the workspace overview so the secret picture isn't a black box.
 *
 * Owner/admin only, matching the backend (`GET /api/env`). The viewer's role
 * is checked client-side too so non-admins see a clear permission state and
 * the env query never fires a doomed 403.
 */
export function EnvPage() {
  const { t } = useT("env");
  const wsId = useWorkspaceId();
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const membersQuery = useQuery(memberListOptions(wsId));
  const myRole = useMemo(
    () => membersQuery.data?.find((m) => m.user_id === userId)?.role ?? null,
    [membersQuery.data, userId],
  );
  const isAdmin = myRole === "owner" || myRole === "admin";

  const envQuery = useQuery({
    ...workspaceEnvOptions(wsId),
    enabled: !!wsId && isAdmin,
  });

  const [search, setSearch] = useState("");

  // Only agents that actually carry secrets are worth showing in a read-only
  // overview; the rest are noise here. Then filter by search (whole-card match
  // across agent name, custom_env keys, MCP server names, and MCP keys).
  const visibleGroups = useMemo(() => {
    const populated = (envQuery.data?.agents ?? []).filter(hasSecrets);
    const q = search.trim().toLowerCase();
    if (!q) return populated;
    return populated.filter((g) => matchesQuery(g, q));
  }, [envQuery.data, search]);

  // Header count: total named secret keys across every agent and location.
  const totalKeys = useMemo(
    () =>
      (envQuery.data?.agents ?? []).reduce((sum, g) => sum + keyCount(g), 0),
    [envQuery.data],
  );

  const hasData = (envQuery.data?.agents ?? []).some(hasSecrets);
  const forbidden =
    (!membersQuery.isLoading && !isAdmin) ||
    (envQuery.error instanceof ApiError && envQuery.error.status === 403);

  const body = (() => {
    if (forbidden) {
      return (
        <CenteredState
          icon={<ShieldAlert className="h-4 w-4" />}
          title={t(($) => $.page.forbidden_title)}
          hint={t(($) => $.page.forbidden_hint)}
        />
      );
    }
    if (membersQuery.isLoading || envQuery.isLoading) {
      return <ListSkeleton />;
    }
    if (envQuery.error) {
      return (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t(($) => $.page.load_error)}
        </div>
      );
    }
    if (!hasData) {
      return (
        <CenteredState
          icon={<KeyRound className="h-4 w-4" />}
          title={t(($) => $.page.empty_title)}
          hint={t(($) => $.page.empty_hint)}
        />
      );
    }
    if (visibleGroups.length === 0) {
      return (
        <CenteredState
          icon={<Search className="h-4 w-4" />}
          title={t(($) => $.page.no_matches)}
        />
      );
    }
    return (
      <div className="space-y-3">
        {visibleGroups.map((group) => (
          <AgentEnvCard key={group.agent_id} group={group} />
        ))}
      </div>
    );
  })();

  const showToolbar = isAdmin && !forbidden && hasData;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader className="justify-between px-5">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">{t(($) => $.page.title)}</h1>
          {totalKeys > 0 && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground/70">
              {totalKeys}
            </span>
          )}
          <p className="ml-2 hidden text-xs text-muted-foreground md:block">
            {t(($) => $.page.tagline)}
          </p>
        </div>
      </PageHeader>

      {showToolbar && (
        <div className="flex shrink-0 items-center gap-2 border-b px-5 py-2.5">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t(($) => $.page.search_placeholder)}
              className="h-8 pl-8"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 w-8 shrink-0 px-0"
            aria-label={t(($) => $.page.refresh)}
            disabled={envQuery.isFetching}
            onClick={() => void envQuery.refetch()}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${envQuery.isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* Masked, read-only reminder so it's obvious this is a viewer, not an editor. */}
        {showToolbar && (
          <p className="mb-3 text-xs text-muted-foreground">
            {t(($) => $.page.masked_hint)}
          </p>
        )}
        {body}
      </div>
    </div>
  );
}
