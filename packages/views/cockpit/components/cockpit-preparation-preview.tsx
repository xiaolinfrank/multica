"use client";

import { useState } from "react";
import { cn } from "@multica/ui/lib/utils";
import { useWorkspacePaths } from "@multica/core/paths";
import { AppLink } from "../../navigation";
import type { CockpitPreparationPreviewEffect, CockpitMeetingTemplateSlot, CockpitPreparationResolvedScope, IssueOperationTarget } from "@multica/core/types";
import { useT } from "../../i18n";
import { IssueOperationTargets, useIssueOperationReasonLabel } from "../../issues/components/issue-operation-restriction";
import { CockpitFlowPaging } from "./cockpit-task-flow";
import { CockpitTemplateSlotText, useMeetingTemplateKindLabel } from "./cockpit-meeting-template-fields";

export function CockpitPreparationReasons({ codes, targets = [] }: { codes: string[]; targets?: IssueOperationTarget[] }) {
  const { t } = useT("cockpit"); const issueReason = useIssueOperationReasonLabel();
  const special: Record<string, string> = {
    human_required: t(($) => $.meeting_lifecycle.human_required), workflow_manager_required: t(($) => $.meeting_lifecycle.manager_required),
    meeting_archived: t(($) => $.meeting_disposition.archived_preparation), meeting_cancelled: t(($) => $.meeting_disposition.cancelled_preparation),
    preparation_responsible_required: t(($) => $.meeting_preparation.reason_responsible), preparation_needs_attention: t(($) => $.meeting_preparation.reason_attention),
    context_changed: t(($) => $.meeting_preparation.reason_context), meeting_preparation_closed: t(($) => $.meeting_preparation.reason_closed),
    target_meeting_preparation_closed: t(($) => $.meeting_preparation.reason_target_closed), issue_revision_changed: t(($) => $.meeting_preparation.reason_issue_changed),
    run_already_ended: t(($) => $.meeting_preparation.reason_run_ended), meeting_already_started: t(($) => $.meeting_preparation.reason_started), meeting_ended_reopen_first: t(($) => $.meeting_preparation.reason_ended_reopen),
    meeting_preparation_history: t(($) => $.meeting_preparation.reason_preparation_history), workflow_history: t(($) => $.meeting_preparation.reason_workflow_history),
    target_unavailable: t(($) => $.meeting_preparation.reason_target_unavailable), forbidden: t(($) => $.meeting_preparation.reason_forbidden),
  };
  const labels = [...new Set(codes.map((code) => special[code] ?? issueReason(code)))];
  return <div className="space-y-2 text-caption text-muted-foreground">{labels.map((label) => <p key={label}>{label}</p>)}<IssueOperationTargets targets={targets} />
    {codes.length > 0 && <details><summary className="cursor-pointer">{t(($) => $.artifact_runtime.diagnostics)}</summary><ul className="max-h-40 overflow-y-auto break-all">{codes.map((code) => <li key={code}>{code}</li>)}</ul></details>}
  </div>;
}

export function usePreparationEffectLabel() {
  const { t } = useT("cockpit"); const templateKind = useMeetingTemplateKindLabel();
  return (kind: string) => kind === "cancel_issue" ? t(($) => $.meeting_disposition.cancel_issue)
    : kind === "change_due_date" ? t(($) => $.meeting_disposition.change_due_date)
      : kind === "link_meeting" ? t(($) => $.meeting_disposition.link_meeting)
        : kind === "stop_run" ? t(($) => $.meeting_disposition.stop_run) : templateKind(kind);
}

