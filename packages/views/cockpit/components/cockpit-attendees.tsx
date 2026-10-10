"use client";

// The attendee picker keeps the meeting's free-text names while browsing
// bounded workspace contact pages. Unit filters are OR; typing searches the
// whole workspace. An empty selected-unit scope falls back only after a real
// server total confirms that it is empty. Selection survives pagination.
// Manual edits await a compact receipt. Auto-file candidates are checked by
// the server against every existing name, not guessed from the visible page.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CockpitDirectoryEntry } from "@multica/core/types";
import {
  cockpitDirectoryPageOptions,
  cockpitDirectoryGroups,
  cockpitDirectoryPosition,
  cockpitDirectoryUnaffiliated,
  joinCockpitMeetingValues,
  splitCockpitMeetingPeople,
} from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useT } from "../../i18n";

/**
 * The idle face of an inline editor, same as every field here: a caret-cursor
 * click puts you inside the value.
 */
const EDITABLE_IDLE =
  "cursor-text hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** One pickable row, in display order — the keyboard highlight walks it. */
interface AttendeeRow {
  key: string;
  name: string;
  party: string;
  position: string;
  /** "seed" is the preset roster: kept forever, no delete affordance. */
  source: string;
  /** True for the flat names under the others bucket (members, board vocabulary). */
  other: boolean;
}

/** The inline editor's draft: a brand-new contact, or an existing row whose
 *  职位 (never the name — it is the identity) is being corrected. */
interface ContactDraft {
  name: string;
  party: string;
  position: string;
  /** Existing rows keep their unit; only a new contact chooses one. */
  partyLocked: boolean;
  clearPosition?: boolean;
}

export interface CockpitAttendeeFieldProps {
  value: string;
  /** Receives the field's whole new value, already joined. */
  onCommit: (next: string) => void;
  /** The meeting's committed parties, already split — they order the groups. */
  parties: string[];
  /** The contact book belongs to the workspace, never a project scope. */
  wsId: string;
  /** Additional explicitly resolved names, not a copy of the contact book. */
  suggestions: string[];
  label: string;
  placeholder: string;
  disabled?: boolean;
  /** Files one contact into the book; resolves whether it landed. */
  onSaveEntry: (entry: CockpitDirectoryEntry & { clear_position?: boolean }) => Promise<boolean>;
  /** Deletes one form-filed contact after its inline confirm; resolves
   *  whether it landed. Absent on servers too old to know deletion. */
  onDeleteEntry?: (entry: { party: string; name: string }) => Promise<boolean>;
  /** Candidates for server-side only_unknown_names filing; no attribution
   *  is guessed when the meeting has more than one unit. */
  onAutoSave?: (entries: CockpitDirectoryEntry[]) => void;
  renderToken?: (token: string) => React.ReactNode;
  /** Renders an others-bucket row (member recognition lives at the call site). */
  renderOption?: (option: string) => React.ReactNode;
  triggerClassName?: string;
}

export function CockpitAttendeeField(props: CockpitAttendeeFieldProps) {
  return <CockpitAttendeeFieldContent key={props.wsId} {...props} />;
}

