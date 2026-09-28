"use client";

// The register's search and filters: one reading of the board's meetings,
// shared by every view on the tab.
//
// The quick search answers "the meeting about X"; the popover answers "every
// 研讨会 with 华为 on the AI平台 line this quarter". Both feed the same
// predicate in @multica/core/cockpit, so the count in the toolbar, the chips
// below it and the rows on screen are one fact, not three.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CockpitMeeting } from "@multica/core/types";
import {
  COCKPIT_MEETING_ONLY_FLAGS,
  countCockpitMeetingFilters,
  cockpitMeetingTrackColor,
  cockpitMeetingVocabulary,
  emptyCockpitMeetingFilter,
  type CockpitMeetingFilter,
  type CockpitMeetingOnlyFlag,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { CalendarDays, ListFilter, Search, X } from "lucide-react";
import { useT } from "../../i18n";

export interface CockpitMeetingFilterBarProps {
  filter: CockpitMeetingFilter;
  onChange: (next: CockpitMeetingFilter) => void;
  /** Every meeting on the board — the popover's vocabulary comes from what
   *  the programme has actually used, not from what is currently visible. */
  meetings: CockpitMeeting[];
  today: string;
}

/** Toggles one value in a multi-select list. */
function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function toggleFlag(
  list: CockpitMeetingOnlyFlag[],
  flag: CockpitMeetingOnlyFlag,
): CockpitMeetingOnlyFlag[] {
  return list.includes(flag) ? list.filter((f) => f !== flag) : [...list, flag];
}

/** A labelled row of toggle chips inside the popover. */
function ChipSection({
  label,
  values,
  selected,
  onToggle,
  colors,
}: {
  label: string;
  values: readonly { value: string; label: string }[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  colors?: (value: string) => string;
}) {
  if (values.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-micro font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">
        {values.map(({ value, label: text }) => {
          const on = selected.includes(value);
          const color = colors?.(value);
          return (
            <button
              key={value || "__none__"}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(value)}
              className={cn(
                "flex h-6 items-center gap-1 rounded-full border px-2 text-micro transition-colors",
                on
                  ? "border-brand/40 bg-brand/10 font-medium text-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/25 hover:text-foreground",
              )}
            >
              {color && (
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: color }}
                  aria-hidden
                />
              )}
              {text}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The quick ranges a leadership review actually asks for. */
function quickRange(which: "month" | "last30" | "year", today: string): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (which === "month") {
    const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    return { from: `${y}-${pad(m!)}-01`, to: `${y}-${pad(m!)}-${pad(last)}` };
  }
  if (which === "last30") {
    const from = new Date(Date.UTC(y!, m! - 1, 1));
    from.setUTCDate(from.getUTCDate() - 29);
    const fmt = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return { from: fmt(from), to: today };
  }
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

/** The quick search box and the filter popover, for the register's toolbar. */
export function CockpitMeetingFilterBar({
  filter,
  onChange,
  meetings,
  today,
}: CockpitMeetingFilterBarProps) {
  const { t } = useT("cockpit");
  const [open, setOpen] = useState(false);
  const [partyQuery, setPartyQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const vocabulary = useMemo(() => cockpitMeetingVocabulary(meetings), [meetings]);
  const active = countCockpitMeetingFilters(filter);
  const filtering = active > 0;

  // "/" focuses the search from anywhere on the tab; Esc inside it clears and
  // hands focus back. Typing into another field never triggers either.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("input, textarea, [contenteditable=true]") || target.closest("[role=dialog]"))) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const patch = (part: Partial<CockpitMeetingFilter>) => onChange({ ...filter, ...part });

  const partyOptions = useMemo(() => {
    const query = partyQuery.trim().toLowerCase();
    const list = query
      ? vocabulary.parties.filter((p) => p.toLowerCase().includes(query))
      : vocabulary.parties;
    return list.slice(0, 12);
  }, [vocabulary.parties, partyQuery]);

  const onlyLabels: Record<CockpitMeetingOnlyFlag, string> = {
    consensus: t(($) => $.meetings.only_consensus),
    folder: t(($) => $.meetings.only_folder),
    links: t(($) => $.meetings.only_links),
    detected: t(($) => $.meetings.only_detected),
  };

  const quickRanges = [
    { key: "month", label: t(($) => $.meetings.filter_quick_month) },
    { key: "last30", label: t(($) => $.meetings.filter_quick_last30) },
    { key: "year", label: t(($) => $.meetings.filter_quick_year) },
  ] as const;

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={searchRef}
          value={filter.query}
          onChange={(e) => patch({ query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter.query) {
              patch({ query: "" });
              e.currentTarget.blur();
            }
          }}
          placeholder={t(($) => $.meetings.search_placeholder)}
          aria-label={t(($) => $.meetings.search)}
          className="h-7 w-48 pl-7 pr-6 text-caption"
        />
        {filter.query ? (
          <button
            type="button"
            aria-label={t(($) => $.meetings.search_clear)}
            onClick={() => patch({ query: "" })}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border border-border px-1 text-micro leading-3 text-faint-foreground">
            /
          </kbd>
        )}
      </div>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant={filtering ? "secondary" : "ghost"}
              size="sm"
              className="h-7 gap-1 px-2"
              aria-label={t(($) => $.meetings.filter)}
            >
              <ListFilter className="size-3.5" />
              {t(($) => $.meetings.filter)}
              {filtering && (
                <span className="rounded-full bg-brand px-1.5 py-px text-micro leading-4 font-medium text-brand-foreground">
                  {active}
                </span>
              )}
            </Button>
          }
        />
        <PopoverContent align="start" className="flex w-80 flex-col gap-3 p-3">
          {/* The date range, with the ranges a review actually asks for one
              tap away. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-micro font-medium tracking-wide text-muted-foreground uppercase">
              {t(($) => $.meetings.filter_date)}
            </span>
            <div className="flex items-center gap-1.5">
              <Input
                type="date"
                value={filter.from}
                onChange={(e) => patch({ from: e.target.value })}
                aria-label={t(($) => $.meetings.filter_date_from)}
                className="h-7 flex-1 text-caption"
              />
              <span className="text-muted-foreground">–</span>
              <Input
                type="date"
                value={filter.to}
                onChange={(e) => patch({ to: e.target.value })}
                aria-label={t(($) => $.meetings.filter_date_to)}
                className="h-7 flex-1 text-caption"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {quickRanges.map(({ key, label }) => {
                const range = quickRange(key, today);
                const on = filter.from === range.from && filter.to === range.to;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => patch(on ? { from: "", to: "" } : range)}
                    className={cn(
                      "flex h-6 items-center gap-1 rounded-full border px-2 text-micro transition-colors",
                      on
                        ? "border-brand/40 bg-brand/10 font-medium text-foreground"
                        : "border-border text-muted-foreground hover:border-foreground/25 hover:text-foreground",
                    )}
                  >
                    <CalendarDays className="size-3" aria-hidden />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <ChipSection
            label={t(($) => $.meetings.filter_track)}
            values={[
              ...vocabulary.tracks.map((track) => ({ value: track, label: track })),
              { value: "", label: t(($) => $.meetings.track_none) },
            ]}
            selected={filter.tracks}
            onToggle={(track) => patch({ tracks: toggle(filter.tracks, track) })}
            colors={(track) => cockpitMeetingTrackColor(track)}
          />
          <ChipSection
            label={t(($) => $.meetings.filter_kind)}
            values={vocabulary.kinds.map((kind) => ({ value: kind, label: kind }))}
            selected={filter.kinds}
            onToggle={(kind) => patch({ kinds: toggle(filter.kinds, kind) })}
          />
          <ChipSection
            label={t(($) => $.meetings.filter_status)}
            values={vocabulary.statuses.map((status) => ({ value: status, label: status }))}
            selected={filter.statuses}
            onToggle={(status) => patch({ statuses: toggle(filter.statuses, status) })}
          />

          {/* Parties can be a long list; it searches rather than scrolls. */}
          {vocabulary.parties.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-micro font-medium tracking-wide text-muted-foreground uppercase">
                {t(($) => $.meetings.filter_parties)}
              </span>
              {vocabulary.parties.length > 8 && (
                <Input
                  value={partyQuery}
                  onChange={(e) => setPartyQuery(e.target.value)}
                  placeholder={t(($) => $.meetings.filter_parties_placeholder)}
                  aria-label={t(($) => $.meetings.filter_parties_placeholder)}
                  className="h-7 text-caption"
                />
              )}
              <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
                {partyOptions.map((party) => {
                  const on = filter.parties.includes(party);
                  return (
                    <button
                      key={party}
                      type="button"
                      aria-pressed={on}
                      onClick={() => patch({ parties: toggle(filter.parties, party) })}
                      className={cn(
                        "flex h-6 items-center rounded-full border px-2 text-micro transition-colors",
                        on
                          ? "border-brand/40 bg-brand/10 font-medium text-foreground"
                          : "border-border text-muted-foreground hover:border-foreground/25 hover:text-foreground",
                      )}
                    >
                      {party}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <ChipSection
            label={t(($) => $.meetings.filter_only)}
            values={COCKPIT_MEETING_ONLY_FLAGS.map((flag) => ({
              value: flag,
              label: onlyLabels[flag],
            }))}
            selected={filter.only}
            onToggle={(flag) =>
              patch({ only: toggleFlag(filter.only, flag as CockpitMeetingOnlyFlag) })
            }
          />

          {filtering && (
            <div className="flex justify-end border-t border-border pt-2">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-caption"
                onClick={() => onChange(emptyCockpitMeetingFilter())}
              >
                {t(($) => $.meetings.filter_clear)}
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * The active filters as a row of removable chips under the toolbar — its own
 * row, not a toolbar item, so the toolbar never grows a second line's worth
 * of chips inside itself. A filter you cannot see is a filter that confuses
 * the next person who opens the tab, so every group in the register's current
 * reading is stated here, each with its own remove.
 */
export function CockpitMeetingFilterChips({
  filter,
  onChange,
  shown,
  total,
}: {
  filter: CockpitMeetingFilter;
  onChange: (next: CockpitMeetingFilter) => void;
  shown: number;
  total: number;
}) {
  const { t } = useT("cockpit");
  const patch = (part: Partial<CockpitMeetingFilter>) => onChange({ ...filter, ...part });

  const onlyLabels: Record<CockpitMeetingOnlyFlag, string> = {
    consensus: t(($) => $.meetings.only_consensus),
    folder: t(($) => $.meetings.only_folder),
    links: t(($) => $.meetings.only_links),
    detected: t(($) => $.meetings.only_detected),
  };

  const chips = useMemo(() => {
    const out: { key: string; text: string; clear: () => void }[] = [];
    if (filter.query.trim()) {
      out.push({
        key: "query",
        text: t(($) => $.meetings.chip_query, { query: filter.query.trim() }),
        clear: () => patch({ query: "" }),
      });
    }
    if (filter.from || filter.to) {
      const text = filter.from && filter.to
        ? t(($) => $.meetings.chip_date_between, { from: filter.from, to: filter.to })
        : filter.from
          ? t(($) => $.meetings.chip_date_from, { from: filter.from })
          : t(($) => $.meetings.chip_date_to, { to: filter.to });
      out.push({ key: "date", text, clear: () => patch({ from: "", to: "" }) });
    }
    const named = (
      key: "tracks" | "kinds" | "statuses" | "parties",
      title: string,
      values: string[],
    ) => {
      if (values.length === 0) return;
      const names = values
        .map((v) => (key === "tracks" && v === "" ? t(($) => $.meetings.track_none) : v))
        .join("、");
      out.push({
        key,
        text: t(($) => $.meetings.chip_group, { title, values: names }),
        clear: () => patch({ [key]: [] }),
      });
    };
    named("tracks", t(($) => $.meetings.filter_track), filter.tracks);
    named("kinds", t(($) => $.meetings.filter_kind), filter.kinds);
    named("statuses", t(($) => $.meetings.filter_status), filter.statuses);
    named("parties", t(($) => $.meetings.filter_parties), filter.parties);
    for (const flag of filter.only) {
      out.push({
        key: `only-${flag}`,
        text: onlyLabels[flag],
        clear: () => patch({ only: filter.only.filter((f) => f !== flag) }),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, t]);

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border bg-muted/30 px-4 py-1.5">
      <span className="text-micro text-muted-foreground tabular-nums">
        {t(($) => $.meetings.results, { shown, total })}
      </span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="flex h-5 items-center gap-1 rounded-full border border-brand/30 bg-brand/10 px-2 text-micro"
        >
          {chip.text}
          <button
            type="button"
            aria-label={t(($) => $.meetings.chip_remove, { label: chip.text })}
            onClick={chip.clear}
            className="rounded-full text-muted-foreground hover:text-foreground"
          >
            <X className="size-2.5" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => onChange(emptyCockpitMeetingFilter())}
        className="text-micro text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {t(($) => $.meetings.filter_clear)}
      </button>
    </div>
  );
}
