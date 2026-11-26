"use client";

import type { BatchScopeParentConflict } from "@multica/core/issues/batch";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

/**
 * Shown when a batch ownership edit would separate one or more selected
 * sub-issues from their unselected parent's ownership. The action is stopped
 * before any issue is modified, and each conflicting sub-issue / parent pair
 * is listed with links to inspect them.
 */
export function IssueBatchScopeConflictDialog({
  conflicts,
  onClose,
}: {
  conflicts: readonly BatchScopeParentConflict[] | null;
  onClose: () => void;
}) {
  const { t } = useT("issues");
  const paths = useWorkspacePaths();
  if (!conflicts || conflicts.length === 0) return null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t(($) => $.batch.scope_conflict_title)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.batch.scope_conflict_description)}
          </DialogDescription>
        </DialogHeader>
        <ul className="max-h-[45vh] space-y-2.5 overflow-y-auto rounded-lg border p-3">
          {conflicts.map(({ issue, parentId, parent }) => (
            <li
              key={issue.id}
              className="space-y-1 border-b pb-2.5 last:border-0 last:pb-0"
            >
              <AppLink
                href={paths.issueDetail(issue.id)}
                target="_blank"
                rel="noopener noreferrer"
                className="block line-clamp-2 break-words text-caption font-medium text-primary underline underline-offset-4"
              >
                {issue.identifier
                  ? `${issue.identifier} · ${issue.title}`
                  : issue.title || issue.id}{" "}
                {t(($) => $.operation_basis.new_tab)}
              </AppLink>
              <p className="text-caption text-muted-foreground">
                {t(($) => $.batch.scope_conflict_parent_label)}{" "}
                <AppLink
                  href={paths.issueDetail(parentId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-words text-primary underline underline-offset-4"
                >
                  {parent
                    ? `${parent.identifier} · ${parent.title}`
                    : t(($) => $.batch.scope_conflict_parent_open)}
                </AppLink>
              </p>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t(($) => $.batch.scope_conflict_close)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
