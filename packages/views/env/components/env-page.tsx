"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  KeyRound,
  Bot,
  Search,
  RefreshCw,
  ShieldAlert,
  AlertCircle,
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

// One agent's card: header (name + variable count) plus a row per configured
// env var. `matchedKeys` is the post-search subset to render — when the agent
// matched by name we pass all its keys, when it matched by a key we pass only
// the keys that matched.
function AgentEnvCard({
  group,
  matchedKeys,
}: {
  group: WorkspaceEnvAgentGroup;
  matchedKeys: string[];
}) {
  const { t } = useT("env");
  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 border-b px-4 py-2.5">
        <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {group.agent_name}
        </span>
        <Badge variant="secondary" className="shrink-0 font-mono">
          {t(($) => $.page.variable_count, { count: group.keys.length })}
        </Badge>
      </div>
      <ul className="divide-y">
        {matchedKeys.map((key) => (
          <li
            key={key}
            className="flex items-center gap-3 px-4 py-2 text-sm"
          >
            <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
            <span className="min-w-0 flex-1 truncate font-mono">{key}</span>
            <span
              className="shrink-0 font-mono text-xs tracking-widest text-muted-foreground/60 select-none"
              aria-label={t(($) => $.page.value_hidden)}
            >
              {MASK}
            </span>
          </li>
        ))}
      </ul>
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
 * Read-only "Environment variables" page. Surfaces the env vars configured on
 * each agent across the workspace (API keys, proxy/base-URL overrides, etc.)
 * grouped by agent, with values masked — the server only ever sends key names.
 *
 * Phase 1 is browse-only: there is no add/edit/delete here. Variables are
 * configured per agent from the agent's settings; this page is the workspace
 * overview so the supported-config picture isn't a black box.
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
    () =>
      membersQuery.data?.find((m) => m.user_id === userId)?.role ?? null,
    [membersQuery.data, userId],
  );
  const isAdmin = myRole === "owner" || myRole === "admin";

  const envQuery = useQuery({
    ...workspaceEnvOptions(wsId),
    enabled: !!wsId && isAdmin,
  });

  const [search, setSearch] = useState("");

  // Only agents that actually have variables configured are worth showing in a
  // read-only overview; agents with none are noise here (they become relevant
  // in the editable phase). Then apply the search across agent name + keys.
  const visibleGroups = useMemo(() => {
    const populated = (envQuery.data?.agents ?? []).filter(
      (g) => g.keys.length > 0,
    );
    const q = search.trim().toLowerCase();
    if (!q) {
      return populated.map((g) => ({ group: g, matchedKeys: g.keys }));
    }
    const out: { group: WorkspaceEnvAgentGroup; matchedKeys: string[] }[] = [];
    for (const g of populated) {
      const nameMatch = g.agent_name.toLowerCase().includes(q);
      const keyMatches = g.keys.filter((k) => k.toLowerCase().includes(q));
      if (nameMatch) out.push({ group: g, matchedKeys: g.keys });
      else if (keyMatches.length > 0)
        out.push({ group: g, matchedKeys: keyMatches });
    }
    return out;
  }, [envQuery.data, search]);

  const totalVars = useMemo(
    () =>
      (envQuery.data?.agents ?? []).reduce((sum, g) => sum + g.keys.length, 0),
    [envQuery.data],
  );

  const hasData = totalVars > 0;
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
        {visibleGroups.map(({ group, matchedKeys }) => (
          <AgentEnvCard
            key={group.agent_id}
            group={group}
            matchedKeys={matchedKeys}
          />
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
          {totalVars > 0 && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground/70">
              {totalVars}
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
