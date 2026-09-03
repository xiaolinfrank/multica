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

import { useEffect, useRef, useState } from "react";
import { cn } from "@multica/ui/lib/utils";
import { Input } from "@multica/ui/components/ui/input";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { useT } from "../../i18n";

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
        {value || placeholder}
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
          "min-w-0 truncate rounded-sm px-1 text-left text-body hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          !value && "text-muted-foreground italic",
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
          !disabled && "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
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
}: {
  value: string | null;
  onCommit: (next: string | null) => void;
  label: string;
  placeholder: string;
  disabled?: boolean;
  className?: string;
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
          !disabled && "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          !value && "text-muted-foreground italic",
          className,
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
          !disabled && "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
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
 * A free-text value with suggestions. The board's status, execution status and
 * budget category are the programme's own vocabulary, not a server enum, so
 * this offers what the board already uses without refusing anything new.
 */
export function EditableSuggest({
  value,
  onCommit,
  suggestions,
  label,
  placeholder,
  disabled,
  renderDisplay,
}: {
  value: string;
  onCommit: (next: string) => void;
  suggestions: string[];
  label: string;
  placeholder: string;
  disabled?: boolean;
  renderDisplay?: (value: string) => React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const listId = useRef(`cockpit-suggest-${Math.random().toString(36).slice(2)}`).current;

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = (next: string) => {
    setEditing(false);
    const trimmed = next.trim();
    if (trimmed !== value) onCommit(trimmed);
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
          !disabled && "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        )}
      >
        {renderDisplay ? (
          renderDisplay(value)
        ) : (
          <span className={cn("text-caption", !value && "text-muted-foreground italic")}>
            {value || placeholder}
          </span>
        )}
      </button>
    );
  }

  return (
    <>
      <Input
        autoFocus
        aria-label={label}
        placeholder={placeholder}
        list={listId}
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
          }
        }}
        className="h-7 w-32 px-1 text-caption"
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
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
