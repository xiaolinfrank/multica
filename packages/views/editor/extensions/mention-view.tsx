"use client";

/**
 * MentionView — NodeView for rendering @mentions inline in the editor.
 *
 * Member/agent mentions: plain "@Name" text with .mention class styling.
 * Issue/project mentions render the same navigable chips as readonly content
 * (IssueMentionCard / ProjectMentionCard), so click behavior — plain click,
 * modifier click, middle click — cannot drift between an editing and a
 * readonly surface. The editor's ProseMirror click handler skips anything
 * inside `[data-node-view-wrapper]`, so the AppLink inside the card owns the
 * click alone.
 *
 * Issue chip sizing: must fit within the paragraph line box (14px * 1.625 =
 * 22.75px). Card is text-caption (12px) + py-0.5 + border ≈ 22px total. The
 * `vertical-align: middle` rule on `[data-node-view-wrapper]` in CSS handles
 * line-box alignment; setting it on an inner element has no effect because
 * the wrapper is the outermost inline element.
 */

import { useState } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { File, ExternalLink, Download, Copy } from "lucide-react";
import { useWorkspaceId } from "@multica/core/hooks";
import { api } from "@multica/core/api";
import { toast } from "sonner";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@multica/ui/components/ui/popover";
import { IssueMentionCard } from "../../issues/components/issue-mention-card";
import { ProjectMentionCard } from "../../projects/components/project-mention-card";
import { getPreviewKind } from "../utils/preview";

export function MentionView({ node }: NodeViewProps) {
  const { type, id, label } = node.attrs;

  // stopPropagation mirrors the readonly renderer's mention wrappers: a chip
  // click must not reach surrounding click handlers.
  if (type === "issue") {
    return (
      <NodeViewWrapper
        as="span"
        className="inline"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <IssueMentionCard issueId={id} fallbackLabel={label} />
      </NodeViewWrapper>
    );
  }

  if (type === "project") {
    return (
      <NodeViewWrapper
        as="span"
        className="inline"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <ProjectMentionCard projectId={id} fallbackLabel={label} />
      </NodeViewWrapper>
    );
  }

  if (type === "file") {
    return <FileMentionChip id={id} label={label ?? id} />;
  }

  return (
    <NodeViewWrapper as="span" className="inline">
      <span className="mention">@{label ?? id}</span>
    </NodeViewWrapper>
  );
}

/**
 * FileMentionChip — clickable chip for @file mentions.
 *
 * The chip opens a small popover with context actions. Previewability is
 * derived from the filename (the mention label persists the filename through
 * markdown round-trips, so it stays correct after a reload), mirroring the
 * server's isTextPreviewable / getPreviewKind whitelist:
 *   - previewable  → "打开" (Open) + "下载" (Download) + "复制路径" (Copy path)
 *   - not previewable (e.g. .docx) → "下载" + "复制路径" only
 *
 * "打开" streams the file into a new tab: text-like files go through the
 * /content proxy (which needs the workspace to scope the attachment ACL),
 * while media (image/pdf/video/audio) preview inline via /download (which
 * keeps media inline unless dl=1 is passed). "下载" forces a save via
 * /download?dl=1 for every type. "复制路径" copies the on-disk file_path
 * (LocalStorage/NAS deployments — so a person can paste it into a terminal or
 * into another issue for an agent to Read directly), falling back to the
 * stable /download URL on object-storage deployments (S3/R2/MinIO) or when
 * the lookup fails.
 */
function FileMentionChip({ id, label }: { id: string; label: string }) {
  const [open, setOpen] = useState(false);
  const workspaceId = useWorkspaceId();

  const kind = getPreviewKind("", label);
  const previewable = kind !== null;

  const wsParam = workspaceId
    ? `?workspace_id=${encodeURIComponent(workspaceId)}`
    : "";
  const openHref = previewable
    ? kind === "image" || kind === "pdf" || kind === "video" || kind === "audio"
      ? `/api/attachments/${id}/download`
      : `/api/attachments/${id}/content${wsParam}`
    : null;
  const downloadHref = `/api/attachments/${id}/download?dl=1`;
  const copyPath = `/api/attachments/${id}/download`;

  const handleCopy = async () => {
    // Prefer the on-disk absolute path (LocalStorage / NAS deployments expose
    // file_path; a person pastes it into a terminal or another issue for an
    // agent to Read directly). Fall back to the stable download URL on
    // object-storage deployments (S3/R2/MinIO expose no path) or on lookup
    // failure — same value the chip used before this path-aware version.
    let target = copyPath;
    try {
      const att = await api.getAttachment(id);
      if (att.file_path) target = att.file_path;
    } catch {
      // keep the download-URL fallback
    }
    try {
      await navigator.clipboard.writeText(target);
      toast.success("文件路径已复制");
    } catch {
      toast.error("复制失败");
    }
    setOpen(false);
  };

  const actions: Array<{
    key: string;
    label: string;
    icon: typeof File;
    href?: string | null;
    onClick?: () => void;
  }> = [];
  if (previewable && openHref) {
    actions.push({ key: "open", label: "打开", icon: ExternalLink, href: openHref });
  }
  actions.push({ key: "download", label: "下载", icon: Download, href: downloadHref });
  actions.push({ key: "copy", label: "复制路径", icon: Copy, onClick: handleCopy });

  return (
    <NodeViewWrapper as="span" className="inline">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          className="file-mention align-middle inline-flex items-center gap-1 rounded border border-border bg-muted px-1 py-0.5 text-caption hover:bg-accent"
          onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
        >
          <File className="h-3 w-3" />
          <span>@{label}</span>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          sideOffset={6}
          align="start"
          className="w-auto min-w-32 gap-0.5 p-1"
          initialFocus={false}
          finalFocus={false}
        >
          {actions.map((a) => (
            <a
              key={a.key}
              role="button"
              tabIndex={0}
              href={a.href ?? undefined}
              target={a.href ? "_blank" : undefined}
              rel={a.href ? "noreferrer" : undefined}
              title={a.label}
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation();
                if (a.onClick) {
                  e.preventDefault();
                  a.onClick();
                } else {
                  setOpen(false);
                }
              }}
              onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-caption outline-hidden select-none hover:bg-accent hover:text-accent-foreground"
            >
              <a.icon className="size-3.5" />
              {a.label}
            </a>
          ))}
        </PopoverContent>
      </Popover>
    </NodeViewWrapper>
  );
}
