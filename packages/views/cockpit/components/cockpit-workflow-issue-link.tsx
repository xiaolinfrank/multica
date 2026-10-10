"use client";
import type { CockpitWorkflowIssue } from "@multica/core/types";
import { useWorkspacePaths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import { isBuiltInIssueStatus } from "@multica/core/issue-statuses";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";
import { StatusIcon } from "../../issues/components/status-icon";

export function WorkflowIssueLink({ issue, newTab = false }: { issue: CockpitWorkflowIssue; newTab?: boolean }) {
  const paths = useWorkspacePaths();
  const { t } = useT("cockpit");
  const { t: issueT } = useT("issues");
  const { getActorName } = useActorName();
  const statusKey = issue.status;
  const status = isBuiltInIssueStatus(statusKey) ? issueT(($) => $.status[statusKey]) : statusKey;
  const assignee = issue.assignee_id ? getActorName(issue.assignee_type, issue.assignee_id) : t(($) => $.workflow.unassigned);
  return <div className="space-y-1"><AppLink href={paths.issueDetail(issue.identifier || issue.id)} newTabTitle={issue.title}
    target={newTab ? "_blank" : undefined} rel={newTab ? "noreferrer" : undefined}
    className="inline-flex max-w-full items-start gap-2 text-caption hover:underline">
    <StatusIcon status={issue.status} className="mt-0.5 size-3.5 shrink-0" />
    <span className="min-w-0 break-words"><span className="mr-1.5 font-mono text-muted-foreground">{issue.identifier || issue.id}</span>{" "}{issue.title}</span>
  </AppLink><p className="text-caption text-muted-foreground">{t(($) => $.workflow.issue_meta, { assignee, status })}</p></div>;
}
