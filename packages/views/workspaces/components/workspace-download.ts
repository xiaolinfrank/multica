"use client";

/**
 * Imperative file download for a persistent agent workspace.
 *
 * The server can't read the daemon's (NAS-backed) disk, so a download is the
 * same heartbeat-relayed RPC as the rest of the file ops: fetch the file's full
 * bytes (base64) via `downloadWorkspaceFile`, decode to a Blob, and trigger a
 * "Save As". Used by the preview pane's Download button and the tree's per-file
 * hover action.
 */

import { useCallback, useState } from "react";
import { api } from "@multica/core/api";

/** Decode a base64 payload into a typed Blob. */
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || "application/octet-stream" });
}

/** Trigger a browser "Save As" for a Blob under the given filename. */
export function saveBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has started the download first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export type DownloadOutcome = "ok" | "too_large" | "error";

/**
 * Hook returning an async `download(path)` plus the in-flight path so a button
 * or tree row can show a spinner. The outcome is a discriminated result the
 * caller turns into a translated toast — the hook stays i18n-free.
 */
export function useWorkspaceFileDownload(wsId: string, taskShort: string) {
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);

  const download = useCallback(
    async (path: string): Promise<DownloadOutcome> => {
      setDownloadingPath(path);
      try {
        const outcome = await api.downloadWorkspaceFile(wsId, taskShort, path);
        if (outcome.status !== "completed") return "error";
        if (outcome.data.too_large) return "too_large";
        const filename = path.split("/").pop() || "download";
        saveBlob(base64ToBlob(outcome.data.content, outcome.data.mime), filename);
        return "ok";
      } catch {
        return "error";
      } finally {
        setDownloadingPath(null);
      }
    },
    [wsId, taskShort],
  );

  return { download, downloadingPath };
}