export function CockpitPreparationPreview({ effects, selectedTotal, blockedReasons, slots }: {
  effects: CockpitPreparationPreviewEffect[]; selectedTotal: number; blockedReasons: string[]; slots?: CockpitMeetingTemplateSlot[];
}) {
  const { t } = useT("cockpit"); const paths = useWorkspacePaths(); const label = usePreparationEffectLabel(); const [page, setPage] = useState(1);
  const selected = effects.filter((effect) => effect.selected); const currentPage = Math.min(page, Math.max(1, Math.ceil(selected.length / 25))); const shown = selected.slice((currentPage - 1) * 25, currentPage * 25);
  const created = selected.filter((effect) => effect.kind === "agenda" || effect.kind === "preparation_issue").length;
  const reused = selected.filter((effect) => effect.kind === "issue_reference" || effect.kind === "material_reference" || effect.kind === "link_meeting").length;
  return <section aria-label={t(($) => $.meeting_templates.preview)} className="space-y-3">
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption"><p>{t(($) => $.meeting_templates.selected_total, { count: selectedTotal })}</p>{created > 0 && <p>{t(($) => $.meeting_templates.creates_total, { count: created })}</p>}{reused > 0 && <p>{t(($) => $.meeting_templates.links_total, { count: reused })}</p>}</div>
    <CockpitPreparationReasons codes={blockedReasons} />
    {selected.length > 25 && <CockpitFlowPaging page={currentPage} shown={shown.length} total={selectedTotal} hasNext={currentPage * 25 < selected.length} busy={false} onPrevious={() => setPage(currentPage - 1)} onNext={() => setPage(currentPage + 1)} />}
    <ul className={cn("max-h-[42vh] divide-y divide-border overflow-y-auto rounded-lg border border-border px-3", selected.length > 25 && "h-[42vh]")}>{shown.map((effect) => <li key={effect.slot_id} className="space-y-2 py-3"><div className="flex flex-wrap items-start justify-between gap-2"><p className="min-w-0 flex-1 line-clamp-2 break-words text-body font-medium" title={effect.label}>{effect.label}</p><span className="text-caption text-muted-foreground">{label(effect.kind)}</span></div>
      {slots?.some((slot) => slot.slot_id === effect.slot_id) && <CockpitTemplateSlotText slot={slots.find((slot) => slot.slot_id === effect.slot_id)!} />}
      {effect.scope && <CockpitPreparationScope value={effect.scope} />}
      <CockpitPreparationReasons codes={effect.reason_codes} targets={effect.targets} />
      {!effect.allowed && <p className="text-caption text-destructive">{t(($) => $.meeting_templates.item_blocked)}</p>}
      {effect.kind === "cancel_issue" && effect.issue_impact && <div className="space-y-1 text-caption text-muted-foreground"><p>{t(($) => $.meeting_disposition.cancel_wakeups, { ordinary: effect.issue_impact.ordinary_wakeup_count, system: effect.issue_impact.system_rule_count, queued: effect.issue_impact.unstarted_wakeup_run_count })}</p>
        {effect.issue_impact.evaluates_parent_rules && <div className="space-y-1"><p>{t(($) => $.meeting_preparation.parent_rules)}</p>{effect.issue_impact.parent_issue_id && <AppLink target="_blank" rel="noopener noreferrer" href={paths.issueDetail(effect.issue_impact.parent_issue_id)} className="text-primary underline">{t(($) => $.meeting_preparation.open_parent)} {t(($) => $.action_flow.new_tab)}</AppLink>}</div>}
        {effect.issue_impact.active_run_count > 0 && <p>{t(($) => $.meeting_disposition.runs_separate, { count: effect.issue_impact.active_run_count })}</p>}</div>}
      {effect.kind === "stop_run" && <p className="text-caption text-muted-foreground">{t(($) => $.meeting_disposition.stop_hint)}</p>}
    </li>)}</ul>
  </section>;
}

export function CockpitPreparationScope({ value }: { value: CockpitPreparationResolvedScope }) {
  const { t } = useT("cockpit");
  return <dl className="grid gap-2 rounded-md bg-muted/40 p-2 text-caption sm:grid-cols-3"><div className="min-w-0"><dt className="text-muted-foreground">{t(($) => $.meeting_preparation.resolved_node)}</dt><dd className="line-clamp-2 break-words" title={value.node_title || value.node_id || undefined}>{value.node_title || value.node_id || t(($) => $.common.unset)}</dd></div><div className="min-w-0"><dt className="text-muted-foreground">{t(($) => $.binding.project)}</dt><dd className="line-clamp-2 break-words" title={value.project_title || value.project_id || undefined}>{value.project_title || value.project_id || t(($) => $.common.unset)}</dd></div><div className="min-w-0"><dt className="text-muted-foreground">{t(($) => $.binding.module)}</dt><dd className="line-clamp-2 break-words" title={value.module_title || value.module_id || undefined}>{value.module_title || value.module_id || t(($) => $.common.unset)}</dd></div></dl>;
}
