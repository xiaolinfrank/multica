"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  workspaceTreeOptions,
  workspaceFileOptions,
  workspaceDownloadOptions,
} from "@multica/core/workspace";
import type {
  WorkspaceFileEntry,
  WorkspaceReadResult,
  WorkspaceDownloadResult,
} from "@multica/core/types";
import {
  ChevronRight,
  File as FileIcon,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderGit2,
  Package,
  Download,
  Copy,
  Check,
  WrapText,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@multica/ui/lib/utils";
import { copyText } from "@multica/ui/lib/clipboard";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { getPreviewKind, extensionToLanguage } from "../../editor/utils/preview";
import { useT } from "../../i18n";
import { WorkspaceCodeView } from "./workspace-code-view";
import { useWorkspaceFileDownload, type DownloadOutcome } from "./workspace-download";

/** Human-readable byte size (binary units). */
function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const CODE_EXTS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "go", "py", "rb", "rs", "java",
  "c", "cc", "cpp", "h", "hpp", "cs", "php", "lua", "sh", "bash", "zsh",
  "sql", "css", "scss", "less", "html", "htm", "xml", "yaml", "yml", "toml",
]);

/** Pick a lucide icon for a file by preview kind + extension. */
function FileTypeIcon({ path, className }: { path: string; className?: string }) {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const kind = getPreviewKind("", path);
  let Icon = FileIcon;
  if (kind === "image") Icon = FileImage;
  else if (ext === "json") Icon = FileJson;
  else if (CODE_EXTS.has(ext)) Icon = FileCode;
  else if (kind === "markdown" || ext === "txt" || ext === "log" || ext === "csv") {
    Icon = FileText;
  }
  return <Icon className={className} />;
}

// ---------------------------------------------------------------------------
// Tree model
// ---------------------------------------------------------------------------

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  /** "repo" | "artifact" | "" — collapsed regenerable dirs aren't browsable. */
  kind: string;
  size: number;
  children: TreeNode[];
}

/**
 * Builds a nested tree from the daemon's flat entry list. The daemon emits an
 * entry for every directory (collapsed repo/artifact dirs included) and file,
 * so intermediate nodes are normally present; we still synthesize any missing
 * parent defensively.
 */
function buildNodes(entries: WorkspaceFileEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  const ensure = (path: string, isDir: boolean): TreeNode => {
    const existing = byPath.get(path);
    if (existing) return existing;
    const name = path.split("/").pop() ?? path;
    const node: TreeNode = { name, path, isDir, kind: "", size: 0, children: [] };
    byPath.set(path, node);
    const slash = path.lastIndexOf("/");
    if (slash === -1) {
      roots.push(node);
    } else {
      const parent = ensure(path.slice(0, slash), true);
      parent.isDir = true;
      parent.children.push(node);
    }
    return node;
  };

  for (const e of entries) {
    const node = ensure(e.path, e.is_dir);
    node.isDir = e.is_dir;
    node.kind = e.kind;
    node.size = e.size;
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
    );
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(roots);
  return roots;
}

// ---------------------------------------------------------------------------
// Explorer — two panes: tree (left) + preview (right)
// ---------------------------------------------------------------------------

