"use client";

// Inline editors: the same element that displays a value is the one that edits
// it. The board this feature replaces kept a separate "data maintenance" screen,
// so every correction meant leaving the view that showed the problem — the
// number you were reading and the number you were fixing were never on screen
// together.
//
// Commit rules are uniform across every field here: Enter (or blur) saves,
// Escape reverts and gives focus back to the display. Nothing autosaves
// mid-keystroke, so a half-typed value never reaches other people's screens.

import { useEffect, useMemo, useRef, useState } from "react";
import { joinCockpitMeetingValues } from "@multica/core/cockpit";
import { cn } from "@multica/ui/lib/utils";
import { Input } from "@multica/ui/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Check, Plus, X } from "lucide-react";
import { useT } from "../../i18n";

/**
 * The idle face of an inline editor. The caret is what tells it apart from
 * everything else on this board that answers a click: a caret means the click
 * puts you inside the value, a pointer means it takes you somewhere else.
 * Without it every one of these reads as static text until tried.
 */
const EDITABLE_IDLE =
  "cursor-text hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

interface EditableProps {
  value: string;
  onCommit: (next: string) => void;
  /** Shown in place of an empty value; also the input's placeholder. */
  placeholder: string;
  /** Accessible name for the edit control. */
  label: string;
  className?: string;
  displayClassName?: string;
  disabled?: boolean;
  /**
   * What the idle state shows, when that differs from what editing edits — a
   * dense row can only fit "李林" where the field holds "李林（POOL 超饱和）".
   */
  displayValue?: string;
}

/**
 * A one-line editable value. Renders as text until clicked, so a dense table
 * row still reads as a table row rather than a wall of input boxes.
 */
export function EditableText({
  value,
  onCommit,
  placeholder,
  label,
  className,
  displayClassName,
  disabled,
  displayValue,
}: EditableProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const displayRef = useRef<HTMLButtonElement>(null);

  // A collaborator's edit to the same field must land while we are idle, but
  // must not yank the text out from under someone who is typing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = (next: string) => {
    setEditing(false);
    if (next !== value) onCommit(next);
  };

  if (disabled) {
    return (
      <span className={cn("text-body", !value && "text-muted-foreground", displayClassName)}>
        {displayValue || value || placeholder}
      </span>
    );
  }

  if (!editing) {
    return (
      <button
        ref={displayRef}
        type="button"
        onClick={() => setEditing(true)}
        aria-label={label}
        className={cn(
          "min-w-0 truncate rounded-sm px-1 text-left text-body",
          EDITABLE_IDLE,
          !value && "text-muted-foreground italic",
          displayClassName,
        )}
      >
        {displayValue || value || placeholder}
      </button>
    );
  }

  return (
    <Input
      autoFocus
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
          displayRef.current?.focus();
        }
      }}
      className={cn("h-7 px-1 text-body", className)}
    />
  );
}

/** Multi-line variant. Shift+Enter inserts a newline; Enter still commits. */
export function EditableTextArea({
  value,
  onCommit,
  placeholder,
  label,
  rows = 3,
  disabled,
}: EditableProps & { rows?: number }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = (next: string) => {
    setEditing(false);
    if (next !== value) onCommit(next);
  };

  if (disabled || !editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        aria-label={label}
        className={cn(
          "w-full rounded-sm px-1 py-0.5 text-left text-body whitespace-pre-wrap",
          !disabled && EDITABLE_IDLE,
          !value && "text-muted-foreground italic",
        )}
      >
        {value || placeholder}
      </button>
    );
  }

  return (
    <Textarea
      autoFocus
      aria-label={label}
      placeholder={placeholder}
      rows={rows}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      className="text-body"
    />
  );
}

/**
 * A calendar day. Uses a native date input so the platform's own picker (and
 * its keyboard handling) is what people get — the value on the wire is always
 * "YYYY-MM-DD" or null, matching the API.
 */
