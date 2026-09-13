"use client";
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Issue } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import {
  childIssuesOptions,
  issueAttachmentsOptions,
  issueDetailOptions,
  issueTimelineOptions,
} from "@multica/core/issues/queries";
import { projectDetailOptions } from "@multica/core/projects/queries";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { useStatusLabel } from "../utils/status-label";
import {
  buildIssueExportMarkdown,
  issueExportFilename,
} from "../utils/build-issue-export";

/**
 * One-click Markdown export of a single issue, for handing the task to any
 * local AI agent. Data is pulled through `ensureQueryData` at click time —
 * never subscribed — so mounting this hook (it renders in every row's action
 * menu) costs nothing until the user actually exports.
 *
 * The list API omits `description`, so the detail query is re-ensured first
 * and its response is the issue that gets exported; a detail-page export just
 * reuses the warm cache.
 */
export function useExportIssue(issue: Issue | null): {
  exportIssue: () => Promise<void>;
  exporting: boolean;
} {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const navigation = useNavigation();
  const qc = useQueryClient();
  const { getActorName } = useActorName();
  const statusLabel = useStatusLabel(wsId);
  const [exporting, setExporting] = useState(false);

  const exportIssue = useCallback(async () => {
    const issueId = issue?.id;
    if (!issue || !issueId || exporting) return;
    setExporting(true);
    try {
      // Fresh snapshot over the row's data: the detail response is the only
      // one guaranteed to carry `description`.
      const detail = await qc.ensureQueryData(issueDetailOptions(wsId, issueId));
      const timeline = await qc.ensureQueryData(issueTimelineOptions(issueId));
      const attachments = await qc.ensureQueryData(issueAttachmentsOptions(issueId));
      const children = await qc.ensureQueryData(childIssuesOptions(wsId, issueId));
      const parent = detail.parent_issue_id
        ? await qc.ensureQueryData(issueDetailOptions(wsId, detail.parent_issue_id))
        : undefined;
      const project = detail.project_id
        ? await qc.ensureQueryData(projectDetailOptions(wsId, detail.project_id))
        : undefined;

      const markdown = buildIssueExportMarkdown({
        issue: detail,
        timeline: timeline ?? [],
        attachments: attachments ?? [],
        childIssues: children ?? [],
        statusLabel: statusLabel(detail.status),
        assigneeName:
          detail.assignee_type && detail.assignee_id
            ? getActorName(detail.assignee_type, detail.assignee_id)
            : undefined,
        creatorName: getActorName(detail.creator_type, detail.creator_id),
        parentIdentifier: parent?.identifier,
        projectName: project?.title,
        url: navigation.getShareableUrl(
          paths.issueDetail(detail.identifier || issueId),
        ),
        exportedAt: new Date().toISOString(),
      });

      const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = issueExportFilename(detail.identifier);
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      // Next tick, so the click has started the download first.
      setTimeout(() => URL.revokeObjectURL(url), 0);

      toast.success(t(($) => $.actions.export_success, { identifier: detail.identifier }));
    } catch {
      toast.error(t(($) => $.actions.export_failed));
    } finally {
      setExporting(false);
    }
  }, [issue, exporting, wsId, qc, statusLabel, getActorName, paths, navigation, t]);

  return { exportIssue, exporting };
}
