/**
 * On-demand file operations against a persistent agent workspace. The server
 * can't read the daemon's (NAS-backed) disk directly, so these run as async
 * RPCs: the client initiates an op, the daemon executes it sandboxed to the
 * workspace and reports back, and the client polls the request until terminal.
 */

export type WorkspaceOpStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout";

/** One node in a workspace file tree. */
export interface WorkspaceFileEntry {
  /** Path relative to the workspace root, forward-slash separated. */
  path: string;
  size: number;
  is_dir: boolean;
  /**
   * "repo" (a collapsed git checkout) or "artifact" (a collapsed regenerable
   * dir like node_modules) — both are shown as a single non-browsable node —
   * or "" for a normal file/directory.
   */
  kind: "" | "repo" | "artifact" | string;
}

export interface WorkspaceTreeResult {
  entries: WorkspaceFileEntry[];
  truncated: boolean;
}

export interface WorkspaceReadResult {
  path: string;
  size: number;
  /** False for binary files — the UI offers a download instead of a preview. */
  is_text: boolean;
  content: string;
  truncated: boolean;
}

export interface WorkspaceReclaimResult {
  mode: string;
  reclaimed_bytes: number;
  removed: string[];
}

/**
 * A file's full bytes for download or inline image preview. Unlike a read
 * (text-only, 2 MiB preview cap), this returns the raw bytes base64-encoded up
 * to a larger cap plus a sniffed MIME type, so binaries — images especially —
 * can be rendered or saved. `too_large` is set (with no `content`) when the
 * file exceeds the cap; a truncated binary would be useless.
 */
export interface WorkspaceDownloadResult {
  path: string;
  size: number;
  mime: string;
  /** "base64" when `content` is populated. */
  encoding: string;
  /** base64 of the file bytes, empty when `too_large`. */
  content: string;
  is_image: boolean;
  too_large: boolean;
}

/** The polled request envelope. `result` is the op-specific payload above. */
export interface WorkspaceOpRequest {
  id: string;
  status: WorkspaceOpStatus | string;
  op: string;
  error?: string;
  result?: unknown;
}
