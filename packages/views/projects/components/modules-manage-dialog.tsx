"use client";

import { useState } from "react";
import { FolderCog, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { moduleListOptions } from "@multica/core/modules/queries";
import {
  useDeleteModule,
  useReorderModules,
  useUpdateModule,
} from "@multica/core/modules/mutations";
import { useModalStore } from "@multica/core/modals";
import { useWorkspaceId } from "@multica/core/hooks";
import type { Module } from "@multica/core/types";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multica/ui/components/ui/alert-dialog";
import { useT } from "../../i18n";

function SortableModuleRow({
  module,
  onRename,
  onEdit,
  onDelete,
  renaming,
  renameValue,
  onRenameValueChange,
  onCommitRename,
  onCancelRename,
}: {
  module: Module;
  onRename: (module: Module) => void;
  onEdit: (module: Module) => void;
  onDelete: (module: Module) => void;
  renaming: boolean;
  renameValue: string;
  onRenameValueChange: (value: string) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
}) {
  const { t } = useT("projects");
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: module.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="flex items-center gap-1.5 rounded-md px-1 py-1 hover:bg-accent/50"
    >
      <button
        type="button"
        aria-label={t(($) => $.module.reorder_handle_aria)}
        className="grid size-5 shrink-0 cursor-grab touch-none place-items-center text-muted-foreground hover:text-foreground"
        {...attributes}
        {...listeners}
      >
        <Settings2 className="size-3.5" />
      </button>
      {renaming ? (
        <input
          autoFocus
          type="text"
          value={renameValue}
          onChange={(event) => onRenameValueChange(event.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") onCommitRename();
            if (event.key === "Escape") onCancelRename();
          }}
          aria-label={t(($) => $.module.rename_aria)}
          className="h-6 min-w-0 flex-1 rounded-xs border bg-transparent px-1.5 text-caption outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-caption">{module.title}</span>
          <span className="shrink-0 text-micro text-muted-foreground tabular-nums">
            {module.issue_count}
          </span>
          <button
            type="button"
            aria-label={t(($) => $.module.rename_aria)}
            onClick={() => onRename(module)}
            className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/module-row:opacity-100"
          >
            <Pencil className="size-3.5" />
          </button>
          {/* Inline rename stays the one-field path; this opens the full
              property editor (name, description, collaboration space), which
              is the only surface either of the latter two has. */}
          <button
            type="button"
            aria-label={t(($) => $.module.edit_aria)}
            onClick={() => onEdit(module)}
            className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/module-row:opacity-100"
          >
            <FolderCog className="size-3.5" />
          </button>
        </>
      )}
      <button
        type="button"
        aria-label={t(($) => $.module.delete_aria)}
        onClick={() => onDelete(module)}
        className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

/** Folder management for one project's modules: create, rename, drag-reorder
 *  and delete. Lives in the project header menu — day-to-day grouping is the
 *  table's module folders, so this surface only carries the consequential
 *  operations. */
export function ModulesManageDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const { data: modules = [] } = useQuery({
    ...moduleListOptions(wsId, projectId),
    enabled: open,
  });
  const updateModule = useUpdateModule();
  const deleteModule = useDeleteModule();
  const reorderModules = useReorderModules();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Module | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const openCreateModule = () => {
    // One overlay at a time: the create modal takes over from this dialog.
    onOpenChange(false);
    useModalStore.getState().open("create-module", { projectId });
  };

  const openEditModule = (module: Module) => {
    // One overlay at a time, same handoff the create flow makes.
    onOpenChange(false);
    useModalStore.getState().open("edit-module", { moduleId: module.id });
  };

  const beginRename = (module: Module) => {
    setRenamingId(module.id);
    setRenameValue(module.title);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue("");
  };

  const commitRename = () => {
    const target = modules.find((m) => m.id === renamingId);
    const trimmed = renameValue.trim();
    if (target && trimmed && trimmed !== target.title) {
      updateModule.mutate({ id: target.id, title: trimmed });
    }
    cancelRename();
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active: dragged, over } = event;
    if (!over || dragged.id === over.id) return;
    const from = modules.findIndex((m) => m.id === dragged.id);
    const to = modules.findIndex((m) => m.id === over.id);
    if (from < 0 || to < 0) return;
    reorderModules.mutate(
      arrayMove(modules, from, to).map((m) => m.id),
      {
        onError: () => toast.error(t(($) => $.module.toast_reorder_failed)),
      },
    );
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteModule.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast.success(t(($) => $.module.toast_deleted));
        // A deleted module id still in ?module= is healed by the project
        // detail's dead-id fallback, no URL work needed here.
        setDeleteTarget(null);
      },
      onError: () => toast.error(t(($) => $.module.toast_delete_failed)),
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t(($) => $.module.manage_title)}</DialogTitle>
          </DialogHeader>
          <div className="p-1.5 -m-1.5">
            {modules.length === 0 ? (
              <p className="px-1 py-2 text-caption text-muted-foreground">
                {t(($) => $.module.manage_empty)}
              </p>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={modules.map((m) => m.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="group/module-list">
                    {modules.map((module) => (
                      <div key={module.id} className="group/module-row">
                        <SortableModuleRow
                          module={module}
                          onRename={beginRename}
                          onEdit={openEditModule}
                          onDelete={setDeleteTarget}
                          renaming={renamingId === module.id}
                          renameValue={renameValue}
                          onRenameValueChange={setRenameValue}
                          onCommitRename={commitRename}
                          onCancelRename={cancelRename}
                        />
                      </div>
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
            <button
              type="button"
              onClick={openCreateModule}
              className="mt-1 flex w-full items-center gap-1.5 rounded-md px-1 py-1.5 text-caption text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            >
              <Plus className="size-3.5" />
              {t(($) => $.module.add)}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(($) => $.module.delete_title, {
                title: deleteTarget?.title ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.module.delete_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.module.delete_cancel)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {t(($) => $.module.delete_confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
