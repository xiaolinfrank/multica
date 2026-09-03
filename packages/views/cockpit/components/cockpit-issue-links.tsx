"use client";

// Linking a work item to the issues that carry it out. The board this replaces
// stored one free-text string per task ("BIO-176（待确认）") — unsearchable, and
// never resolvable to a live issue. Here a link is the real issue: its title and
// status come off the board read, and clicking it opens it.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@multica/core/api";
import type { CockpitIssueLink, Issue } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@multica/ui/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { Check, Plus, X } from "lucide-react";
import { AppLink } from "../../navigation";
import { StatusIcon } from "../../issues/components/status-icon";
import { useT } from "../../i18n";

const SEARCH_LIMIT = 20;
const SEARCH_DEBOUNCE_MS = 200;

/**
 * The picker. Stays open across selections — linking a plan item to its five
 * issues should cost one trip, not five.
 */
function IssueSearchPopover({
  linkedIssueIds,
  onToggle,
  disabled,
}: {
  linkedIssueIds: Set<string>;
  onToggle: (issue: Issue, linked: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController>(undefined);

  const search = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();

    const trimmed = q.trim();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        // include_closed: a plan routinely links work that is already finished
        // — that is exactly what makes the milestone provable.
        const res = await api.searchIssues({
          q: trimmed,
          limit: SEARCH_LIMIT,
          include_closed: true,
          signal: controller.signal,
        });
        setResults(res.issues ?? []);
      } catch {
        // An aborted or failed search leaves the previous results in place;
        // the empty state below still says what to do.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setLoading(false);
    }
  }, [open]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-caption">
            <Plus className="size-3" />
            {t(($) => $.issues.link)}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-[26rem] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t(($) => $.issues.search_placeholder)}
            value={query}
            onValueChange={(next) => {
              setQuery(next);
              search(next);
            }}
          />
          <CommandList>
            <CommandEmpty>
              {loading
                ? t(($) => $.issues.searching)
                : query.trim()
                  ? t(($) => $.issues.no_results)
                  : t(($) => $.issues.search_hint)}
            </CommandEmpty>
            {results.length > 0 && (
              <CommandGroup>
                {results.map((issue) => {
                  const linked = linkedIssueIds.has(issue.id);
                  return (
                    <CommandItem
                      key={issue.id}
                      value={issue.id}
                      onSelect={() => onToggle(issue, linked)}
                      className="gap-2"
                    >
                      <StatusIcon status={issue.status} className="size-3.5" />
                      <span className="shrink-0 font-mono text-caption text-muted-foreground">
                        {issue.identifier}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-body">{issue.title}</span>
                      {linked && <Check className="size-3.5 shrink-0 text-brand" />}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function CockpitIssueLinks({
  links,
  onLink,
  onUnlink,
  disabled,
  compact,
}: {
  links: CockpitIssueLink[];
  onLink: (issueId: string) => void;
  onUnlink: (issueId: string) => void;
  disabled?: boolean;
  /** Chips only, no picker — the gantt row has no space for one. */
  compact?: boolean;
}) {
  const { t } = useT("cockpit");
  const paths = useWorkspacePaths();
  const linkedIds = new Set(links.map((l) => l.issue_id));

  return (
    <div className={cn("flex flex-wrap items-center gap-1", compact && "gap-0.5")}>
      {links.map((link) => (
        <span
          key={link.id || link.issue_id}
          className="group/link inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/50 py-0.5 pr-1 pl-2"
        >
          <AppLink
            href={paths.issueDetail(link.issue_identifier || link.issue_id)}
            newTabTitle={link.issue_title}
            className="inline-flex min-w-0 items-center gap-1.5 hover:underline"
          >
            <StatusIcon status={link.issue_status} className="size-3 shrink-0" />
            <span className="shrink-0 font-mono text-micro text-muted-foreground">
              {link.issue_identifier}
            </span>
            {!compact && (
              <span className="min-w-0 max-w-48 truncate text-caption">{link.issue_title}</span>
            )}
          </AppLink>
          {!disabled && (
            <button
              type="button"
              onClick={() => onUnlink(link.issue_id)}
              aria-label={t(($) => $.issues.unlink_issue, { identifier: link.issue_identifier })}
              className="rounded-full p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover/link:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none"
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}

      {!compact && !disabled && (
        <IssueSearchPopover
          linkedIssueIds={linkedIds}
          onToggle={(issue, linked) => (linked ? onUnlink(issue.id) : onLink(issue.id))}
        />
      )}

      {links.length === 0 && compact && (
        <span className="text-micro text-muted-foreground">{t(($) => $.issues.none)}</span>
      )}
    </div>
  );
}
