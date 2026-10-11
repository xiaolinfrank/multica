"use client";

import type { ContainerOperationBasis, IssueOperationBasis, IssueOperationField, IssueOperationName, IssueOperationTarget } from "@multica/core/types";
import { cockpitArtifactPath, cockpitObjectPath, cockpitIssueInputManifestPath, EMPTY_COCKPIT_SCOPE } from "@multica/core/cockpit";
import { useWorkspacePaths } from "@multica/core/paths";
import { Button } from "@multica/ui/components/ui/button";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export interface IssueOperationObservation {
  basis?: IssueOperationBasis;
  pending: boolean;
  error: boolean;
  retry: () => void;
}

function useReasonLabel() {
  const { t } = useT("issues");
  return (reason: string) => {
    switch (reason) {
      case "parent_scope_requires_detach": return t(($) => $.operation_basis.parent_detach);
      case "parent_scope": return t(($) => $.operation_basis.parent_scope);
      case "primary_scope": return t(($) => $.operation_basis.primary_scope);
      case "retained_artifact_scope": return t(($) => $.operation_basis.retained_scope);
      case "retained_input_history": return t(($) => $.operation_basis.retained_input_history);
      case "meeting_input_references": return t(($) => $.operation_basis.meeting_input_references);
      case "retained_formal_history": return t(($) => $.operation_basis.retained_formal);
      case "retained_meeting_history":
      case "retained_meeting_action": return t(($) => $.operation_basis.retained_meeting);
      case "meeting_execution_gate": return t(($) => $.operation_basis.meeting_execution);
      case "issue_in_triage": return t(($) => $.operation_basis.triage);
      case "primary_scope_required": return t(($) => $.operation_basis.scope_required);
      case "human_required": return t(($) => $.operation_basis.human_required);
      case "formal_reviewer_binding": return t(($) => $.operation_basis.reviewer);
      case "formal_review_scope": return t(($) => $.operation_basis.formal_scope);
      case "human_formal_review": return t(($) => $.operation_basis.human_review);
      case "formal_review_status": return t(($) => $.operation_basis.formal_status);
      case "primary_execution_leaf":
      case "retained_execution_leaf": return t(($) => $.operation_basis.execution_leaf);
      case "node_has_children": return t(($) => $.operation_basis.node_has_children);
      case "workspace_admin_required": return t(($) => $.operation_basis.admin_required);
      default: return t(($) => $.operation_basis.unknown);
    }
  };
}

function OperationTargets({ targets }: { targets: IssueOperationTarget[] }) {
  const paths = useWorkspacePaths(); const { t } = useT("issues");
  return <ul className="space-y-1">{targets.map((target, index) => {
    const href = target.kind === "issue" && target.issue_id ? target.view === "inputs" && target.version_id ? cockpitIssueInputManifestPath(paths.issueDetail(target.issue_id), new URLSearchParams(), target.version_id) : paths.issueDetail(target.issue_id)
      : target.kind === "artifact" && target.artifact_id ? cockpitArtifactPath(paths.cockpit(), target.artifact_id, EMPTY_COCKPIT_SCOPE)
      : target.kind === "artifact_version" && target.artifact_id && target.version_id ? cockpitArtifactPath(paths.cockpit(), target.artifact_id, EMPTY_COCKPIT_SCOPE, target.version_id)
        : target.kind === "acceptance_request" && target.node_id && target.request_id ? cockpitObjectPath(paths.cockpit(), { kind: "node", id: target.node_id, view: "acceptance", requestId: target.request_id })
          : target.kind === "node" && target.node_id ? cockpitObjectPath(paths.cockpit(), { kind: "node", id: target.node_id, view: target.view === "acceptance" || target.view === "details" || target.view === "artifacts" ? target.view : "tasks" })
            : target.kind === "meeting" && target.meeting_id ? cockpitObjectPath(paths.cockpit(), { kind: "meeting", id: target.meeting_id, view: target.view === "resources" || target.view === "agenda" || target.view === "details" ? target.view : "workflow", actionId: target.action_id, preparationId: target.operation_id, directoryOperationId: target.directory_operation_id }) : null;
    if (!href) return <li key={`unavailable:${index}`} className="break-words">{target.label || t(($) => $.operation_basis.unknown)}</li>;
    const label = target.purpose === "formal_review" ? `${t(($) => $.operation_basis.open_formal)}${target.label && target.label !== t(($) => $.operation_basis.open_formal) ? ` · ${target.label}` : ""}` : target.label || t(($) => $.operation_basis.open_record);
    return <li key={`${href}:${index}`}><AppLink href={href} target="_blank" rel="noopener noreferrer" className="break-words text-primary underline underline-offset-4">{label} {t(($) => $.operation_basis.new_tab)}</AppLink></li>;
  })}</ul>;
}

function OperationExplanation({ field, availability, targets, total, pending, error, retry }: {
  field?: IssueOperationField; availability?: string; targets: IssueOperationTarget[]; total: number;
  pending: boolean; error: boolean; retry: () => void;
}) {
  const { t } = useT("issues"); const reasonLabel = useReasonLabel();
  if (error) return <div role="alert" className="space-y-2 break-words text-caption"><p>{t(($) => $.operation_basis.failed)}</p><Button type="button" variant="outline" size="sm" onClick={retry}>{t(($) => $.operation_basis.retry)}</Button></div>;
  if (pending) return <p role="status" className="break-words text-caption text-muted-foreground">{t(($) => $.operation_basis.checking)}</p>;
  const unavailable = availability === "unavailable";
  if (availability !== "available" || !field || field.state === "unknown") return <div className="space-y-2 break-words text-caption"><p>{unavailable ? t(($) => $.operation_basis.unavailable) : t(($) => $.operation_basis.unknown)}</p><Button type="button" variant="outline" size="sm" onClick={retry}>{t(($) => $.operation_basis.retry)}</Button></div>;
  if (field.state === "allowed" && field.reason_codes.length === 0) return null;
  const reasons = [...new Set(field.reason_codes.length ? field.reason_codes.map(reasonLabel) : [t(($) => $.operation_basis.unknown)])];
  return <div className="space-y-2 break-words text-caption text-muted-foreground">
    {reasons.map((reason) => <p key={reason}>{reason}</p>)}
    <OperationTargets targets={targets} />
    {total > targets.length && <p>{t(($) => $.operation_basis.more_records, { count: total - targets.length })}</p>}
    {field.state === "blocked" && <Button type="button" variant="outline" size="sm" onClick={retry}>{t(($) => $.operation_basis.retry)}</Button>}
  </div>;
}

export function IssueOperationRestriction({ observation, operation }: { observation: IssueOperationObservation; operation: IssueOperationName }) {
  const { basis, pending, error, retry } = observation;
  return <OperationExplanation field={basis?.[operation]} availability={basis?.availability} targets={basis?.targets ?? []} total={basis?.targets_total ?? 0} pending={pending} error={error} retry={retry} />;
}

export function ContainerOperationRestriction({ basis, operation, pending, error, retry }: {
  basis?: ContainerOperationBasis; operation: "delete" | "structural_edit" | "add_child"; pending: boolean; error: boolean; retry: () => void;
}) {
  return <OperationExplanation field={basis?.[operation]} availability={basis?.availability} targets={basis?.targets ?? []} total={basis?.targets_total ?? 0} pending={pending} error={error} retry={retry} />;
}

export { OperationTargets as IssueOperationTargets, useReasonLabel as useIssueOperationReasonLabel };
