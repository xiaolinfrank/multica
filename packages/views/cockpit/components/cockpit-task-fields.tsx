"use client";
import { useId } from "react";
import type { IssueAssigneeType } from "@multica/core/types";
import { Input } from "@multica/ui/components/ui/input";
import { Button } from "@multica/ui/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@multica/ui/components/ui/select";
import { CockpitAssigneePicker } from "./cockpit-assignee-picker";
import { useT } from "../../i18n";

export interface CockpitTaskFieldsValue { assigneeType: IssueAssigneeType; assigneeId: string; priority: string; dueDate: string }
export function cockpitTaskFieldsValue(userId: string, input?: { assignee_type?: string; assignee_id?: string; priority?: string; due_date?: string }): CockpitTaskFieldsValue {
  return { assigneeType: input?.assignee_type === "agent" || input?.assignee_type === "squad" ? input.assignee_type : "member",
    assigneeId: input?.assignee_id ?? userId, priority: input?.priority ?? "none", dueDate: input?.due_date ?? "" };
}
export function cockpitTaskFieldsBody(value: CockpitTaskFieldsValue) {
  return { assignee_type: value.assigneeType, assignee_id: value.assigneeId, priority: value.priority, ...(value.dueDate ? { due_date: value.dueDate } : {}) };
}
export function CockpitTaskFields({ wsId, value, onChange, disabled }: { wsId: string; value: CockpitTaskFieldsValue; onChange: (next: CockpitTaskFieldsValue) => void; disabled: boolean }) {
  const { t } = useT("cockpit");
  const { t: issueT } = useT("issues");
  const assigneeHintId = useId();
  const priorities = ["none", "low", "medium", "high", "urgent"] as const;
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <div className="space-y-1"><p className="text-caption">{t(($) => $.task_flow.assignee)}</p>
      <CockpitAssigneePicker wsId={wsId} assigneeType={value.assigneeType} assigneeId={value.assigneeId || null} open={disabled ? false : undefined}
        triggerRender={<Button type="button" variant="outline" size="sm" disabled={disabled}
          aria-label={t(($) => $.task_flow.assignee)} aria-describedby={!value.assigneeId ? assigneeHintId : undefined} />}
        onUpdate={(update) => { if (!disabled) onChange({ ...value, assigneeType: update.assignee_type ?? "member", assigneeId: update.assignee_id ?? "" }); }} />
      {!value.assigneeId && <p id={assigneeHintId} className="text-caption text-muted-foreground">{t(($) => $.task_flow.assignee_required)}</p>}
    </div>
    <label className="space-y-1 text-caption">{t(($) => $.task_flow.due_date)}<Input type="date" value={value.dueDate} disabled={disabled}
      onChange={(event) => onChange({ ...value, dueDate: event.target.value })} /></label>
    <label className="space-y-1 text-caption">{t(($) => $.task_flow.priority)}
      <Select value={value.priority} disabled={disabled} items={priorities.map((priority) => ({ value: priority, label: issueT(($) => $.priority[priority]) }))}
        onValueChange={(priority) => { if (priority) onChange({ ...value, priority }); }}>
        <SelectTrigger className="w-full" aria-label={t(($) => $.task_flow.priority)}><SelectValue /></SelectTrigger><SelectContent>{priorities.map((priority) => <SelectItem key={priority} value={priority}>{issueT(($) => $.priority[priority])}</SelectItem>)}</SelectContent>
      </Select>
    </label>
  </div>;
}
