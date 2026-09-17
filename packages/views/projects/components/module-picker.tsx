"use client";

import { useState } from "react";
import { Boxes } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { moduleListOptions } from "@multica/core/modules/queries";
import { useWorkspaceId } from "@multica/core/hooks";
import type { UpdateIssueRequest } from "@multica/core/types";
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

        {modules.length === 0 && (
          <div className="px-2 py-1.5 text-caption text-muted-foreground">
            {t(($) => $.module.picker.empty)}
          </div>
        )}
        {modules.length > 0 && filtered.length === 0 && query && <PickerEmpty />}
      </PropertyPicker>
    </div>
  );
}
