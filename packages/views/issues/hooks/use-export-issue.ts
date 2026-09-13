"use client";
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { zipSync, strToU8 } from "fflate";
import type { Issue, IssueProperty } from "@multica/core/types";
import { api } from "@multica/core/api";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { useActorName } from "@multica/core/workspace/hooks";
import {
  childIssuesOptions,
  issueAttachmentsOptions,
  issueDetailOptions,
  issueSubscribersOptions,
  issueTimelineOptions,
} from "@multica/core/issues/queries";
import { issueKeys } from "@multica/core/issues/queries";
import { projectDetailOptions } from "@multica/core/projects/queries";
import { propertyListOptions } from "@multica/core/properties";
import { issuePullRequestsOptions } from "@multica/core/github";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { useStatusLabel } from "../utils/status-label";
import {
  buildIssueExportMarkdown,
  issueExportFilename,
  EXPORT_CHILD_DEPTH_LIMIT,
  EXPORT_CHILD_NODE_LIMIT,
  type ExportChildIssue,
  type ExportedAttachment,
} from "../utils/build-issue-export";

/** Concurrency for pulling attachment bytes — keeps the export burst polite. */
const ATTACHMENT_FETCH_CONCURRENCY = 4;

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Next tick, so the click has started the download first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `report.pdf` → `report.pdf`; `report (2).pdf` on collision; path-safe. */
function uniqueAttachmentName(filename: string, used: Set<string>): string {
  const safe = (filename || "attachment").replace(/[\\/]/g, "_").trim() || "attachment";
  if (!used.has(safe)) {
    used.add(safe);
    return safe;
  }
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

/** Limited-concurrency map so N attachments don't open N sockets at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * One-click Markdown export of a single issue, for handing the task to any
 * local AI agent. Data is pulled through `ensureQueryData` at click time —
 * never subscribed — so mounting this hook (it renders in every row's action
 * menu) costs nothing until the user actually exports.
 *
 * The list API omits `description`, so the detail query is re-ensured first
 * and its response is the issue that gets exported; a detail-page export just
 * reuses the warm cache. The sub-issue tree is walked recursively (capped);
 * attachment bytes are downloaded and packed into a zip next to the document
 * when any exist, otherwise a bare `.md` is saved.
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
      const subscribers = await qc.ensureQueryData(
        issueSubscribersOptions(issueId),
      );
      const runs = await qc.ensureQueryData({
        queryKey: issueKeys.tasks(issueId),
        queryFn: () => api.listTasksByIssue(issueId),
        staleTime: 30_000,
      });
      const prs = await qc.ensureQueryData(issuePullRequestsOptions(issueId));
      // ensureQueryData applies neither the options' `select` nor its type:
      // it returns the raw `{properties}` response (useQuery would have
      // unwrapped it). Normalize both shapes defensively.
      const propertiesResponse = (await qc.ensureQueryData(
        propertyListOptions(wsId, true),
      )) as unknown as IssueProperty[] | { properties?: IssueProperty[] } | undefined;
      const propertyDefinitions = Array.isArray(propertiesResponse)
        ? propertiesResponse
        : propertiesResponse?.properties ?? [];
      const parent = detail.parent_issue_id
        ? await qc.ensureQueryData(issueDetailOptions(wsId, detail.parent_issue_id))
        : undefined;
      const project = detail.project_id
        ? await qc.ensureQueryData(projectDetailOptions(wsId, detail.project_id))
        : undefined;

      // Recursive sub-issue walk with the shared caps. A cycle (data bugs)
      // cannot loop: the node budget bounds the walk regardless of shape.
      let exported = 0;
      let truncated: { atDepth: boolean; nodes: number } | null = null;
      const walkChildren = async (
        parentId: string,
        depth: number,
      ): Promise<ExportChildIssue[]> => {
        if (depth >= EXPORT_CHILD_DEPTH_LIMIT) {
          truncated = truncated ?? { atDepth: true, nodes: exported };
          return [];
        }
        const children = (await qc.ensureQueryData(
          childIssuesOptions(wsId, parentId),
        )) ?? [];
        const out: ExportChildIssue[] = [];
        for (const child of children) {
          if (exported >= EXPORT_CHILD_NODE_LIMIT) {
            truncated = truncated ?? { atDepth: false, nodes: exported };
            break;
          }
          exported += 1;
          out.push({
            issue: child,
            statusLabel: statusLabel(child.status),
            assigneeName:
              child.assignee_type && child.assignee_id
                ? getActorName(child.assignee_type, child.assignee_id)
                : undefined,
            children: await walkChildren(child.id, depth + 1),
          });
        }
        return out;
      };
      const childTree = await walkChildren(issueId, 0);

      // Attachment bytes: fetch with bounded concurrency; failures degrade
      // to an absolute URL reference instead of failing the whole export.
      const attachmentRows = attachments ?? [];
      const usedNames = new Set<string>();
      const packed: { name: string; bytes: Uint8Array }[] = [];
      const exportedAttachments: ExportedAttachment[] = [];
      const origin = navigation.getShareableUrl("").replace(/\/$/, "");
      await mapWithConcurrency(attachmentRows, ATTACHMENT_FETCH_CONCURRENCY, async (a) => {
        const href = a.markdown_url || a.url;
        const absoluteUrl = href.startsWith("http") ? href : `${origin}${href}`;
        try {
          const blob = await api.getAttachmentBlob(a.id);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const name = uniqueAttachmentName(a.filename, usedNames);
          packed.push({ name, bytes });
          exportedAttachments.push({
            attachment: a,
            packedName: `attachments/${name}`,
            absoluteUrl,
          });
        } catch {
          exportedAttachments.push({ attachment: a, absoluteUrl });
        }
      });
      exportedAttachments.sort(
        (x, y) => attachmentRows.indexOf(x.attachment) - attachmentRows.indexOf(y.attachment),
      );

      const markdown = buildIssueExportMarkdown({
        issue: detail,
        timeline: timeline ?? [],
        attachments: exportedAttachments,
        childTree,
        childTreeTruncated: truncated,
        statusLabel: statusLabel(detail.status),
        assigneeName:
          detail.assignee_type && detail.assignee_id
            ? getActorName(detail.assignee_type, detail.assignee_id)
            : undefined,
        creatorName: getActorName(detail.creator_type, detail.creator_id),
        parent: parent
          ? {
              identifier: parent.identifier ?? parent.id,
              title: parent.title,
              statusLabel: statusLabel(parent.status),
            }
          : undefined,
        projectName: project?.title,
        agentRuns: runs ?? [],
        runAgentName: (id) => getActorName("agent", id),
        subscribers: subscribers ?? [],
        subscriberName: (type, id) =>
          type === "agent" || type === "member" ? getActorName(type, id) : undefined,
        pullRequests: prs?.pull_requests ?? [],
        propertyDefinitions: propertyDefinitions ?? [],
        actorName: (type, id) => getActorName(type, id),
        url: navigation.getShareableUrl(
          paths.issueDetail(detail.identifier || issueId),
        ),
        exportedAt: new Date().toISOString(),
      });

      if (packed.length > 0) {
        const zipName = issueExportFilename(detail.identifier).replace(/\.md$/, ".zip");
        const files: Record<string, Uint8Array> = {
          [issueExportFilename(detail.identifier)]: strToU8(markdown),
        };
        for (const { name, bytes } of packed) {
          files[`attachments/${name}`] = bytes;
        }
        const zipped = zipSync(files);
        triggerDownload(
          new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" }),
          zipName,
        );
      } else {
        triggerDownload(
          new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
          issueExportFilename(detail.identifier),
        );
      }

      toast.success(t(($) => $.actions.export_success, { identifier: detail.identifier }));
    } catch {
      toast.error(t(($) => $.actions.export_failed));
    } finally {
      setExporting(false);
    }
  }, [issue, exporting, wsId, qc, statusLabel, getActorName, paths, navigation, t]);

  return { exportIssue, exporting };
}