export function EditableDate({
  value,
  onCommit,
  label,
  placeholder,
  disabled,
  className,
  displayClassName,
}: {
  value: string | null;
  onCommit: (next: string | null) => void;
  label: string;
  placeholder: string;
  disabled?: boolean;
  className?: string;
  /** Display-mode only — lets the value sit on a coloured surface without
   * recolouring the editing input. */
  displayClassName?: string;
}) {
  const [editing, setEditing] = useState(false);

  if (disabled || !editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        aria-label={label}
        className={cn(
          "rounded-sm px-1 text-left text-caption tabular-nums",
          !disabled && EDITABLE_IDLE,
          !value && "text-muted-foreground italic",
          className,
          displayClassName,
        )}
      >
        {value || placeholder}
      </button>
    );
  }

  return (
    <Input
      autoFocus
      type="date"
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onCommit(e.target.value ? e.target.value : null)}
      onBlur={() => setEditing(false)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          setEditing(false);
        }
      }}
      className={cn("h-7 w-[9.5rem] px-1 text-caption", className)}
    />
  );
}

/**
 * A number. `value` is null when the field carries no figure at all, which the
 * board distinguishes from zero — a task with no budget line is not a task
 * budgeted at nothing.
 */
export function EditableNumber({
  value,
  onCommit,
  label,
  placeholder,
  suffix,
  min,
  max,
  disabled,
  className,
}: {
  value: number | null;
  onCommit: (next: number | null) => void;
  label: string;
  placeholder: string;
  suffix?: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value == null ? "" : String(value));

  useEffect(() => {
    if (!editing) setDraft(value == null ? "" : String(value));
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (value !== null) onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(Math.max(parsed, min ?? -Infinity), max ?? Infinity);
    if (clamped !== value) onCommit(clamped);
  };

  if (disabled || !editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        aria-label={label}
        className={cn(
          "rounded-sm px-1 text-left text-caption tabular-nums",
          !disabled && EDITABLE_IDLE,
          value == null && "text-muted-foreground italic",
          className,
        )}
      >
        {value == null ? placeholder : `${value}${suffix ?? ""}`}
      </button>
    );
  }

  return (
    <Input
      autoFocus
      type="number"
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      min={min}
      max={max}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value == null ? "" : String(value));
          setEditing(false);
        }
      }}
      className={cn("h-7 w-20 px-1 text-caption", className)}
    />
  );
}

/**
 * A vocabulary value edited through a dropdown. The board's status, execution
 * status, budget category, vendor and owner are the programme's own vocabulary,
 * not a server enum, so the dropdown offers what the board already uses while
 * the input still accepts anything new: a pick sets the value in one click, a
 * typed line commits like every other field here.
 */
