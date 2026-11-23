"use client";

import { SlidersHorizontal } from "@multica/ui/icons";
import { cn } from "@multica/ui/lib/utils";
import { Button } from "@multica/ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@multica/ui/components/ui/popover";
import { DisplayChip } from "../../issues/components/display-parts";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { Switch } from "@multica/ui/components/ui/switch";
import { useSidebarProjectPrefs, useUpdateSidebarProjectPrefs } from "@multica/core/issues/sidebar-project-prefs";
import {
  DEFAULT_SIDEBAR_PROJECT_SETTINGS,
  type SidebarProjectOrdering,
  type SidebarProjectSettings,
} from "@multica/core/issues/stores/sidebar-tree-store";
import { PROJECT_STATUS_CONFIG, PROJECT_STATUS_ORDER } from "@multica/core/projects/config";
import type { ProjectStatus } from "@multica/core/types";
import { useProjectStatusLabels } from "../../projects/components/labels";
import { useT } from "../../i18n";
import { TREE_ROW_BUTTON_CLASS } from "./sidebar-tree";

const PROJECT_ORDERINGS: SidebarProjectOrdering[] = ["manual", "name", "updated", "created"];

const sameSettings = <T,>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

function Caption({ children }: { children: React.ReactNode }) {
  return <span className="text-caption font-medium text-muted-foreground">{children}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Caption>{label}</Caption>
      {children}
    </div>
  );
}

function SwitchField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <Caption>{label}</Caption>
      <Switch size="sm" checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function SortSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as T);
      }}
    >
      <SelectTrigger size="sm" className={className} aria-label={label}>
        <SelectValue>
          <span className="truncate">{options.find((o) => o.value === value)?.label}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="w-auto min-w-(--anchor-width)">
        <SelectGroup>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function ProjectsGroup({
  settings,
  update,
}: {
  settings: SidebarProjectSettings;
  update: (patch: Partial<SidebarProjectSettings>) => void;
}) {
  const { t } = useT("layout");
  const statusLabels = useProjectStatusLabels();
  const toggleStatus = (status: ProjectStatus, on: boolean) =>
    update({ statuses: PROJECT_STATUS_ORDER.filter((s) => (s === status ? on : settings.statuses.includes(s))) });

  return (
    <section className="space-y-3">
      <h3 className="text-label font-medium text-foreground">{t(($) => $.nav.projects)}</h3>
      <Field label={t(($) => $.panels.work.projects_ordering)}>
        <SortSelect
          label={t(($) => $.panels.work.projects_ordering)}
          value={settings.ordering}
          options={PROJECT_ORDERINGS.map((value) => ({
            value,
            label: {
              manual: t(($) => $.panels.work.projects_order_manual),
              name: t(($) => $.panels.work.projects_order_name),
              updated: t(($) => $.panels.work.projects_order_updated),
              created: t(($) => $.panels.work.projects_order_created),
            }[value],
          }))}
          onChange={(ordering) => update({ ordering })}
          className="w-36"
        />
      </Field>
      <div>
        <Caption>{t(($) => $.panels.work.projects_show)}</Caption>
        <div className="mt-2 flex flex-wrap gap-1">
          {PROJECT_STATUS_ORDER.map((status) => (
            <DisplayChip
              key={status}
              pressed={settings.statuses.includes(status)}
              onPressedChange={(on) => toggleStatus(status, on)}
            >
              <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", PROJECT_STATUS_CONFIG[status].dotColor)} />
              <span className="truncate">{statusLabels[status]}</span>
            </DisplayChip>
          ))}
        </div>
      </div>
      <SwitchField
        label={t(($) => $.panels.work.projects_only_mine)}
        checked={settings.onlyMine}
        onChange={(onlyMine) => update({ onlyMine })}
      />
      <SwitchField
        label={t(($) => $.panels.work.projects_show_count)}
        checked={settings.showCount}
        onChange={(showCount) => update({ showCount })}
      />
    </section>
  );
}

export function ProjectsSectionSettings({ wsId, className }: { wsId: string; className?: string }) {
  const { t } = useT("layout");
  const { projectSettings } = useSidebarProjectPrefs(wsId);
  const update = useUpdateSidebarProjectPrefs(wsId);
  // The issue-list group is gone: a project's tree is modules and work items
  // now, not tasks. The stored preference keeps its fields (and its defaults)
  // so an older client's payload stays valid, but nothing in this panel reads
  // them.
  const changed = !sameSettings(projectSettings, DEFAULT_SIDEBAR_PROJECT_SETTINGS);
  const reset = () => update({ projectSettings: DEFAULT_SIDEBAR_PROJECT_SETTINGS });

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t(($) => $.panels.work.projects_settings)}
            className={cn(
              TREE_ROW_BUTTON_CLASS,
              "text-muted-foreground data-popup-open:bg-surface-selected data-popup-open:text-foreground data-popup-open:opacity-100",
              className,
            )}
          />
        }
      >
        <SlidersHorizontal className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="max-h-(--available-height) w-80 gap-0 overflow-y-auto p-3"
      >
        {/* Spacing separates sections — no dividers, as in the Display panel. */}
        <ProjectsGroup settings={projectSettings} update={(patch) => update({ projectSettings: patch })} />
        {changed && (
          <div className="-mr-1.5 mt-4 flex justify-end">
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={reset}>
              {t(($) => $.panels.work.reset)}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
