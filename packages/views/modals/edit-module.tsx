"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { moduleListOptions } from "@multica/core/modules/queries";
import { useUpdateModule } from "@multica/core/modules/mutations";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useT } from "../i18n";

/**
 * The module's property surface. Modules gained a description column before
 * they had anywhere to set it, and the description is what reaches an agent as
 * context for every task in the module, so this dialog is its only editor; the
 * manage dialog keeps its inline rename for the one-field case.
 *
 * Reads the module out of the workspace-wide module list rather than fetching
 * the row: that list is the cache every module mutation patches, so the dialog
 * opens on the same values the surface behind it is showing, with no second
 * request and no window where the two disagree.
 */
export function EditModuleModal({
  onClose,
  data,
}: {
  onClose: () => void;
  /** `{ moduleId }` from the opener. */
  data?: Record<string, unknown> | null;
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const moduleId = typeof data?.moduleId === "string" ? data.moduleId : null;
  const { data: modules = [], isLoading } = useQuery(moduleListOptions(wsId));
  const module = moduleId ? modules.find((m) => m.id === moduleId) : undefined;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t(($) => $.module.edit.title)}</DialogTitle>
        </DialogHeader>
        {module ? (
          <EditModuleForm
            key={module.id}
            moduleId={module.id}
            initialTitle={module.title}
            initialDescription={module.description ?? ""}
            onClose={onClose}
          />
        ) : isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : (
          <p className="text-caption text-muted-foreground">
            {t(($) => $.module.edit.not_found)}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Split out so the fields are initialised from the loaded module exactly once,
 * keyed by module id. Seeding state from props in the parent would either lose
 * the user's typing on every cache patch or never pick the module up at all.
 */
function EditModuleForm({
  moduleId,
  initialTitle,
  initialDescription,
  onClose,
}: {
  moduleId: string;
  initialTitle: string;
  initialDescription: string;
  onClose: () => void;
}) {
  const { t } = useT("projects");
  const updateModule = useUpdateModule();
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [submitting, setSubmitting] = useState(false);

  const trimmedTitle = title.trim();

  const handleSubmit = async () => {
    if (!trimmedTitle || submitting) return;
    setSubmitting(true);
    try {
      // description is always sent, as an explicit null when emptied: the
      // update contract reads an absent key as "keep the current value", so a
      // cleared description would otherwise survive the save.
      await updateModule.mutateAsync({
        id: moduleId,
        title: trimmedTitle,
        description: description.trim() || null,
      });
      // Closed only after the server confirms, so a rejected save keeps the
      // typed values on screen — same contract as create-module.
      onClose();
      toast.success(t(($) => $.module.edit.toast_saved));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.module.edit.toast_failed),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="edit-module-title" className="text-caption text-muted-foreground">
          {t(($) => $.module.edit.title_label)}
        </Label>
        <Input
          id="edit-module-title"
          autoFocus
          value={title}
          placeholder={t(($) => $.module.create.title_placeholder)}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleSubmit();
            }
          }}
        />
      </div>

      <div className="space-y-1.5">
        <Label
          htmlFor="edit-module-description"
          className="text-caption text-muted-foreground"
        >
          {t(($) => $.module.edit.description_label)}
        </Label>
        <Textarea
          id="edit-module-description"
          rows={3}
          value={description}
          placeholder={t(($) => $.module.edit.description_placeholder)}
          onChange={(event) => setDescription(event.target.value)}
        />
        <p className="text-micro leading-snug text-muted-foreground">
          {t(($) => $.module.edit.description_hint)}
        </p>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t(($) => $.module.edit.cancel)}
        </Button>
        <Button
          type="button"
          onClick={handleSubmit}
          disabled={!trimmedTitle || submitting}
          aria-busy={submitting || undefined}
        >
          {submitting
            ? t(($) => $.module.edit.submitting)
            : t(($) => $.module.edit.submit)}
        </Button>
      </DialogFooter>
    </div>
  );
}
