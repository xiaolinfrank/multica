"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useCreateModule } from "@multica/core/modules/mutations";
import { useCurrentWorkspace } from "@multica/core/paths";
import { normalizeCollabPath, type CollabPathError } from "@multica/core/projects/collab-path";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { TitleEditor } from "../editor";
import { ProjectPicker } from "../projects/components/project-picker";
import { CollabPathInput } from "../projects/components/collab-path";
import { PillButton } from "../common/pill-button";
import { useT } from "../i18n";

export function CreateModuleModal({
  onClose,
  data,
}: {
  onClose: () => void;
  /** Payload from the opener; `{ projectId }` preselects the project so a
   *  module created from a project surface lands in that project without a
   *  second click. */
  data?: Record<string, unknown> | null;
}) {
  const { t } = useT("projects");
  const workspace = useCurrentWorkspace();
  const workspaceName = workspace?.name;
  const initialProject =
    typeof data?.projectId === "string" ? (data.projectId as string) : null;

  const [projectId, setProjectId] = useState<string | null>(initialProject);
  const [title, setTitle] = useState("");
  const [collabPath, setCollabPath] = useState("");
  const [collabPathError, setCollabPathError] = useState<CollabPathError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const createModule = useCreateModule();

  const handleSubmit = async () => {
    if (!title.trim() || !projectId || submitting) return;
    const path = normalizeCollabPath(collabPath);
    if (!path.ok) {
      setCollabPathError(path.reason);
      return;
    }
    setSubmitting(true);
    try {
      await createModule.mutateAsync({
        project_id: projectId,
        title: title.trim(),
        // Omitted rather than sent as null: create has no prior value to
        // clear, and the server reads an absent key as "no path".
        ...(path.value ? { collab_path: path.value } : {}),
      });
      // Close only after the server confirms the create, matching the
      // create-project contract — a rejected create keeps the dialog open
      // with its typed title so the user can retry.
      onClose();
      toast.success(t(($) => $.module.create.toast_created));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.module.create.toast_failed),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          "p-0 gap-0 flex flex-col overflow-hidden",
          "!top-1/2 !left-1/2 !-translate-x-1/2",
          "!max-w-lg !w-full !h-[22rem] !-translate-y-1/2",
        )}
      >
        <DialogTitle className="sr-only">{t(($) => $.module.create.title)}</DialogTitle>

        <div className="flex items-center justify-between px-5 pt-3 pb-2 shrink-0">
          <div className="flex items-center gap-1.5 text-caption">
            <span className="text-muted-foreground">{workspaceName}</span>
            <ChevronRight className="size-3 text-faint-foreground" />
            <span className="font-medium">{t(($) => $.module.create.breadcrumb)}</span>
          </div>
        </div>

        <div className="px-5 pb-2 shrink-0">
          <TitleEditor
            autoFocus
            defaultValue=""
            placeholder={t(($) => $.module.create.title_placeholder)}
            className="text-title font-semibold"
            onChange={(v) => setTitle(v)}
            onSubmit={handleSubmit}
          />
        </div>

        {/* Optional from the start: a module is created to hold work, and the
            directory that work lands in is part of setting it up. Left blank
            the module simply has no space of its own and agents fall back to
            the project's. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-2">
          <CollabPathInput
            id="create-module-collab-path"
            value={collabPath}
            onValueChange={(next) => {
              setCollabPath(next);
              setCollabPathError(null);
            }}
            error={collabPathError}
            hint={t(($) => $.collab_path.hint_module)}
          />
        </div>

        {/* Property pill row — the project is required (a module belongs to
            exactly one project), so unlike quick-create there is no clear. */}
        <div className="flex items-center gap-1.5 px-4 py-2 shrink-0 flex-wrap">
          <ProjectPicker
            projectId={projectId}
            onUpdate={(u) => setProjectId(u.project_id ?? null)}
            triggerRender={<PillButton />}
            align="start"
          />
        </div>

        <div className="flex items-center justify-end border-t px-4 py-3 shrink-0">
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!title.trim() || !projectId || submitting}
            className="shrink-0"
          >
            {submitting
              ? t(($) => $.module.create.submitting)
              : t(($) => $.module.create.submit)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
