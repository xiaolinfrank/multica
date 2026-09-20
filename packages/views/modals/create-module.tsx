"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useCreateModule } from "@multica/core/modules/mutations";
import { useCurrentWorkspace } from "@multica/core/paths";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { TitleEditor } from "../editor";
import { ProjectPicker } from "../projects/components/project-picker";
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
  const [submitting, setSubmitting] = useState(false);

  const createModule = useCreateModule();

  const handleSubmit = async () => {
    if (!title.trim() || !projectId || submitting) return;
    setSubmitting(true);
    try {
      await createModule.mutateAsync({
        project_id: projectId,
        title: title.trim(),
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
        // No fixed height: a module is a name and a project, so the dialog is
        // exactly as tall as those rows and its footer sits under them
        // instead of floating above a blank band.
        className={cn(
          "p-0 gap-0 flex flex-col overflow-hidden",
          "!top-1/2 !left-1/2 !-translate-x-1/2",
          "!max-w-lg !w-full !-translate-y-1/2",
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
