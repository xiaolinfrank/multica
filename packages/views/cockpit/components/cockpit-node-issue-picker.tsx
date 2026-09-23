"use client";

// The work item a new issue is being opened against.
//
// The cockpit's "New issue" arrives at the create dialog with a row already
// chosen — that row is what decided the project, the module and the number the
// title opens on — and this is where the choice is shown and, when it was the
// wrong row, changed. Only rows the board can file into are offered: a mainline
// or a direction names a project rather than a module, so picking one could not
// answer the question the field is asking.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListTree } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  buildCockpitDisplayCodes,
  buildCockpitSummaryTree,
  buildCockpitTree,
  cockpitBoardOptions,
  cockpitNodeIssueFiling,
  cockpitStoredDirectionCode,
} from "@multica/core/cockpit";
import { moduleListOptions } from "@multica/core/modules/queries";
import {
  PICKER_TRIGGER_CLASS,
  PickerEmpty,
  PickerItem,
  PropertyPicker,
} from "../../issues/components/pickers/property-picker";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import { useT } from "../../i18n";

/**
 * A work item an issue can be filed against, resolved down to everything the
 * create dialog needs from it. Travels whole so the field can name the row
 * before the board query has answered — it is seeded by the surface that
 * opened the dialog, which had already resolved it.
 */
export interface CockpitNodeIssueOption {
  node_id: string;
  /** The row's display code — "01.01.01". */
  code: string;
  /** Code and name together, as the gantt's leftmost column reads. */
  label: string;
  project_id: string;
  module_id: string;
}

/** The rows on the board that an issue can be filed against, by display code. */
export function useCockpitNodeIssueOptions(): CockpitNodeIssueOption[] {
  const wsId = useWorkspaceId();
  const { data: board } = useQuery(cockpitBoardOptions(wsId));
  const { data: modules } = useQuery(moduleListOptions(wsId));

  return useMemo(() => {
    const nodes = board?.nodes ?? [];
    if (nodes.length === 0 || !modules) return [];
    // The summary tree, because that is the shape the gantt ships and the
    // codes the module numbering follows; each row's stored direction code
    // rides along as the drift cross-check.
    const codes = buildCockpitDisplayCodes(buildCockpitSummaryTree(buildCockpitTree(nodes)));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const options: CockpitNodeIssueOption[] = [];
    for (const [id, code] of codes) {
      const node = byId.get(id);
      // A merged group row is synthetic — it stands in for its members and has
      // no row of its own to link against.
      if (!node) continue;
      const filing = cockpitNodeIssueFiling(
        code,
        modules,
        cockpitStoredDirectionCode(node, byId),
      );
      if (!filing) continue;
      options.push({
        node_id: id,
        code,
        label: `${code} ${node.name}`.trim(),
        project_id: filing.project_id,
        module_id: filing.module_id,
      });
    }
    options.sort((a, b) => a.code.localeCompare(b.code));
    return options;
  }, [board?.nodes, modules]);
}

export function CockpitNodeIssuePicker({
  value,
  onUpdate,
  triggerRender,
  align = "start",
  open: controlledOpen,
  onOpenChange,
  disabled = false,
}: {
  value: CockpitNodeIssueOption | null;
  /** Null clears the link; the dialog decides what that leaves behind. */
  onUpdate: (next: CockpitNodeIssueOption | null) => void;
  triggerRender?: React.ReactElement;
  align?: "start" | "center" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useT("cockpit");
  const options = useCockpitNodeIssueOptions();
  const [filter, setFilter] = useState("");
  const [internalOpen, setInternalOpen] = useState(false);
  const open = disabled ? false : controlledOpen ?? internalOpen;
  const setOpen = disabled ? () => {} : onOpenChange ?? setInternalOpen;

  // Substring plus pinyin, as the project and module pickers do: the rows are
  // "01.01.01 数据产权登记", reachable by number or by name from latin input.
  const query = filter.trim().toLowerCase();
  const filtered = options.filter(
    (o) => o.label.toLowerCase().includes(query) || matchesPinyin(o.label, query),
  );

  const resolvedTriggerRender = triggerRender ?? (
    <button type="button" disabled={disabled} className={PICKER_TRIGGER_CLASS} />
  );

  return (
    <div className="inline-flex min-w-0">
      <PropertyPicker
        open={open}
        onOpenChange={setOpen}
        width="w-72"
        align={align}
        searchable
        searchPlaceholder={t(($) => $.node_picker.search_placeholder)}
        onSearchChange={setFilter}
        triggerRender={resolvedTriggerRender}
        trigger={
          <>
            <ListTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className={value ? "truncate" : "truncate text-muted-foreground"}>
              {value ? value.label : t(($) => $.node_picker.none)}
            </span>
          </>
        }
      >
        <PickerItem
          emptyValue
          selected={!value}
          onClick={() => {
            onUpdate(null);
            setOpen(false);
          }}
        >
          <ListTree className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">{t(($) => $.node_picker.none)}</span>
        </PickerItem>

        {filtered.map((option) => (
          <PickerItem
            key={option.node_id}
            selected={option.node_id === value?.node_id}
            onClick={() => {
              onUpdate(option);
              setOpen(false);
            }}
          >
            <ListTree className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="truncate">{option.label}</span>
          </PickerItem>
        ))}

        {options.length === 0 && (
          <div className="px-2 py-1.5 text-caption text-muted-foreground">
            {t(($) => $.node_picker.empty)}
          </div>
        )}
        {options.length > 0 && filtered.length === 0 && query && <PickerEmpty />}
      </PropertyPicker>
    </div>
  );
}
