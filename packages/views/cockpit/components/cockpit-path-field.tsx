"use client";

// The NAS folder a meeting's material lives in. Two ways to get one, and the
// field has to offer both: provisioning creates the folder this board would
// have named, while typing points the meeting at a folder that already exists
// — a directory someone made by hand, or one carried over from the share this
// programme ran on before the board did.
//
// Validation is the project collaboration path's, because the server applies
// literally the same rule to both (`normalizeCollabPath`). The wording for a
// refused path is shared for the same reason: one rule, stated once.

import { useId, useState } from "react";
import { Pencil } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { normalizeCollabPath, type CollabPathError } from "@multica/core/projects/collab-path";
import { LocalPathLink } from "../../common/local-path-link";
import {
  CollabPathCopyButton,
  useCollabPathErrorMessage,
} from "../../projects/components/collab-path";
import { useT } from "../../i18n";

export function CockpitPathField({
  value,
  label,
  empty,
  readOnly,
  onCommit,
  children,
}: {
  value: string;
  /** Accessible name for the editor — the row's own label ("资料目录"). */
  label: string;
  /** Shown, and clickable into the editor, when nothing is bound yet. */
  empty: string;
  readOnly?: boolean;
  /** Called only when the normalized value differs from the current one. */
  onCommit: (next: string) => void;
  /** Actions that belong beside an unbound path — provisioning, typically. */
  children?: React.ReactNode;
}) {
  const { t } = useT("projects");
  const errorMessage = useCollabPathErrorMessage();
  const errorId = `${useId()}-error`;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<CollabPathError | null>(null);

  const beginEdit = () => {
    setDraft(value);
    setError(null);
    setEditing(true);
  };

  const commit = () => {
    const result = normalizeCollabPath(draft);
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    // Rewriting the same path would still bounce through the server and repaint
    // the register, so an unchanged value just leaves edit mode.
    if (result.value !== value) onCommit(result.value ?? "");
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
          aria-label={label}
          aria-invalid={error ? true : undefined}
          // Why the editor stayed open is only said here, so it has to be part
          // of the input's accessible description, not just painted beside it.
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
              setEditing(false);
              setError(null);
            }
          }}
        />
        {error && (
          <p id={errorId} role="alert" className="text-micro leading-snug text-destructive">
            {errorMessage(error)}
          </p>
        )}
      </div>
    );
  }

  const editLabel = t(($) => $.collab_path.edit_aria);

  return (
    <div className="flex min-w-0 items-center gap-1">
      {value ? (
        <LocalPathLink path={value} wrap="truncate" className="min-w-0 flex-1" />
      ) : readOnly ? (
        <span className="text-caption text-muted-foreground">{empty}</span>
      ) : (
        <button
          type="button"
          onClick={beginEdit}
          className="min-w-0 truncate rounded-xs text-left text-caption text-muted-foreground transition-colors hover:text-foreground"
        >
          {empty}
        </button>
      )}
      {value && !readOnly && (
        <>
          <CollabPathCopyButton path={value} />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={editLabel}
            title={editLabel}
            className="shrink-0 text-muted-foreground"
            onClick={beginEdit}
          >
            <Pencil />
          </Button>
        </>
      )}
      {!value && !readOnly && children}
    </div>
  );
}
