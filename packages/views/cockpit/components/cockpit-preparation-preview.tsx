"use client";

import type { CockpitPreparationPreviewEffect, CockpitPreparationResolvedScope, IssueOperationTarget } from "@multica/core/types";
import { useT } from "../../i18n";
import { IssueOperationTargets, useIssueOperationReasonLabel } from "../../issues/components/issue-operation-restriction";

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
  const { t } = useT("cockpit");
  return (kind: string) => kind === "cancel_issue" ? t(($) => $.meeting_disposition.cancel_issue)
    : kind === "change_due_date" ? t(($) => $.meeting_disposition.change_due_date)
      : kind === "link_meeting" ? t(($) => $.meeting_disposition.link_meeting)
        : kind === "stop_run" ? t(($) => $.meeting_disposition.stop_run) : t(($) => $.artifacts.unknown);
}


export function CockpitPreparationPreview({ effects, selectedTotal, blockedReasons }: { effects: CockpitPreparationPreviewEffect[]; selectedTotal: number; blockedReasons: string[] }) {
  const { t } = useT("cockpit");
  const effectLabel = usePreparationEffectLabel();
  return <section className="space-y-3">
    <p className="text-caption text-muted-foreground">{t(($) => $.meeting_preparation.authorized_count, { count: selectedTotal })}</p>
    <CockpitPreparationReasons codes={blockedReasons} />
    <ul className="space-y-2">{effects.map((effect) => <li key={effect.slot_id} className="space-y-1 rounded-md border border-border p-3 text-caption">
      <p className="font-medium">{effect.label || effectLabel(effect.kind)}</p>
      <p className="text-muted-foreground">{effectLabel(effect.kind)}</p>
      <CockpitPreparationReasons codes={effect.reason_codes} targets={effect.targets} />
    </li>)}</ul>
  </section>;
}

export function CockpitPreparationScope({ value }: { value: CockpitPreparationResolvedScope }) {
  const { t } = useT("cockpit");
  return <dl className="grid gap-2 rounded-md bg-muted/40 p-2 text-caption sm:grid-cols-3"><div className="min-w-0"><dt className="text-muted-foreground">{t(($) => $.meeting_preparation.resolved_node)}</dt><dd className="line-clamp-2 break-words" title={value.node_title || value.node_id || undefined}>{value.node_title || value.node_id || t(($) => $.common.unset)}</dd></div><div className="min-w-0"><dt className="text-muted-foreground">{t(($) => $.binding.project)}</dt><dd className="line-clamp-2 break-words" title={value.project_title || value.project_id || undefined}>{value.project_title || value.project_id || t(($) => $.common.unset)}</dd></div><div className="min-w-0"><dt className="text-muted-foreground">{t(($) => $.binding.module)}</dt><dd className="line-clamp-2 break-words" title={value.module_title || value.module_id || undefined}>{value.module_title || value.module_id || t(($) => $.common.unset)}</dd></div></dl>;
}
