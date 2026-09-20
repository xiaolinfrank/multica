"use client";

import { useId, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "@multica/ui/lib/clipboard";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { normalizeCollabPath, type CollabPathError } from "@multica/core/projects/collab-path";
import { useT } from "../../i18n";

// Shared UI for a project's human-agent collaboration space path
// ("人机协作空间路径"). The value is a long absolute path on a NAS share, which
// drives every decision here: it truncates rather than wraps, its full form is
// always one hover (or one copy) away, and it is rendered in a monospaced,
// LTR-forced run so mixed Chinese/ASCII segments and separators stay in the
// order the filesystem uses.

/** Maps a validation failure to the message shown beside the field. The rules
 *  themselves live in `@multica/core/projects/collab-path`, which mirrors the
 *  server; this only names them. */
export function useCollabPathErrorMessage(): (reason: CollabPathError) => string {
  const { t } = useT("projects");
  return (reason) => {
    switch (reason) {
      case "too_long":
        return t(($) => $.collab_path.error_too_long);
      case "control_characters":
        return t(($) => $.collab_path.error_control_characters);
      case "not_absolute":
        return t(($) => $.collab_path.error_not_absolute);
    }
  };
}

/** A path is a single LTR run even when its segments are Chinese: without this
 *  the bidi algorithm can reorder the separators around a CJK segment. */
const PATH_TEXT = "font-mono text-caption";

/** Last segment of a path, for places too narrow to show any of it — a pill in
 *  a wrapping toolbar. The leading directories are the part every sibling path
 *  shares, so the tail is what actually identifies this one. Callers keep the
 *  full string on `title`. */
export function collabPathTail(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/** Copy button for a path that is displayed truncated. Separate from the value
 *  itself so the full string is reachable without entering an edit mode. */
export function CollabPathCopyButton({ path }: { path: string }) {
  const { t } = useT("projects");
  const label = t(($) => $.collab_path.copy_aria);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      className="shrink-0 text-muted-foreground"
      onClick={() => {
        void copyText(path).then((ok) => {
          if (ok) toast.success(t(($) => $.collab_path.toast_copied));
          else toast.error(t(($) => $.collab_path.toast_copy_failed));
        });
      }}
    >
      <Copy />
    </Button>
  );
}

/**
 * Labelled text field for the create/edit forms.
 *
 * `error` is owned by the caller (it is produced when the form is submitted, or
 * as the user types once a submit has already failed) so a single field can be
 * validated at whatever moment the surrounding form validates everything else.
 * The hint is replaced by the error rather than stacked under it: both answer
 * "what goes in this box", and two lines of answer under one input is noise.
 */
export function CollabPathInput({
  value,
  onValueChange,
  hint,
  error,
  autoFocus,
  id,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** What this space is for, in the words of the surface asking for it. */
  hint: string;
  error?: CollabPathError | null;
  autoFocus?: boolean;
  id?: string;
}) {
  const { t } = useT("projects");
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const describedById = `${inputId}-hint`;
  const errorMessage = useCollabPathErrorMessage();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={inputId} className="text-caption text-muted-foreground">
        {t(($) => $.collab_path.label)}
      </Label>
      <Input
        id={inputId}
        dir="ltr"
        spellCheck={false}
        autoComplete="off"
        autoFocus={autoFocus}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedById}
        className="font-mono text-caption md:text-caption"
        placeholder={t(($) => $.collab_path.placeholder)}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      />
      <p
        id={describedById}
        className={cn(
          "text-micro leading-snug",
          error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {error ? errorMessage(error) : hint}
      </p>
    </div>
  );
}

/**
 * The editable property itself: truncated value plus copy while idle, a text
 * input once clicked.
 *
 * Commit rules match the inline rename in the modules dialog — Enter and blur
 * commit, Escape abandons — with one addition: a value the server would reject
 * keeps the editor open and names the problem, instead of closing and surfacing
 * a raw 400 in a toast after the fact.
 */
export function CollabPathProperty({
  value,
  onCommit,
}: {
  value: string | null;
  /** `null` clears the field. Never called when the value is unchanged. */
  onCommit: (value: string | null) => void;
}) {
  const { t } = useT("projects");
  const errorMessage = useCollabPathErrorMessage();
  const errorId = `${useId()}-error`;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<CollabPathError | null>(null);

  const beginEdit = () => {
    setDraft(value ?? "");
    setError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setError(null);
  };

  const commit = () => {
    const result = normalizeCollabPath(draft);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    // A no-op write would still invalidate the project caches and flash the
    // whole sidebar, so unchanged input just leaves edit mode.
    if (result.value !== value) onCommit(result.value);
    setEditing(false);
    setError(null);
  };

  if (editing) {
    return (
      <div className="w-full space-y-1">
        <Input
          autoFocus
          dir="ltr"
          spellCheck={false}
          autoComplete="off"
          aria-label={t(($) => $.collab_path.label)}
          aria-invalid={error ? true : undefined}
          // The reason a commit was refused is the only thing on screen that
          // explains why the editor stayed open, so it has to be part of the
          // input's accessible description — not just painted beside it.
          aria-describedby={error ? errorId : undefined}
          className="h-7 font-mono text-caption md:text-caption"
          placeholder={t(($) => $.collab_path.placeholder)}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
        />
        {error && (
          <p
            id={errorId}
            role="alert"
            className="text-micro leading-snug text-destructive"
          >
            {errorMessage(error)}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 w-full items-center gap-1">
      {/* No aria-label: the accessible name is the value itself (or "Not set"),
          the same contract the lead and date rows in this sidebar use. The
          adjacent row label supplies the "of what". */}
      <button
        type="button"
        onClick={beginEdit}
        title={value ?? undefined}
        className={cn(
          "min-w-0 flex-1 truncate rounded-xs text-left transition-colors",
          value
            ? cn(PATH_TEXT, "hover:text-foreground")
            : "text-caption text-muted-foreground hover:text-foreground",
        )}
      >
        <span dir={value ? "ltr" : undefined}>
          {value ?? t(($) => $.collab_path.empty)}
        </span>
      </button>
      {value && <CollabPathCopyButton path={value} />}
    </div>
  );
}