export function EditableSuggest({
  value,
  onCommit,
  suggestions,
  label,
  placeholder,
  disabled,
  renderDisplay,
  renderOption,
  displayValue,
  displayClassName,
}: {
  value: string;
  onCommit: (next: string) => void;
  suggestions: string[];
  label: string;
  placeholder: string;
  disabled?: boolean;
  renderDisplay?: (value: string) => React.ReactNode;
  /** How one row of the dropdown reads, when the bare value is not enough —
   *  a person's name beside the account it belongs to. */
  renderOption?: (option: string) => React.ReactNode;
  /**
   * What the idle state shows, when that differs from what editing edits — a
   * dense row can only fit "李林" where the field holds "李林（POOL 超饱和）".
   */
  displayValue?: string;
  displayClassName?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  // The option the keyboard is on; -1 means the typed draft itself. Hover and
  // arrows agree on this one index so the mouse and the keyboard never fight.
  const [highlighted, setHighlighted] = useState(-1);
  // The draft opens pre-filled with the current value; filtering on it would
  // narrow the list to near-spelling of what is already there. The list only
  // follows the keyboard once the reader has actually typed.
  const [typed, setTyped] = useState(false);

  useEffect(() => {
    if (!editing) {
      setDraft(value);
      setTyped(false);
    }
  }, [value, editing]);

  const filtered = useMemo(() => {
    if (!typed) return suggestions;
    const needle = draft.trim().toLowerCase();
    return needle
      ? suggestions.filter((s) => s.toLowerCase().includes(needle))
      : suggestions;
  }, [suggestions, draft, typed]);

  // A narrower list must not leave the highlight past its end.
  useEffect(() => {
    setHighlighted((h) => Math.min(h, filtered.length - 1));
  }, [filtered.length]);

  const stopEditing = () => {
    setEditing(false);
    setHighlighted(-1);
  };

  const commit = (next: string) => {
    stopEditing();
    const trimmed = next.trim();
    if (trimmed !== value) onCommit(trimmed);
  };

  // Uniform with the other editors: Enter (or a click away) saves, Escape
  // reverts. Base UI reports which one closed the popover.
  const handleClose = (reason: string) => {
    if (reason === "escape-key") {
      stopEditing();
      setDraft(value);
    } else {
      commit(draft);
    }
  };

  const pick = (i: number) => {
    const option = filtered[i];
    if (option != null) commit(option);
  };

  if (disabled || !editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setEditing(true)}
        aria-label={label}
        className={cn(
          "rounded-sm px-1 text-left",
          !disabled && EDITABLE_IDLE,
          displayClassName,
        )}
      >
        {renderDisplay ? (
          renderDisplay(value)
        ) : (
          <span className={cn("text-caption", !value && "text-muted-foreground italic")}>
            {displayValue || value || placeholder}
          </span>
        )}
      </button>
    );
  }

  return (
    <Popover open onOpenChange={(open, details) => { if (!open) handleClose(details.reason); }}>
      <PopoverTrigger render={
        <button
          type="button"
          aria-label={label}
          className={cn("rounded-sm px-1 text-left", displayClassName)}
        >
          {renderDisplay ? (
            renderDisplay(value)
          ) : (
            <span className={cn("text-caption", !value && "text-muted-foreground italic")}>
              {displayValue || value || placeholder}
            </span>
          )}
        </button>
      } />
      {/* The popup must not take focus off the input: it is the anchor's own
          editor, not a separate surface. */}
      <PopoverContent align="start" tabIndex={-1} className="w-56 gap-1 p-1" aria-label={label}>
        <Input
          autoFocus
          aria-label={label}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setTyped(true);
            setHighlighted(-1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const option = filtered[highlighted];
              commit(option != null ? option : draft);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlighted((h) => Math.max(h - 1, -1));
            } else if (e.key === "Escape") {
              e.preventDefault();
              stopEditing();
              setDraft(value);
            }
          }}
          className="h-7 px-2 text-caption"
        />
        {filtered.length > 0 && (
          <ul role="listbox" aria-label={label} className="max-h-64 overflow-y-auto">
            {filtered.map((option, i) => (
              <li key={option}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === highlighted}
                  ref={(el) => {
                    // jsdom has no scrollIntoView; the highlight guard keeps the
                    // console quiet there.
                    if (i === highlighted && typeof el?.scrollIntoView === "function") {
                      el.scrollIntoView({ block: "nearest" });
                    }
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => pick(i)}
                  title={option}
                  className={cn(
                    "flex w-full min-w-0 rounded-sm px-2 py-1 text-left text-caption",
                    i === highlighted ? "bg-accent" : "hover:bg-accent/50",
                    option === value && "font-medium",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {renderOption ? renderOption(option) : option}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Several vocabulary values in one field.
 *
 * The parties at a meeting and the people in the room are lists, and the
 * board stores each as one "、"-joined string. Editing them as free text
 * meant every reader inventing their own separator and every later picker
 * offering "复星医药、华大基因" as though it were one organisation — so the
 * list is edited as a list: tick what is already known, type what is not.
 *
 * The same rule as every other editor here, adapted to a control that stays
 * open: Enter adds, Escape reverts, and closing the popup saves.
 */
export function EditableTokens({
  value,
  onCommit,
  split,
  suggestions,
  label,
  placeholder,
  disabled,
  renderOption,
  renderToken,
  triggerClassName,
}: {
  value: string;
  /** Receives the field's whole new value, already joined. */
  onCommit: (next: string) => void;
  /** How this field's stored string comes apart — parties and people do not
   *  agree about "×" and "/". */
  split: (value: string) => string[];
  suggestions: string[];
  label: string;
  placeholder: string;
  disabled?: boolean;
  renderOption?: (option: string) => React.ReactNode;
  renderToken?: (token: string) => React.ReactNode;
  triggerClassName?: string;
}) {
  const { t } = useT("cockpit");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(() => split(value));
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(-1);

  const committed = useMemo(() => split(value), [split, value]);
  useEffect(() => {
    if (!editing) {
      setDraft(committed);
      setQuery("");
    }
  }, [committed, editing]);

  const chosen = useMemo(() => new Set(draft), [draft]);
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (needle ? suggestions.filter((s) => s.toLowerCase().includes(needle)) : suggestions),
    [suggestions, needle],
  );
  // Only offer to add what is not already an option or already picked —
  // otherwise "add 复星医药" sits above the very row that would tick it.
  const addable =
    query.trim() &&
    !chosen.has(query.trim()) &&
    !filtered.some((option) => option === query.trim())
      ? query.trim()
      : "";

  useEffect(() => {
    setHighlighted((h) => Math.min(h, filtered.length - 1));
  }, [filtered.length]);

  const finish = (next: string[]) => {
    setEditing(false);
    setHighlighted(-1);
    setQuery("");
    const joined = joinCockpitMeetingValues(next);
    if (joined !== joinCockpitMeetingValues(committed)) onCommit(joined);
  };

  const revert = () => {
    setEditing(false);
    setHighlighted(-1);
    setQuery("");
    setDraft(committed);
  };

  const toggle = (option: string) =>
    setDraft((current) =>
      current.includes(option) ? current.filter((v) => v !== option) : [...current, option],
    );

  const display = renderToken
    ? committed.map((token) => <span key={token}>{renderToken(token)}</span>)
    : committed.map((token) => (
        <span key={token} className="rounded-sm bg-muted px-1 text-caption">
          {token}
        </span>
      ));

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setEditing(true)}
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1 rounded-sm px-1 text-left",
        !disabled &&
          EDITABLE_IDLE,
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

  return (
    <Popover
      open
      onOpenChange={(open, details) => {
        if (open) return;
        if (details.reason === "escape-key") revert();
        else finish(draft);
      }}
    >
      <PopoverTrigger render={trigger} />
      <PopoverContent align="start" tabIndex={-1} className="w-64 gap-1 p-1" aria-label={label}>
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
              const option = filtered[highlighted];
              if (option != null) toggle(option);
              else if (addable) toggle(addable);
              // Enter on an empty box is how the keyboard says "done": the
              // popup stays open while there is anything left to add.
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
              setHighlighted((h) => Math.min(h + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlighted((h) => Math.max(h - 1, -1));
            } else if (e.key === "Escape") {
              e.preventDefault();
              revert();
            }
          }}
          className="h-7 px-2 text-caption"
        />
        {(filtered.length > 0 || addable) && (
          <ul role="listbox" aria-multiselectable aria-label={label} className="max-h-64 overflow-y-auto">
            {addable && (
              <li>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    toggle(addable);
                    setQuery("");
                    setHighlighted(-1);
                  }}
                  className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-caption hover:bg-accent/50"
                >
                  <Plus className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">{t(($) => $.common.add_value, { value: addable })}</span>
                </button>
              </li>
            )}
            {filtered.map((option, i) => (
              <li key={option}>
                <button
                  type="button"
                  role="option"
                  aria-selected={chosen.has(option)}
                  ref={(el) => {
                    if (i === highlighted && typeof el?.scrollIntoView === "function") {
                      el.scrollIntoView({ block: "nearest" });
                    }
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  // Move, not enter: the list re-renders under a cursor that
                  // has not moved (adding a name shortens it), and an
                  // "enter" fired by the list moving would hand the keyboard
                  // highlight to whatever landed under the pointer — so the
                  // next Enter would tick a row nobody pointed at.
                  onMouseMove={() => setHighlighted(i)}
                  onClick={() => {
                    toggle(option);
                    setHighlighted(-1);
                  }}
                  title={option}
                  className={cn(
                    "flex w-full items-center gap-1.5 rounded-sm px-2 py-1 text-left text-caption",
                    i === highlighted ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  <Check
                    className={cn("size-3 shrink-0", chosen.has(option) ? "" : "opacity-0")}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {renderOption ? renderOption(option) : option}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** A labelled row in the node detail panel — label above, editor below. */
export function CockpitField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-micro font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

/** Progress as a bar plus an editable percentage. */
export function ProgressField({
  value,
  onCommit,
  label,
  disabled,
}: {
  value: number;
  onCommit: (next: number) => void;
  label: string;
  disabled?: boolean;
}) {
  const { t } = useT("cockpit");
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={t(($) => $.node.progress_bar, { percent: Math.round(pct) })}
      >
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <EditableNumber
        value={value}
        onCommit={(next) => onCommit(next ?? 0)}
        label={label}
        placeholder="0"
        suffix="%"
        min={0}
        max={100}
        disabled={disabled}
        className="w-12"
      />
    </div>
  );
}
