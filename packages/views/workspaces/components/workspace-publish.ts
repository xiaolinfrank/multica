"use client";

/**
 * Publish a persistent-agent-workspace file to its issue as a deliverable
 * (MUL-7649). The daemon's bytes reach the platform in one direction only — a
 * download op — so publishing is: fetch the file (≤ 10 MiB, the download-op
 * cap), upload it as an issue attachment, then post it in a comment. The
 * comment step is what makes it a deliverable: an attachment bound to the
 * issue alone is a description attachment, which the deliverables model
 * treats as an input and never lists.
 *
 * Reuses the existing comment-creation mutation so the issue timeline cache
 * is patched the same way a hand-written comment would be — which is also how
 * the deliverables sidebar section notices the new file.
 */

import { useCallback, useState } from "react";
import { api } from "@multica/core/api";
import { useCreateComment } from "@multica/core/issues/mutations";
import { base64ToBlob } from "./workspace-download";

export type PublishOutcome = "ok" | "too_large" | "error";

export interface WorkspacePublishTarget {
  issueId: string;
  /** Origin named in the comment body — the agent whose workspace this is. */
  agentLabel: string;
}

export function useWorkspaceFilePublish(
  wsId: string,
  taskShort: string,
  target: { issueId: string; commentBody: string } | null,
) {
  const [publishingPath, setPublishingPath] = useState<string | null>(null);
  const createComment = useCreateComment(target?.issueId ?? "");

  const publish = useCallback(
    async (path: string): Promise<PublishOutcome | null> => {
      if (!target) return null;
      setPublishingPath(path);
      try {
        const outcome = await api.downloadWorkspaceFile(wsId, taskShort, path);
        if (outcome.status !== "completed") return "error";
        if (outcome.data.too_large) return "too_large";
        const filename = path.split("/").pop() || "deliverable";
        const blob = base64ToBlob(outcome.data.content, outcome.data.mime);
        const file = new File([blob], filename, {
          type: outcome.data.mime || "application/octet-stream",
        });
        const attachment = await api.uploadFile(file, { issueId: target.issueId });
        await createComment.mutateAsync({
          content: target.commentBody,
          attachmentIds: [attachment.id],
        });
        return "ok";
      } catch {
        return "error";
      } finally {
        setPublishingPath(null);
      }
    },
    [wsId, taskShort, target, createComment],
  );

  return { publish, publishingPath };
}