export function WorkspaceFileExplorer({
  wsId,
  taskShort,
}: {
  wsId: string;
  taskShort: string;
}) {
  const { t } = useT("workspaces");
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const { download, downloadingPath } = useWorkspaceFileDownload(wsId, taskShort);

  const { data, isLoading, isError } = useQuery(
    workspaceTreeOptions(wsId, taskShort, true),
  );

  const nodes = useMemo(() => buildNodes(data?.data.entries ?? []), [data]);

  const handleDownload = async (path: string) => {
    const outcome: DownloadOutcome = await download(path);
    if (outcome === "too_large") toast.error(t(($) => $.browser.download_too_large));
    else if (outcome === "error") toast.error(t(($) => $.browser.download_failed));
  };

  let tree: React.ReactNode;
  if (isLoading) {
    tree = (
      <div className="space-y-1.5 p-2">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  } else if (isError || (data && data.status !== "completed")) {
    tree = (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        {data?.error || t(($) => $.browser.unreachable)}
      </p>
    );
  } else if (nodes.length === 0) {
    tree = (
      <p className="px-3 py-4 text-xs text-muted-foreground">
        {t(($) => $.browser.empty)}
      </p>
    );
  } else {
    tree = (
      <div className="w-max min-w-full py-1">
        {nodes.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selected?.path ?? ""}
            onSelectFile={setSelected}
            onDownload={handleDownload}
            downloadingPath={downloadingPath}
          />
        ))}
        {data?.data.truncated ? (
          <p className="px-3 pt-2 text-[11px] text-muted-foreground">
            {t(($) => $.browser.truncated)}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="w-64 shrink-0 overflow-auto border-r border-border bg-muted/20">
        {tree}
      </div>
      <div className="min-w-0 flex-1">
        {selected ? (
          <PreviewPane
            wsId={wsId}
            taskShort={taskShort}
            node={selected}
            onDownload={handleDownload}
            downloading={downloadingPath === selected.path}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t(($) => $.browser.select_hint)}
          </div>
        )}
      </div>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  selectedPath,
  onSelectFile,
  onDownload,
  downloadingPath,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string;
  onSelectFile: (n: TreeNode) => void;
  onDownload: (path: string) => void;
  downloadingPath: string | null;
}) {
  const { t } = useT("workspaces");
  const [open, setOpen] = useState(true);
  const collapsed = node.kind === "repo" || node.kind === "artifact";
  const pad = { paddingLeft: `${depth * 14 + 8}px` };

  if (node.isDir) {
    return (
      <div>
        <button
          type="button"
          onClick={() => !collapsed && setOpen(!open)}
          className={cn(
            "flex w-full items-center gap-1.5 whitespace-nowrap px-2 py-1 text-left text-xs hover:bg-accent/60",
            collapsed && "cursor-default hover:bg-transparent",
          )}
          style={pad}
        >
          {collapsed ? (
            node.kind === "repo" ? (
              <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <Package className="size-3.5 shrink-0 text-muted-foreground" />
            )
          ) : (
            <>
              <ChevronRight
                className={cn(
                  "size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform",
                  open && "rotate-90",
                )}
              />
              <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            </>
          )}
          <span className="font-mono">{node.name}</span>
          {collapsed ? (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
              {t(($) =>
                node.kind === "repo" ? $.browser.repo : $.browser.artifact,
              )}
            </span>
          ) : null}
          {node.size > 0 ? (
            <span className="ml-2 shrink-0 tabular-nums text-muted-foreground">
              {formatBytes(node.size)}
            </span>
          ) : null}
        </button>
        {!collapsed && open ? (
          <div>
            {node.children.map((child) => (
              <TreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelectFile={onSelectFile}
                onDownload={onDownload}
                downloadingPath={downloadingPath}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const downloading = downloadingPath === node.path;
  return (
    <div
      className={cn(
        "group flex w-full items-center gap-1.5 whitespace-nowrap px-2 py-1 text-xs hover:bg-accent/60",
        node.path === selectedPath && "bg-accent",
      )}
      style={pad}
    >
      <button
        type="button"
        onClick={() => onSelectFile(node)}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <FileTypeIcon path={node.path} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono">{node.name}</span>
      </button>
      {node.size > 0 ? (
        <span className="ml-2 shrink-0 tabular-nums text-muted-foreground">
          {formatBytes(node.size)}
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => onDownload(node.path)}
        disabled={downloading}
        aria-label={t(($) => $.browser.download)}
        title={t(($) => $.browser.download)}
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 disabled:opacity-50"
      >
        {downloading ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Download className="size-3" />
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview pane
// ---------------------------------------------------------------------------

type ReadOutcome = { status: string; error?: string; data: WorkspaceReadResult };
type DownloadResultOutcome = { status: string; error?: string; data: WorkspaceDownloadResult };

function PreviewPane({
  wsId,
  taskShort,
  node,
  onDownload,
  downloading,
}: {
  wsId: string;
  taskShort: string;
  node: TreeNode;
  onDownload: (path: string) => void;
  downloading: boolean;
}) {
  const { t } = useT("workspaces");
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);

  const isImage = getPreviewKind("", node.path) === "image";

  // Exactly one of these queries is enabled (the other gets an empty path,
  // which disables it) so both hooks run unconditionally per the rules of hooks.
  const fileQuery = useQuery(
    workspaceFileOptions(wsId, taskShort, isImage ? "" : node.path),
  );
  const imageQuery = useQuery(
    workspaceDownloadOptions(wsId, taskShort, node.path, isImage),
  );

  const isText = !isImage && fileQuery.data?.data.is_text === true;

  const handleCopy = async () => {
    const ok = await copyText(fileQuery.data?.data.content ?? "");
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <FileTypeIcon path={node.path} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs" title={node.path}>
          {node.path}
        </span>
        {node.size > 0 ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatBytes(node.size)}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {isText ? (
            <>
              <PaneAction
                label={wrap ? t(($) => $.browser.nowrap) : t(($) => $.browser.wrap)}
                active={wrap}
                onClick={() => setWrap((w) => !w)}
              >
                <WrapText className="size-3.5" />
              </PaneAction>
              <PaneAction label={t(($) => $.browser.copy)} onClick={handleCopy}>
                {copied ? (
                  <Check className="size-3.5 text-success" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </PaneAction>
            </>
          ) : null}
          <PaneAction
            label={t(($) => $.browser.download)}
            disabled={downloading}
            onClick={() => onDownload(node.path)}
          >
            {downloading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
          </PaneAction>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {isImage ? (
          <ImagePreview
            loading={imageQuery.isLoading}
            isError={imageQuery.isError}
            outcome={imageQuery.data}
            node={node}
            onDownload={onDownload}
          />
        ) : (
          <TextPreview
            loading={fileQuery.isLoading}
            isError={fileQuery.isError}
            outcome={fileQuery.data}
            node={node}
            wrap={wrap}
            onDownload={onDownload}
          />
        )}
      </div>
    </div>
  );
}

function PaneAction({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50",
        active && "bg-accent text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function BinaryFallback({
  message,
  onDownload,
  path,
}: {
  message: string;
  onDownload: (path: string) => void;
  path: string;
}) {
  const { t } = useT("workspaces");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FileIcon className="size-8 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{message}</p>
      <button
        type="button"
        onClick={() => onDownload(path)}
        className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm transition-colors hover:bg-accent"
      >
        <Download className="size-4" />
        {t(($) => $.browser.download)}
      </button>
    </div>
  );
}

function TextPreview({
  loading,
  isError,
  outcome,
  node,
  wrap,
  onDownload,
}: {
  loading: boolean;
  isError: boolean;
  outcome: ReadOutcome | undefined;
  node: TreeNode;
  wrap: boolean;
  onDownload: (path: string) => void;
}) {
  const { t } = useT("workspaces");

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (isError || !outcome || outcome.status !== "completed") {
    return <CenteredMessage>{outcome?.error || t(($) => $.browser.read_failed)}</CenteredMessage>;
  }
  if (!outcome.data.is_text) {
    return (
      <BinaryFallback
        message={t(($) => $.browser.binary, { size: formatBytes(outcome.data.size) })}
        onDownload={onDownload}
        path={node.path}
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {outcome.data.truncated ? (
        <p className="shrink-0 border-b border-border bg-warning/10 px-3 py-1 text-[11px] text-warning">
          {t(($) => $.browser.file_truncated)}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <WorkspaceCodeView
          content={outcome.data.content}
          language={extensionToLanguage(node.path)}
          wrap={wrap}
        />
      </div>
    </div>
  );
}

function ImagePreview({
  loading,
  isError,
  outcome,
  node,
  onDownload,
}: {
  loading: boolean;
  isError: boolean;
  outcome: DownloadResultOutcome | undefined;
  node: TreeNode;
  onDownload: (path: string) => void;
}) {
  const { t } = useT("workspaces");

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (isError || !outcome || outcome.status !== "completed") {
    return <CenteredMessage>{outcome?.error || t(($) => $.browser.read_failed)}</CenteredMessage>;
  }
  if (outcome.data.too_large || !outcome.data.content) {
    return (
      <BinaryFallback
        message={t(($) => $.browser.image_too_large, { size: formatBytes(outcome.data.size) })}
        onDownload={onDownload}
        path={node.path}
      />
    );
  }
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-muted/20 p-4">
      <img
        src={`data:${outcome.data.mime};base64,${outcome.data.content}`}
        alt={node.name}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dialog wrapper — used by the management page and the issue files section
// ---------------------------------------------------------------------------

export function WorkspaceExplorerDialog({
  wsId,
  taskShort,
  label,
  open,
  onOpenChange,
}: {
  wsId: string;
  taskShort: string;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(82vh,720px)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3 pr-12">
          <DialogTitle className="truncate text-sm">{label}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          <WorkspaceFileExplorer wsId={wsId} taskShort={taskShort} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
