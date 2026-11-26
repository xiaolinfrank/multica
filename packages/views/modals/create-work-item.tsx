"use client";

import { useEffect, useRef, useState } from "react";
import { useCreateCockpitWorkItem } from "@multica/core/cockpit";
import { useWorkspaceId } from "@multica/core/hooks";
import { useCurrentWorkspace } from "@multica/core/paths";
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogTitle } from "@multica/ui/components/ui/dialog";
import { Button } from "@multica/ui/components/ui/button";
import { ChevronRight } from "@multica/ui/icons";
import { TitleEditor } from "../editor";
import { ProjectPicker } from "../projects/components/project-picker";
import { ModulePicker } from "../projects/components/module-picker";
import { PillButton } from "../common/pill-button";
import { useT } from "../i18n";

export function CreateWorkItemModal({
  onClose,
  data,
}: {
  onClose: () => void;
  /** Payload from the opener; `{ projectId, moduleId }` preselects the module
   *  the work item belongs to so a create started from a project surface lands
   *  in that module without a second click. */
  data?: Record<string, unknown> | null;
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const workspace = useCurrentWorkspace();
  const workspaceName = workspace?.name;
  const initialProject =
    typeof data?.projectId === "string" ? data.projectId : null;
  const initialModule =
    typeof data?.moduleId === "string" ? data.moduleId : null;

  const [projectId, setProjectId] = useState<string | null>(initialProject);
  const [moduleId, setModuleId] = useState<string | null>(initialModule);
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const createWorkItem = useCreateCockpitWorkItem(wsId);
  // A work-item create is keyed so a retry after a transient failure replays
  // the row the server may already have made instead of creating a second one.
  // Any change to what would be sent starts a new attempt under a new key.
  const creationKeyRef = useRef<string | null>(null);
  const trimmed = title.trim();
  useEffect(() => {
    creationKeyRef.current = null;
  }, [moduleId, trimmed]);

  const handleSubmit = async () => {
    if (!trimmed || !moduleId || submitting) return;
    setSubmitting(true);
    const creationKey = (creationKeyRef.current ??= crypto.randomUUID());
    try {
      await createWorkItem.mutateAsync({
        module_id: moduleId,
        name: trimmed,
        creation_key: creationKey,
      });
      // Close only after the server confirms the create — a rejected create
      // keeps the dialog open with its typed draft so the user can retry.
      onClose();
      toast.success(t(($) => $.work_item.create.toast_created));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.work_item.create.toast_failed),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        // No fixed height: a work item is a name and a module, so the dialog is
        // exactly as tall as those rows and its footer sits under them.
        className={cn(
          "p-0 gap-0 flex flex-col overflow-hidden",
          "!top-1/2 !left-1/2 !-translate-x-1/2",
          "!max-w-lg !w-full !-translate-y-1/2",
        )}
      >
        <DialogTitle className="sr-only">{t(($) => $.work_item.create.title)}</DialogTitle>

        <div className="flex items-center justify-between px-5 pt-3 pb-2 shrink-0">
          <div className="flex items-center gap-1.5 text-caption">
            <span className="text-muted-foreground">{workspaceName}</span>
            <ChevronRight className="size-3 text-faint-foreground" />
            <span className="font-medium">{t(($) => $.work_item.create.breadcrumb)}</span>
          </div>
        </div>

        <div className="px-5 pb-2 shrink-0">
          <TitleEditor
            autoFocus
            defaultValue=""
            placeholder={t(($) => $.work_item.create.title_placeholder)}
            className="text-title font-semibold"
            onChange={(v) => setTitle(v)}
            onSubmit={handleSubmit}
          />
        </div>

        {/* Property pill row — a work item belongs to exactly one module, so
            both the project and the module are required to submit. Changing
            the project clears the module: it names one in the old project. */}
        <div className="flex items-center gap-1.5 px-4 py-2 shrink-0 flex-wrap">
          <ProjectPicker
            projectId={projectId}
            onUpdate={(u) => {
              const next = u.project_id ?? null;
              setProjectId(next);
              if (next !== projectId) setModuleId(null);
            }}
            triggerRender={<PillButton />}
            align="start"
          />
          <ModulePicker
            projectId={projectId}
            moduleId={moduleId}
            onUpdate={(u) => setModuleId(u.module_id ?? null)}
            triggerRender={<PillButton />}
            align="start"
          />
        </div>

        <div className="flex items-center justify-end border-t px-4 py-3 shrink-0">
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!trimmed || !moduleId || submitting}
            className="shrink-0"
          >
            {submitting
              ? t(($) => $.work_item.create.submitting)
              : t(($) => $.work_item.create.submit)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
