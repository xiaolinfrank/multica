"use client";

import { useState } from "react";
import { Boxes, Pencil, Plus, Settings2, Trash2 } from "lucide-react";
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
import { cn } from "@multica/ui/lib/utils";
import { toast } from "sonner";
import { Popover, PopoverTrigger, PopoverContent } from "@multica/ui/components/ui/popover";
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

/** Sentinel for the ungrouped chip (module ids are UUIDs, so "none" can
 *  never collide with one). */
export const NO_MODULE_FILTER = "none";

const CHIP_CLASS =
  "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-caption transition-colors";

function ModuleChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        CHIP_CLASS,
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function SortableModuleRow({
  module,
  onRename,
  onDelete,
  renaming,
  renameValue,
  onRenameValueChange,
  onCommitRename,
  onCancelRename,
}: {
  module: Module;
  onRename: (module: Module) => void;
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
          <button
            type="button"
            aria-label={t(($) => $.module.rename_aria)}
            onClick={() => onRename(module)}
            className="grid size-5 shrink-0 place-items-center rounded-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/module-row:opacity-100"
          >
            <Pencil className="size-3.5" />
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

/** Module strip under the project detail header: filters the surface to
 *  one module / the ungrouped set, and owns module management (create,
 *  rename, delete, drag-reorder). */
export function ProjectModuleStrip({
  projectId,
  active,
  onSelect,
  canManage,
}: {
  projectId: string;
  /** null = all issues, "none" = ungrouped, otherwise a module id. */
  active: string | null;
  onSelect: (value: string | null) => void;
  canManage: boolean;
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const { data: modules = [] } = useQuery(moduleListOptions(wsId, projectId));
  const updateModule = useUpdateModule();
  const deleteModule = useDeleteModule();
  const reorderModules = useReorderModules();
  const [manageOpen, setManageOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Module | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const openCreateModule = () =>
    useModalStore.getState().open("create-module", { projectId });

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
    const deletedId = deleteTarget.id;
    deleteModule.mutate(deletedId, {
      onSuccess: () => {
        toast.success(t(($) => $.module.toast_deleted));
        // The deleted chip can no longer filter anything — fall back to
        // the unfiltered view instead of an empty, un-clearable surface.
        if (active === deletedId) onSelect(null);
        setDeleteTarget(null);
      },
      onError: () => toast.error(t(($) => $.module.toast_delete_failed)),
    });
  };

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto px-4 pb-1 pt-2">
      <ModuleChip active={active === null} onClick={() => onSelect(null)}>
        {t(($) => $.module.all)}
      </ModuleChip>
      <ModuleChip
        active={active === NO_MODULE_FILTER}
        onClick={() => onSelect(NO_MODULE_FILTER)}
      >
        {t(($) => $.module.ungrouped)}
      </ModuleChip>
      {modules.map((module) => (
        <ModuleChip
          key={module.id}
          active={active === module.id}
          onClick={() => onSelect(module.id)}
        >
          <Boxes className="size-3 shrink-0" />
          <span className="max-w-[12rem] truncate">{module.title}</span>
          <span className="text-micro text-muted-foreground">
            {module.issue_count}
          </span>
        </ModuleChip>
      ))}
      {canManage && (
        <>
          <button
            type="button"
            onClick={openCreateModule}
            className={cn(CHIP_CLASS, "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
          >
            <Plus className="size-3" />
            {t(($) => $.module.add)}
          </button>
          <Popover open={manageOpen} onOpenChange={setManageOpen}>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className={cn(CHIP_CLASS, "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
                >
                  {t(($) => $.module.manage)}
                </button>
              }
            />
            <PopoverContent align="start" className="w-72 p-1.5">
              <div className="px-1 pb-1 pt-0.5 text-caption font-medium text-muted-foreground">
                {t(($) => $.module.manage_title)}
              </div>
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
            </PopoverContent>
          </Popover>
        </>
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
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
    </div>
  );
}
