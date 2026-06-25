"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, HardDrive, RefreshCw } from "lucide-react";
import type { AgentRuntime, RuntimeLocalSkillSummary } from "@multica/core/types";
import { useAuthStore } from "@multica/core/auth";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  runtimeListOptions,
  runtimeLocalSkillsOptions,
} from "@multica/core/runtimes";
import { Badge } from "@multica/ui/components/ui/badge";
import { Button } from "@multica/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multica/ui/components/ui/select";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useT } from "../../i18n";

function runtimeLabel(runtime: AgentRuntime): string {
  return `${runtime.name} (${runtime.provider})`;
}

// Read-only row for a runtime-native skill. This is the display half of the
// import panel's SkillItem (name + provider + description + source path +
// file count) without the checkbox, selection toggle, or inline edit panel —
// browsing never mutates anything.
function BrowseSkillItem({ skill }: { skill: RuntimeLocalSkillSummary }) {
  const { t } = useT("skills");
  return (
    <div className="flex items-start gap-3 rounded-lg border px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{skill.name}</span>
          <Badge variant="secondary">{skill.provider}</Badge>
        </div>
        {skill.description && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {skill.description}
          </p>
        )}
        <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
          {skill.source_path}
        </p>
      </div>
      <Badge variant="outline" className="shrink-0">
        {t(($) => $.runtime_import.skill_files, { count: skill.file_count })}
      </Badge>
    </div>
  );
}

// Read-only browser for a connected runtime's native skills (~/.claude/skills,
// ~/.codex/skills, etc.). It reuses the exact discovery query the import panel
// uses (runtimeLocalSkillsOptions -> resolveRuntimeLocalSkills, a daemon
// POST-then-poll), but drops every import affordance. Listing requires no
// backend change: the list endpoint already returns metadata-only summaries.
//
// Like the import panel, the runtime picker is scoped to LOCAL runtimes the
// current user owns — the server gates local-skill access to the owner — and
// discovery is gated on the runtime being online (an offline daemon cannot be
// polled).
export function RuntimeSkillsBrowsePanel() {
  const { t } = useT("skills");
  const wsId = useWorkspaceId();
  const userId = useAuthStore((s) => s.user?.id ?? null);

  const { data: runtimes = [] } = useQuery(runtimeListOptions(wsId));
  const localRuntimes = useMemo(
    () =>
      runtimes.filter(
        (r) =>
          r.runtime_mode === "local" &&
          (userId == null || r.owner_id === userId),
      ),
    [runtimes, userId],
  );

  const [selectedRuntimeId, setSelectedRuntimeId] = useState<string>("");
  // Keep the selection valid: seed it with the first runtime, and re-clamp to
  // the first available one if the previously-selected runtime drops out of
  // the list (deregistered, ownership changed, workspace switched). A stale id
  // would otherwise strand the picker on an empty "choose a runtime" state even
  // when other online runtimes exist.
  useEffect(() => {
    setSelectedRuntimeId((prev) =>
      prev && localRuntimes.some((r) => r.id === prev)
        ? prev
        : localRuntimes[0]?.id || "",
    );
  }, [localRuntimes]);

  const selectedRuntime = localRuntimes.find((r) => r.id === selectedRuntimeId);
  const canBrowseSkills =
    !!selectedRuntimeId && selectedRuntime?.status === "online";
  const skillsQuery = useQuery({
    ...runtimeLocalSkillsOptions(selectedRuntimeId || null),
    enabled: canBrowseSkills,
  });
  const runtimeSkills = skillsQuery.data?.skills ?? [];

  // State ladder mirrors the import panel's idle branch (same ordering): no
  // local runtimes -> no selection -> offline -> loading -> error -> provider
  // unsupported -> empty -> the list.
  const middle = (() => {
    if (localRuntimes.length === 0) {
      return (
        <div className="rounded-lg border border-dashed px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            {t(($) => $.runtime_import.no_local_runtimes_title)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(($) => $.runtime_import.no_local_runtimes_hint)}
          </p>
        </div>
      );
    }
    if (!selectedRuntime) {
      return (
        <div className="rounded-lg border border-dashed px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            {t(($) => $.runtime_import.choose_runtime)}
          </p>
        </div>
      );
    }
    if (selectedRuntime.status !== "online") {
      return (
        <div className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs text-muted-foreground">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          {t(($) => $.runtime_import.must_be_online)}
        </div>
      );
    }
    if (skillsQuery.isLoading) {
      return (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border px-4 py-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-2 h-3 w-48" />
            </div>
          ))}
        </div>
      );
    }
    if (skillsQuery.error) {
      return (
        <div className="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {skillsQuery.error instanceof Error
            ? skillsQuery.error.message
            : t(($) => $.runtime_import.load_failed)}
        </div>
      );
    }
    if (!skillsQuery.data?.supported) {
      return (
        <div className="flex items-start gap-2 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t(($) => $.runtime_import.not_supported)}
        </div>
      );
    }
    if (runtimeSkills.length === 0) {
      return (
        <div className="rounded-lg border border-dashed px-4 py-10 text-center">
          <p className="text-sm text-muted-foreground">
            {t(($) => $.runtime_import.no_skills_title)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t(($) => $.runtime_import.no_skills_hint)}
          </p>
        </div>
      );
    }
    return (
      <div className="space-y-2">
        {runtimeSkills.map((s) => (
          <BrowseSkillItem key={s.key} skill={s} />
        ))}
      </div>
    );
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Sticky top: runtime picker + status + refresh */}
      <div className="shrink-0 space-y-2 border-b px-5 py-3">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">
            {t(($) => $.runtime_import.runtime_label)}
          </label>
          <div className="flex items-center gap-2">
            <Select
              value={selectedRuntimeId}
              onValueChange={(v) => v && setSelectedRuntimeId(v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue
                  placeholder={t(($) => $.runtime_import.runtime_placeholder)}
                >
                  {selectedRuntime ? runtimeLabel(selectedRuntime) : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {localRuntimes.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {runtimeLabel(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 w-8 shrink-0 px-0"
              aria-label={t(($) => $.runtime_browse.refresh)}
              disabled={!canBrowseSkills || skillsQuery.isFetching}
              onClick={() => void skillsQuery.refetch()}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${
                  skillsQuery.isFetching ? "animate-spin" : ""
                }`}
              />
            </Button>
          </div>
        </div>

        {selectedRuntime && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
            <HardDrive className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {runtimeLabel(selectedRuntime)}
            </span>
            <Badge
              variant={
                selectedRuntime.status === "online" ? "secondary" : "outline"
              }
            >
              {selectedRuntime.status}
            </Badge>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {t(($) => $.runtime_browse.hint)}
        </p>
      </div>

      {/* Scrollable list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">{middle}</div>
    </div>
  );
}