const EMPTY_DIRECTORY: CockpitDirectoryEntry[] = [];
function CockpitAttendeeFieldContent({
  value,
  onCommit,
  parties,
  wsId,
  suggestions,
  label,
  placeholder,
  disabled,
  onSaveEntry,
  onDeleteEntry,
  onAutoSave,
  renderToken,
  renderOption,
  triggerClassName,
}: CockpitAttendeeFieldProps) {
  const { t } = useT("cockpit");
  const { t: common } = useT("common");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(() => splitCockpitMeetingPeople(value));
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(-1);
  const [contact, setContact] = useState<ContactDraft | null>(null);
  const [saving, setSaving] = useState(false);
  /** Browsing widened past the meeting's own units; a query always widens. */
  const [showAll, setShowAll] = useState(false);
  /** The row mid two-step delete confirm, or null. */
  const [deleting, setDeleting] = useState<AttendeeRow | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  /** Names deleted from the book while the picker is open: the commit's
   * auto-file must not resurrect what this form just removed. */
  const deletedNames = useRef<Set<string>>(new Set());

  const [cursor, setCursor] = useState<string | undefined>();
  const [previous, setPrevious] = useState<(string | undefined)[]>([]);
  const scopeKey = JSON.stringify(parties);
  const [pageScope, setPageScope] = useState(scopeKey);
  const scopedCursor = pageScope === scopeKey ? cursor : undefined;
  const [writeError, setWriteError] = useState(false);
  const live = useRef(true);
  const currentContact = useRef(contact);
  const currentDelete = useRef(deleting);
  currentContact.current = contact;
  currentDelete.current = deleting;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const resetPage = () => { setCursor(undefined); setPrevious([]); };
  const needle = query.trim().toLowerCase();
  const attemptScope = !needle && !showAll && parties.length > 0;
  const scopedFirst = useQuery({ ...cockpitDirectoryPageOptions(wsId, { parties, page_size: 25 }), enabled: editing && attemptScope });
  // Probe only the first bounded page to establish whether the selected units
  // have contacts. A failed probe is not an empty book; an All cursor must
  // never be sent back to the narrower unit scope after the fallback.
  const emptyScope = attemptScope && scopedFirst.isSuccess && scopedFirst.data.total === 0;
  const page = useQuery({ ...cockpitDirectoryPageOptions(wsId, {
    q: query, ...(attemptScope && !emptyScope ? { parties } : {}), cursor: scopedCursor, page_size: 25,
  }), enabled: editing && (!attemptScope || scopedFirst.isSuccess) });
  const activePage = attemptScope && (scopedFirst.isPending || scopedFirst.isError) ? scopedFirst : page;
  const directory = activePage.data?.items ?? EMPTY_DIRECTORY;
  useEffect(() => { setCursor(undefined); setPrevious([]); setPageScope(scopeKey); }, [scopeKey]);

  const committed = useMemo(() => splitCockpitMeetingPeople(value), [value]);
  useEffect(() => {
    if (!editing) {
      setDraft(committed);
      setQuery("");
      setContact(null);
      setDeleting(null);
      setShowAll(false);
      setCursor(undefined);
      setPrevious([]);
      setWriteError(false);
      deletedNames.current.clear();
    }
  }, [committed, editing]);

  // The book can move under an open picker (another client deleted the
  // row): a confirm bar for a row that is no longer there stops rendering
  // instead of acting on a ghost.
  const deletingRow =
    deleting && directory.some((e) => e.party === deleting.party && e.name === deleting.name)
      ? deleting
      : null;

  const chosen = useMemo(() => new Set(draft), [draft]);
  // The book, grouped, the meeting's own parties leading. Browsing scopes to
  // those parties — pick 联通 and 联通's people are what the list shows — with
  // everyone else one toggle away. Typing always searches the whole book, so
  // "联通" still finds the unit's section and a name from any unit.
  const allGroups = useMemo(() => cockpitDirectoryGroups(directory, parties), [directory, parties]);
  const scoped = attemptScope && !emptyScope;
  const groups = allGroups;

  const groupedNames = useMemo(() => {
    const names = new Set<string>();
    for (const group of cockpitDirectoryGroups(directory, [])) {
      for (const entry of group.entries) names.add(entry.name);
    }
    return names;
  }, [directory]);
  const unaffiliated = useMemo(() => {
    const all = cockpitDirectoryUnaffiliated(directory);
    return needle ? all.filter((entry) => entry.name.toLowerCase().includes(needle)) : all;
  }, [directory, needle]);
  // The others bucket: party-less contacts first (they carry a 职位), then
  // the flat names the book does not know — members and board vocabulary.
  const others = useMemo(() => {
    const known = new Set([...groupedNames, ...unaffiliated.map((entry) => entry.name)]);
    const flat = suggestions.filter((name) => !known.has(name));
    return needle ? flat.filter((name) => name.toLowerCase().includes(needle)) : flat;
  }, [suggestions, groupedNames, unaffiliated, needle]);

  // One structure feeds both the keyboard walk and the render, so the two
  // can never disagree about order. The others bucket gets its header only
  // when units lead — a lone flat list is what the field always looked like;
  // its "" header renders as the "others" label. Scoped browsing hides the
  // bucket entirely: it belongs to nobody's unit.
  const sections = useMemo<{ header: string | null; rows: AttendeeRow[] }[]>(() => {
    const out = groups.map((group) => ({
      header: group.party as string | null,
      rows: group.entries.map((entry) => ({
        key: JSON.stringify([group.party, entry.name]),
        name: entry.name,
        party: group.party,
        position: entry.position,
        source: entry.source,
        other: false,
      })),
    }));
    const otherRows: AttendeeRow[] = [
      ...unaffiliated.map((entry) => ({
        key: ` ${entry.name}`,
        name: entry.name,
        party: "",
        position: entry.position,
        source: entry.source,
        other: false,
      })),
      ...others.map((name) => ({
        key: `other:${name}`,
        name,
        party: "",
        position: "",
        source: "",
        other: true,
      })),
    ];
    if (!scoped && otherRows.length > 0) {
      out.push({ header: groups.length > 0 ? "" : null, rows: otherRows });
    }
    return out;
  }, [groups, unaffiliated, others, scoped]);
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

  // Only offer to add what is not already an option or already picked.
  const addable =
    query.trim() && !chosen.has(query.trim()) && !rows.some((row) => row.name === query.trim())
      ? query.trim()
      : "";

  useEffect(() => {
    setHighlighted((h) => Math.min(h, rows.length - 1));
  }, [rows.length]);

  const finish = (next: string[]) => {
    setEditing(false);
    setHighlighted(-1);
    setQuery("");
    setContact(null);
    const joined = joinCockpitMeetingValues(next);
    if (joined !== joinCockpitMeetingValues(committed)) {
      onCommit(joined);
      // The server checks these candidates against all known names. A page
      // cannot prove that a name is absent from another unit or later page.
      const fresh: CockpitDirectoryEntry[] = parties.length === 1 && parties[0]
        ? next.filter((name) => !deletedNames.current.has(name)).map((name) => ({ party: parties[0]!, name, position: "", source: "user" }))
        : [];
      if (fresh.length > 0) onAutoSave?.(fresh);
    }
  };

  const revert = () => {
    setEditing(false);
    setHighlighted(-1);
    setQuery("");
    setContact(null);
    setDraft(committed);
  };

  const toggle = (name: string) =>
    setDraft((current) =>
      current.includes(name) ? current.filter((v) => v !== name) : [...current, name],
    );

  const addTyped = (name: string) => {
    toggle(name);
    setQuery("");
    resetPage();
    setHighlighted(-1);
    // A name the book does not know gets the inline editor: 职位 optional,
    // unit defaulted to the meeting's own. Cancelling it keeps the token —
    // the auto-save on commit still files the bare name when it can.
    setContact({ name, party: parties[0] ?? "", position: "", partyLocked: false });
  };

  const saveContact = async () => {
    if (!contact || saving) return;
    setSaving(true);
    setWriteError(false);
    const captured = contact;
    try {
      const ok = await onSaveEntry({
        party: contact.party.trim(),
        name: contact.name,
        position: contact.position.trim(),
        source: "user",
        ...(contact.clearPosition ? { clear_position: true } : {}),
      });
      if (live.current && currentContact.current === captured) { if (ok) setContact(null); else setWriteError(true); }
    } catch {
      if (live.current && currentContact.current === captured) setWriteError(true);
    } finally {
      if (live.current) setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting || deleteBusy || !onDeleteEntry) return;
    setDeleteBusy(true);
    setWriteError(false);
    const captured = deleting;
    try {
      const ok = await onDeleteEntry({ party: deleting.party, name: deleting.name });
      if (ok && live.current && currentDelete.current === captured) {
        deletedNames.current.add(deleting.name);
        setDeleting(null);
      } else if (live.current && currentDelete.current === captured) setWriteError(true);
    } catch {
      if (live.current && currentDelete.current === captured) setWriteError(true);
    } finally {
      if (live.current) setDeleteBusy(false);
    }
  };

  const display = committed.map((token) => {
    const position = cockpitDirectoryPosition(directory, token, parties);
    return (
      <span key={token} title={position ? `${token} · ${position}` : undefined}>
        {renderToken ? (
          renderToken(token)
        ) : (
          <span className="rounded-sm bg-muted px-1 text-caption">{token}</span>
        )}
      </span>
    );
  });

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setEditing(true)}
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1 rounded-sm px-1 text-left",
        !disabled && EDITABLE_IDLE,
        triggerClassName,
      )}
    >
      {committed.length > 0 ? (
        display
      ) : (
        <span className="text-caption text-muted-foreground italic">{placeholder}</span>
      )}
    </button>
  );

  if (disabled || !editing) return trigger;

  const optionRow = (row: AttendeeRow, index: number) => (
    <button
      type="button"
      role="option"
      aria-selected={chosen.has(row.name)}
      ref={(el) => {
        if (index === highlighted && typeof el?.scrollIntoView === "function") {
          el.scrollIntoView({ block: "nearest" });
        }
      }}
      onMouseDown={(e) => e.preventDefault()}
      // Move, not enter (see EditableTokens): the list re-renders under a
      // still cursor, and an enter fired by the list moving would hand the
      // keyboard highlight to whatever landed under the pointer.
      onMouseMove={() => setHighlighted(index)}
      onClick={() => {
        toggle(row.name);
        setHighlighted(-1);
      }}
      title={row.position ? `${row.name} · ${row.position}` : row.name}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-2 py-1 text-left text-caption",
        index === highlighted ? "bg-accent" : "hover:bg-accent/50",
      )}
    >
      <Check
        className={cn("size-3 shrink-0", chosen.has(row.name) ? "" : "opacity-0")}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">
        {row.other && renderOption ? renderOption(row.name) : row.name}
      </span>
      {row.position && (
        <span className="max-w-32 shrink-0 truncate text-micro text-muted-foreground">
          {row.position}
        </span>
      )}
    </button>
  );

  return (
    <Popover
      open
      onOpenChange={(open, details) => {
        if (open) return;
        // Escape while the contact editor or the delete confirm is open
        // closes just that — the tokens chosen so far are not a mistake to
        // revert.
        if (details.reason === "escape-key") {
          if (contact) setContact(null);
          else if (deletingRow) setDeleting(null);
          else revert();
        } else {
          finish(draft);
        }
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" tabIndex={-1} className="w-72 gap-1 p-1" aria-label={label}>
        {draft.length > 0 && (
          <ul className="flex flex-wrap gap-1 px-1 pt-1">
            {draft.map((token) => (
              <li key={token}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggle(token)}
                  aria-label={t(($) => $.common.remove_value, { value: token })}
                  className="flex items-center gap-0.5 rounded-sm bg-muted px-1 text-caption hover:bg-accent"
                >
                  <span className="max-w-32 truncate">{token}</span>
                  <X className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <Input
          autoFocus
          aria-label={label}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            resetPage();
            setHighlighted(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const row = rows[highlighted];
              if (row != null) toggle(row.name);
              else if (addable) addTyped(addable);
              // Enter on an empty box is how the keyboard says "done".
              else if (!query.trim()) {
                finish(draft);
                return;
              }
              setQuery("");
              resetPage();
              setHighlighted(-1);
            } else if (e.key === "Backspace" && !query) {
              setDraft((current) => current.slice(0, -1));
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlighted((h) => Math.min(h + 1, rows.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlighted((h) => Math.max(h - 1, -1));
            } else if (e.key === "Escape") {
              e.preventDefault();
              if (contact) setContact(null);
              else if (deletingRow) setDeleting(null);
              else revert();
            }
          }}
          className="h-7 px-2 text-caption"
        />
        <div className="flex flex-wrap items-center justify-between gap-1 px-1" aria-label={t(($) => $.directory.page_label)}>
          <span className="text-micro text-muted-foreground">{t(($) => $.directory.workspace_scope)}</span>
          {activePage.data && <span className="text-micro text-muted-foreground">{t(($) => $.directory.total, { count: activePage.data.total })}</span>}
          <Button type="button" size="xs" variant="ghost" disabled={!previous.length || activePage.isFetching} onClick={() => { setCursor(previous.at(-1)); setPrevious(previous.slice(0, -1)); }}>{t(($) => $.task_flow.previous)}</Button>
          <Button type="button" size="xs" variant="ghost" disabled={!activePage.data?.next_cursor || activePage.isFetching} onClick={() => { setPrevious([...previous, cursor]); setCursor(activePage.data?.next_cursor ?? undefined); }}>{t(($) => $.task_flow.next)}</Button>
        </div>
        {activePage.isPending && <p role="status" className="px-2 text-caption">{common(($) => $.loading)}</p>}
        {activePage.isError && <div role="alert" className="px-2 text-caption text-destructive">
          {t(($) => $.directory.load_failed)}
          <Button type="button" variant="ghost" size="xs" onClick={() => void activePage.refetch()}>{t(($) => $.directory.retry)}</Button>
          {cursor && <Button type="button" variant="ghost" size="xs" onClick={resetPage}>{t(($) => $.directory.first_page)}</Button>}
        </div>}
        {writeError && <p role="alert" className="px-2 text-caption text-destructive">{t(($) => $.directory.write_failed)}</p>}
        {(rows.length > 0 || addable) && (
          <ul
            role="listbox"
            aria-multiselectable
            aria-label={label}
            className="max-h-64 overflow-y-auto"
          >
            {addable && (
              <li>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => addTyped(addable)}
                  className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-caption hover:bg-accent/50"
                >
                  <Plus className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{t(($) => $.common.add_value, { value: addable })}</span>
                </button>
              </li>
            )}
            {(() => {
              let index = -1;
              return sections.map((section, s) => (
                // role=presentation on the structural wrappers keeps the
                // options owned by the listbox; a real section is a named
                // group, its visible header mirrored by aria-label.
                <li key={section.header ?? `section-${s}`} role="presentation">
                  {section.header !== null && (
                    <div
                      aria-hidden="true"
                      className="px-2 pt-1.5 pb-0.5 text-micro font-medium tracking-wide text-muted-foreground"
                    >
                      {section.header === ""
                        ? t(($) => $.meetings.directory_others)
                        : section.header}
                    </div>
                  )}
                  <ul
                    role={section.header === null ? "presentation" : "group"}
                    aria-label={
                      section.header === null
                        ? undefined
                        : section.header === ""
                          ? t(($) => $.meetings.directory_others)
                          : section.header
                    }
                  >
                    {section.rows.map((row) => {
                      index += 1;
                      const i = index;
                      return (
                        <li key={row.key} role="presentation" className="group/row flex items-center">
                          {optionRow(row, i)}
                          {!row.other && (row.source === "user" || row.source === "seed") && (
                            <>
                              <button
                                type="button"
                                aria-label={t(($) => $.meetings.directory_edit, { name: row.name })}
                                onMouseDown={(e) => e.preventDefault()}
                                onClick={() => {
                                  setDeleting(null);
                                  setContact({
                                    name: row.name,
                                    party: row.party,
                                    position: row.position,
                                    partyLocked: true,
                                  });
                                }}
                                className={cn(
                                  "shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-accent focus-visible:opacity-100",
                                  (row.source === "seed" || !onDeleteEntry) && "mr-1",
                                )}
                              >
                                <Pencil className="size-3" aria-hidden />
                              </button>
                              {row.source === "user" && onDeleteEntry && (
                                <button
                                  type="button"
                                  aria-label={t(($) => $.meetings.directory_delete, { name: row.name })}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => {
                                    setContact(null);
                                    setDeleting(row);
                                  }}
                                  className="mr-1 shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-accent hover:text-destructive focus-visible:opacity-100"
                                >
                                  <Trash2 className="size-3" aria-hidden />
                                </button>
                              )}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ));
            })()}
          </ul>
        )}
        {!needle && parties.length > 0 && !emptyScope && (
          // Browsing is scoped to the meeting's units; this row widens it (or
          // narrows it back). A typed query always searches the whole book, so
          // the toggle only exists while the box is empty.
          <button
            type="button"
            onClick={() => { setShowAll((v) => !v); resetPage(); }}
            className="w-full rounded-sm border-t border-border px-2 py-1 text-left text-micro text-muted-foreground hover:bg-accent/50"
          >
            {showAll
              ? t(($) => $.meetings.directory_only_parties)
              : t(($) => $.meetings.directory_show_all)}
          </button>
        )}
        {deletingRow && (
          // The delete's second step, inline: a modal dialog here would close
          // the popover (its buttons are an outside press) and commit the
          // half-picked tokens with it.
          <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
            <span className="text-caption">
              {t(($) => $.meetings.directory_delete_confirm, { name: deletingRow.name })}
            </span>
            {deletingRow.party && (
              <span className="text-caption text-muted-foreground">{deletingRow.party}</span>
            )}
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                size="xs"
                disabled={deleteBusy}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setDeleting(null)}
              >
                {common(($) => $.cancel)}
              </Button>
              <Button
                variant="destructive"
                size="xs"
                disabled={deleteBusy}
                aria-busy={deleteBusy}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void confirmDelete()}
              >
                {common(($) => $.delete)}
              </Button>
            </div>
          </div>
        )}
        {contact && (
          <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
            <span className="text-caption font-medium">{contact.name}</span>
            {contact.partyLocked ? (
              contact.party && (
                <span className="text-caption text-muted-foreground">{contact.party}</span>
              )
            ) : parties.length > 0 ? (
              // A new contact belongs to one of the units at the table; a
              // unit nobody chose for the meeting is added to the parties
              // field first, and then it is a chip here.
              <div className="flex flex-wrap gap-1">
                {parties.map((party) => (
                  <button
                    key={party}
                    type="button"
                    aria-pressed={contact.party === party}
                    onClick={() => setContact({ ...contact, party })}
                    className={cn(
                      "rounded-sm px-1.5 py-0.5 text-caption",
                      contact.party === party
                        ? "bg-accent font-medium"
                        : "bg-muted hover:bg-accent/60",
                    )}
                  >
                    {party}
                  </button>
                ))}
              </div>
            ) : (
              <Input
                aria-label={t(($) => $.meeting.parties)}
                placeholder={t(($) => $.meetings.directory_party_placeholder)}
                value={contact.party}
                onChange={(e) => setContact({ ...contact, party: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveContact();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setContact(null);
                  }
                }}
                className="h-7 px-2 text-caption"
              />
            )}
            <Input
              aria-label={t(($) => $.meeting.position)}
              placeholder={t(($) => $.meetings.directory_position_placeholder)}
              value={contact.position}
              onChange={(e) => setContact({ ...contact, position: e.target.value, clearPosition: false })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void saveContact();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setContact(null);
                }
              }}
              className="h-7 px-2 text-caption"
            />
            {contact.partyLocked && <Button type="button" size="xs" variant="ghost" disabled={saving} onClick={() => setContact({ ...contact, position: "", clearPosition: true })}>
              {contact.clearPosition ? t(($) => $.directory.position_will_clear) : t(($) => $.directory.clear_position)}
            </Button>}
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                size="xs"
                disabled={saving}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setContact(null)}
              >
                {common(($) => $.cancel)}
              </Button>
              <Button
                size="xs"
                disabled={saving}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void saveContact()}
              >
                {common(($) => $.save)}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
