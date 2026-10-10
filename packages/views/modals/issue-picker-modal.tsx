"use client";

import { issueStatusCategory } from "@multica/core/issues";
import { useWorkspaceId } from "@multica/core/hooks";
import { useIssueStatuses } from "@multica/core/issue-statuses/hooks";
import { useState, useEffect, useCallback, useRef } from "react";
import type { Issue } from "@multica/core/types";
import { searchIssues } from "@multica/core/search-index";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@multica/ui/components/ui/command";
import { StatusIcon } from "../issues/components/status-icon";
import { useT } from "../i18n";
import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";

/** Issues offered before the user types, under a heading. */
export interface IssuePickerSuggestionGroup {
  key: string;
  heading: string;
  issues: Issue[];
}

interface IssuePickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  excludeIds: string[];
  onSelect: (issue: Issue, signal: AbortSignal) => void | Promise<void>;
  contextKey?: string;
  disabled?: boolean;
  notice?: React.ReactNode;
  /** Shown while the query is empty; groups without issues are skipped. */
  suggestions?: IssuePickerSuggestionGroup[];
  /** Drops issues from results and suggestions alike; excludeIds always applies. */
  isSelectable?: (issue: Issue) => boolean;
}

export function IssuePickerModal({
  open,
  onOpenChange,
  title,
  description,
  excludeIds,
  onSelect,
  suggestions,
  isSelectable,
  contextKey,
  disabled = false,
  notice,
}: IssuePickerModalProps) {
  const { t } = useT("modals");
  const { t: issueT } = useT("issues");
  const wsId = useWorkspaceId();
  const { colorOf, iconOf } = useIssueStatuses(wsId);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Issue[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selecting, setSelecting] = useState(false); const [error, setError] = useState(""); const [searchFailed, setSearchFailed] = useState(false);
  const commandIdentity = JSON.stringify([wsId, contextKey ?? title]);
  const current = useRef<string | null>(commandIdentity); current.current = commandIdentity;
  const lock = useRef(false);
  const selectionAbort = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abortRef = useRef<AbortController>(undefined);
  const selectable = useCallback(
    (issue: Issue) => !excludeIds.includes(issue.id) && (isSelectable?.(issue) ?? true),
    [excludeIds, isSelectable],
  );
  const suggestionGroups = (suggestions ?? [])
    .map((group) => ({ ...group, issues: group.issues.filter(selectable) }))
    .filter((group) => group.issues.length > 0);

  useEffect(() => {
    current.current = commandIdentity; lock.current = false; setSelecting(false); setError("");
    return () => { if (current.current === commandIdentity) current.current = null; selectionAbort.current?.abort(); abortRef.current?.abort(); if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [commandIdentity]);

  useEffect(() => {
    if (!open) {
      selectionAbort.current?.abort(); lock.current = false; setSelecting(false);
      setQuery("");
      setResults([]);
      setIsLoading(false);
      setError(""); setSearchFailed(false);
    }
  }, [open]);

  const search = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.abort();
      setSearchFailed(false);

      if (!q.trim()) {
        setResults([]);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      debounceRef.current = setTimeout(async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          const res = await searchIssues({
            q: q.trim(),
            limit: 20,
            include_closed: true,
            signal: controller.signal,
          });
          if (!controller.signal.aborted) {
            setResults(res.issues.filter(selectable));
            setIsLoading(false);
          }
        } catch {
          if (!controller.signal.aborted) {
            setIsLoading(false);
            setSearchFailed(true);
          }
        }
      }, 300);
    },
    [selectable],
  );

  const row = (issue: Issue) => (
    <CommandItem
      key={issue.id}
      value={issue.id}
      disabled={disabled || selecting}
      onSelect={async () => {
        if (lock.current || disabled) return;
        const captured = commandIdentity; lock.current = true; setSelecting(true); setError("");
        const controller = new AbortController(); selectionAbort.current = controller;
        try {
          await onSelect(issue, controller.signal);
          if (!controller.signal.aborted && current.current === captured) onOpenChange(false);
        } catch (cause) {
          if (!controller.signal.aborted && current.current === captured) setError(cause instanceof Error ? cause.message : issueT(($) => $.detail.update_failed));
        } finally {
          if (!controller.signal.aborted && current.current === captured) { lock.current = false; setSelecting(false); }
        }
      }}
    >
      <StatusIcon
        status={issue.status}
        color={colorOf(issue.status)}
        icon={iconOf(issue.status)}
        category={issueStatusCategory(issue) ?? undefined}
        className="h-3.5 w-3.5 shrink-0"
      />
      <span className="text-muted-foreground shrink-0">{issue.identifier}</span>
      <span className="truncate">{issue.title}</span>
    </CommandItem>
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={(value) => { if (!lock.current) onOpenChange(value); }}
      title={title}
      description={description}
    >
      <Command shouldFilter={false}>
        <CommandInput
          placeholder={t(($) => $.issue_picker.search_placeholder)}
          value={query}
          disabled={selecting}
          onValueChange={(v) => {
            setQuery(v);
            search(v);
          }}
        />
        {notice && <div className="border-b px-3 py-2">{notice}</div>}
        {selecting && <div role="status" className="flex items-center gap-2 px-3 py-2 text-caption"><Spinner />{issueT(($) => $.operation_basis.applying)}</div>}
        {error && <p role="alert" className="px-3 py-2 text-caption text-destructive">{error}</p>}
        {searchFailed && <div role="alert" className="space-y-2 px-3 py-2 text-caption"><p>{issueT(($) => $.operation_basis.search_failed)}</p><Button type="button" size="sm" variant="outline" onClick={() => search(query)}>{issueT(($) => $.operation_basis.retry)}</Button></div>}
        <CommandList>
          {isLoading && (
            <div className="py-6 text-center text-body text-muted-foreground">
              {t(($) => $.issue_picker.searching)}
            </div>
          )}
          {!isLoading && !searchFailed && query.trim() && results.length === 0 && (
            <CommandEmpty>{t(($) => $.issue_picker.no_results)}</CommandEmpty>
          )}
          {!isLoading && !query.trim() && suggestionGroups.length === 0 && (
            <div className="py-6 text-center text-body text-muted-foreground">
              {t(($) => $.issue_picker.prompt_to_search)}
            </div>
          )}
          {!isLoading && !query.trim() &&
            suggestionGroups.map((group) => (
              <CommandGroup key={group.key} heading={group.heading}>
                {group.issues.map(row)}
              </CommandGroup>
            ))}
          {results.length > 0 && <CommandGroup>{results.map(row)}</CommandGroup>}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
