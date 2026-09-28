"use client";

// The attendee picker.
//
// A meeting stores its people as one "、"-joined string, but picking them is
// not a flat search across everyone the board has ever met: the room is read
// by unit first ("深圳联通 sent …"). Once the parties field says who is at
// the table, this picker groups the contact book by those units — each row a
// name with its 职位 — so the unit's people are one glance and any number of
// ticks away. Everyone else (workspace members, names the board has used,
// contacts without a unit) follows under one "others" bucket.
//
// The book grows by using the form: a typed-in name is offered for filing
// under the meeting's unit when the field commits (the edit panel saves at
// once; the create form holds it until the meeting exists), and the "new
// contact" row opens a small editor for the 职位 (and the unit, when several
// are at the table) that saves on the spot. The hint under the field says so
// — copy in meetings.directory_hint.

import { useEffect, useMemo, useState } from "react";
import type { CockpitDirectoryEntry } from "@multica/core/types";
import {
  cockpitDirectoryAutoSaveEntries,
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
import { Check, Pencil, Plus, X } from "lucide-react";
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
}

export interface CockpitAttendeeFieldProps {
  value: string;
  /** Receives the field's whole new value, already joined. */
  onCommit: (next: string) => void;
  /** The meeting's committed parties, already split — they order the groups. */
  parties: string[];
  /** The contact book as the server knows it. */
  directory: CockpitDirectoryEntry[];
  /** Flat names beyond the book: workspace members, then names the board has
   *  used. A name the book knows never appears here — its group row is the
   *  one place it shows. */
  suggestions: string[];
  label: string;
  placeholder: string;
  disabled?: boolean;
  /** Files one contact into the book; resolves whether it landed. */
  onSaveEntry: (entry: CockpitDirectoryEntry) => Promise<boolean>;
  /** Fires after a commit with the attendees the book did not know,
   *  attributed to the meeting's unit (empty when the unit is ambiguous). */
  onAutoSave?: (entries: CockpitDirectoryEntry[]) => void;
  renderToken?: (token: string) => React.ReactNode;
  /** Renders an others-bucket row (member recognition lives at the call site). */
  renderOption?: (option: string) => React.ReactNode;
  triggerClassName?: string;
}

export function CockpitAttendeeField({
  value,
  onCommit,
  parties,
  directory,
  suggestions,
  label,
  placeholder,
  disabled,
  onSaveEntry,
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

  const committed = useMemo(() => splitCockpitMeetingPeople(value), [value]);
  useEffect(() => {
    if (!editing) {
      setDraft(committed);
      setQuery("");
      setContact(null);
    }
  }, [committed, editing]);

  const chosen = useMemo(() => new Set(draft), [draft]);
  const needle = query.trim().toLowerCase();

  // The book, grouped. The meeting's own parties lead; a contact row matches
  // the query by name, 职位 or unit, so "联通" finds the unit's section.
  const groups = useMemo(() => {
    const all = cockpitDirectoryGroups(directory, parties);
    if (!needle) return all;
    return all
      .map((group) => ({
        ...group,
        entries: group.entries.filter(
          (entry) =>
            entry.name.toLowerCase().includes(needle) ||
            entry.position.toLowerCase().includes(needle) ||
            group.party.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.entries.length > 0);
  }, [directory, parties, needle]);

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
  // its "" header renders as the "others" label.
  const sections = useMemo<{ header: string | null; rows: AttendeeRow[] }[]>(() => {
    const out = groups.map((group) => ({
      header: group.party as string | null,
      rows: group.entries.map((entry) => ({
        key: `${group.party} ${entry.name}`,
        name: entry.name,
        party: group.party,
        position: entry.position,
        other: false,
      })),
    }));
    const otherRows: AttendeeRow[] = [
      ...unaffiliated.map((entry) => ({
        key: ` ${entry.name}`,
        name: entry.name,
        party: "",
        position: entry.position,
        other: false,
      })),
      ...others.map((name) => ({ key: `other:${name}`, name, party: "", position: "", other: true })),
    ];
    if (otherRows.length > 0) {
      out.push({ header: groups.length > 0 ? "" : null, rows: otherRows });
    }
    return out;
  }, [groups, unaffiliated, others]);
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
      // The book learns by being used: names nobody picked from it are filed
      // under the meeting's unit, so the next form offers them directly.
      const fresh = cockpitDirectoryAutoSaveEntries(directory, parties.join("、"), joined);
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
    setHighlighted(-1);
    // A name the book does not know gets the inline editor: 职位 optional,
    // unit defaulted to the meeting's own. Cancelling it keeps the token —
    // the auto-save on commit still files the bare name when it can.
    setContact({ name, party: parties[0] ?? "", position: "", partyLocked: false });
  };

  const saveContact = async () => {
    if (!contact || saving) return;
    setSaving(true);
    try {
      const ok = await onSaveEntry({
        party: contact.party.trim(),
        name: contact.name,
        position: contact.position.trim(),
      });
      if (ok) setContact(null);
    } finally {
      setSaving(false);
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
        // Escape while the contact editor is open closes the editor, not the
        // picker — the tokens chosen so far are not a mistake to revert.
        if (details.reason === "escape-key") {
          if (contact) setContact(null);
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
              else revert();
            }
          }}
          className="h-7 px-2 text-caption"
        />
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
                          {!row.other && (
                            <button
                              type="button"
                              aria-label={t(($) => $.meetings.directory_edit, { name: row.name })}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() =>
                                setContact({
                                  name: row.name,
                                  party: row.party,
                                  position: row.position,
                                  partyLocked: true,
                                })
                              }
                              className="mr-1 shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-accent focus-visible:opacity-100"
                            >
                              <Pencil className="size-3" aria-hidden />
                            </button>
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
              onChange={(e) => setContact({ ...contact, position: e.target.value })}
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
            <div className="flex justify-end gap-1">
              <Button
                variant="ghost"
                size="xs"
                disabled={saving}
                onClick={() => setContact(null)}
              >
                {common(($) => $.cancel)}
              </Button>
              <Button size="xs" disabled={saving} onClick={() => void saveContact()}>
                {common(($) => $.save)}
              </Button>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
