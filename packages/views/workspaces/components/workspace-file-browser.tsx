"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  workspaceTreeOptions,
  workspaceFileOptions,
} from "@multica/core/workspace";
import type { WorkspaceFileEntry } from "@multica/core/types";
import {
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderGit2,
  Package,
} from "lucide-react";
import { cn } from "@multica/ui/lib/utils";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@multica/ui/components/ui/dialog";
import { ScrollArea } from "@multica/ui/components/ui/scroll-area";
import { CodeBlockStatic } from "../../editor/code-block-static";
import { useT } from "../../i18n";

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

// Minimal extension → lowlight language hint. Unknowns fall back to auto-detect
// (CodeBlockStatic passes undefined through to highlightAuto).
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby",
  sh: "bash",
  bash: "bash",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  md: "markdown",
  html: "xml",
  css: "css",
  sql: "sql",
};

function langForPath(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext];
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
// Browser
// ---------------------------------------------------------------------------

export function WorkspaceFileBrowser({
  wsId,
  taskShort,
}: {
  wsId: string;
  taskShort: string;
}) {
  const { t } = useT("workspaces");
  const [selected, setSelected] = useState<TreeNode | null>(null);

  const { data, isLoading, isError } = useQuery(
    workspaceTreeOptions(wsId, taskShort, true),
  );

  const nodes = useMemo(() => buildNodes(data?.data.entries ?? []), [data]);

  if (isLoading) {
    return (
      <div className="space-y-1.5 py-1">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
      </div>
    );
  }
  if (isError || (data && data.status !== "completed")) {
    return (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        {data?.error || t(($) => $.browser.unreachable)}
      </p>
    );
  }
  if (nodes.length === 0) {
    return (
      <p className="px-2 py-3 text-xs text-muted-foreground">
        {t(($) => $.browser.empty)}
      </p>
    );
  }

  return (
    <>
      <div className="max-h-80 overflow-y-auto py-1">
        {nodes.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selected?.path ?? ""}
            onSelectFile={setSelected}
          />
        ))}
        {data?.data.truncated ? (
          <p className="px-2 pt-2 text-[11px] text-muted-foreground">
            {t(($) => $.browser.truncated)}
          </p>
        ) : null}
      </div>
      {selected && !selected.isDir ? (
        <FileViewerDialog
          wsId={wsId}
          taskShort={taskShort}
          node={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function TreeRow({
  node,
  depth,
  selectedPath,
  onSelectFile,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string;
  onSelectFile: (n: TreeNode) => void;
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
            "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-accent/60",
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
          <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
          {collapsed ? (
            <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
              {t(($) =>
                node.kind === "repo" ? $.browser.repo : $.browser.artifact,
              )}
            </span>
          ) : null}
          {node.size > 0 ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">
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
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelectFile(node)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs hover:bg-accent/60",
        node.path === selectedPath && "bg-accent",
      )}
      style={pad}
    >
      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono">{node.name}</span>
      {node.size > 0 ? (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatBytes(node.size)}
        </span>
      ) : null}
    </button>
  );
}

function FileViewerDialog({
  wsId,
  taskShort,
  node,
  onClose,
}: {
  wsId: string;
  taskShort: string;
  node: TreeNode;
  onClose: () => void;
}) {
  const { t } = useT("workspaces");
  const { data, isLoading, isError } = useQuery(
    workspaceFileOptions(wsId, taskShort, node.path),
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate font-mono text-sm">{node.path}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Spinner />
          </div>
        ) : isError || (data && data.status !== "completed") ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {data?.error || t(($) => $.browser.read_failed)}
          </p>
        ) : !data?.data.is_text ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t(($) => $.browser.binary, { size: formatBytes(data?.data.size ?? 0) })}
          </p>
        ) : (
          <div className="space-y-2">
            {data.data.truncated ? (
              <p className="text-[11px] text-warning">
                {t(($) => $.browser.file_truncated)}
              </p>
            ) : null}
            <ScrollArea className="max-h-[60vh] rounded-md border border-border">
              <CodeBlockStatic
                language={langForPath(node.path)}
                body={data.data.content}
                className="p-3"
              />
            </ScrollArea>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
