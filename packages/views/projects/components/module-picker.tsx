"use client";

import { useState } from "react";
import { Boxes, Plus } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { moduleListOptions } from "@multica/core/modules/queries";
import { useCreateModule } from "@multica/core/modules/mutations";
import { useWorkspaceId } from "@multica/core/hooks";
import type { UpdateIssueRequest } from "@multica/core/types";
import { toast } from "sonner";
import {
  PropertyPicker,
  PickerItem,
  PickerEmpty,
  PICKER_TRIGGER_CLASS,
} from "../../issues/components/pickers/property-picker";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { useT } from "../../i18n";

export function ModulePicker({
  moduleId,
  projectId,
  onUpdate,
  triggerRender,
  align = "start",
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  disabled = false,
}: {
  moduleId: string | null;
  /** The project whose modules are offered. A module belongs to exactly
   *  one project, so with no project there is nothing to pick: the trigger
   *  locks with a hint instead of opening an empty menu. */
  projectId: string | null;
  onUpdate: (updates: Partial<UpdateIssueRequest>) => void;
  triggerRender?: React.ReactElement;
  align?: "start" | "center" | "end";
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useT("projects");
  const wsId = useWorkspaceId();
  const { data: modules = [] } = useQuery({
    ...moduleListOptions(wsId, projectId ?? undefined),
    enabled: projectId !== null,
  });
  const current = modules.find((m) => m.id === moduleId);
  const [filter, setFilter] = useState("");
  const createModule = useCreateModule();
  // Same controlled-open normalization as the project picker: Base UI
  // latches a controlled open, and a locked picker can never be open.
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const locked = disabled || projectId === null;
  const open = locked ? false : controlledOpen ?? internalOpen;
  const setOpen = locked ? () => {} : onOpenChange ?? setInternalOpen;

  // Substring plus pinyin so Chinese module titles are reachable from
  // latin input, matching the project picker.
  const query = filter.trim().toLowerCase();
  const filtered = modules.filter(
    (m) => m.title.toLowerCase().includes(query) || matchesPinyin(m.title, query),
  );
  // Linear-style inline creation: the search text doubles as the new
  // module's title. Hidden on an exact (case-insensitive) duplicate —
  // picking the existing row is the same outcome with no extra row.
  const createTitle = filter.trim();
  const canCreate =
    projectId !== null &&
    createTitle.length > 0 &&
    !modules.some((m) => m.title.trim().toLowerCase() === query);

  const resolvedTriggerRender = triggerRender ?? (
    <button type="button" disabled={locked} className={PICKER_TRIGGER_CLASS} />
  );

  return (
    <div className="inline-flex min-w-0">
      <PropertyPicker
        open={open}
        onOpenChange={setOpen}
        width="w-52"
        align={align}
        searchable
        searchPlaceholder={t(($) => $.module.picker.search_placeholder)}
        onSearchChange={setFilter}
        triggerRender={resolvedTriggerRender}
        trigger={
          projectId === null ? (
            <>
              <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate text-muted-foreground">
                {t(($) => $.module.picker.needs_project)}
              </span>
            </>
          ) : current ? (
            <>
              <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{current.title}</span>
            </>
          ) : (
            <>
              <Boxes className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{t(($) => $.module.picker.none)}</span>
            </>
          )
        }
      >
        {/* "No module" always leads the list — the only clear entry,
            mirroring the no-project row in the project picker. */}
        <PickerItem
          emptyValue
          selected={!moduleId}
          onClick={() => {
            onUpdate({ module_id: null });
            setOpen(false);
          }}
        >
          <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">{t(($) => $.module.picker.none)}</span>
        </PickerItem>

        {filtered.map((m) => (
          <PickerItem
            key={m.id}
            selected={m.id === moduleId}
            onClick={() => {
              onUpdate({ module_id: m.id });
              setOpen(false);
            }}
          >
            <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="truncate">{m.title}</span>
          </PickerItem>
        ))}

        {modules.length === 0 && !canCreate && (
          <div className="px-2 py-1.5 text-caption text-muted-foreground">
            {t(($) => $.module.picker.empty)}
          </div>
        )}
        {modules.length > 0 && filtered.length === 0 && query && !canCreate && <PickerEmpty />}

        {canCreate && (
          <PickerItem
            selected={false}
            disabled={createModule.isPending}
            onClick={() => {
              if (projectId === null) return;
              createModule.mutate(
                { project_id: projectId, title: createTitle },
                {
                  onSuccess: (created) => {
                    onUpdate({ module_id: created.id });
                    setFilter("");
                    setOpen(false);
                  },
                  onError: () =>
                    toast.error(t(($) => $.module.create.toast_failed)),
                },
              );
            }}
          >
            <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="truncate">
              {t(($) => $.module.picker.create, { title: createTitle })}
            </span>
          </PickerItem>
        )}
      </PropertyPicker>
    </div>
  );
}
