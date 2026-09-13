import type { Attachment, Issue, TimelineEntry } from "@multica/core/types";

/**
 * Builds the Markdown handoff document for a single issue export.
 *
 * The output targets a local AI agent (Claude Code, Codex, Cursor, …), not a
 * human reader's eye: a YAML front matter block for machine-readable identity,
 * then every section the platform knows about the task at export time —
 * properties, the description verbatim (it is already Markdown), the full
 * comment/activity timeline, sub-issues, and attachments with their durable
 * download URLs. Pure string assembly so the whole matrix is testable under
 * a node vitest environment with no DOM.
 */
export interface IssueExportInput {
  issue: Issue;
  /** Server-ordered timeline (comments + activities). Rendered as given. */
  timeline: TimelineEntry[];
  /** Attachments uploaded against the issue itself (not comment attachments). */
  attachments: Attachment[];
  childIssues: Issue[];
  /** Localized display label for `issue.status`, resolved by the caller. */
  statusLabel: string;
  assigneeName?: string;
  creatorName?: string;
  parentIdentifier?: string;
  projectName?: string;
  /** Shareable absolute URL of the issue. */
  url: string;
  /** ISO timestamp of the export moment. */
  exportedAt: string;
}

/** `MUL-123` → `MUL-123.md`; falls back when an identifier is missing. */
export function issueExportFilename(identifier: string | undefined): string {
  return `${identifier || "issue"}.md`;
}

function formatBytes(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined || !Number.isFinite(sizeBytes)) return "unknown size";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = sizeBytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
}

/**
 * YAML scalar via JSON.stringify — JSON is a YAML subset, so this keeps
 * quotes, backslashes and newlines correct in the front matter.
 */
function yaml(value: string): string {
  return JSON.stringify(value);
}

function actorLabel(entry: TimelineEntry): string {
  const name = entry.actor_name?.trim();
  const who = name || entry.actor_id || "unknown";
  return entry.actor_type ? `${who} (${entry.actor_type})` : who;
}

function attachmentLine(a: Attachment): string {
  // `markdown_url` is the server's contract for URLs embedded in markdown
  // bodies that outlive the session (MUL-3192); `url` is the raw fallback.
  const href = a.markdown_url || a.url;
  return `- [${a.filename}](${href}) (${formatBytes(a.size_bytes)})`;
}

// A short English phrase per known activity action. Anything unmapped keeps
// the raw action key plus its details payload — still machine-readable.
const ACTIVITY_PHRASES: Record<string, string> = {
  created: "created the task",
  status_changed: "changed the status",
  assignee_changed: "changed the assignee",
  priority_changed: "changed the priority",
  title_updated: "renamed the task",
  description_updated: "edited the description",
  labels_changed: "changed the labels",
  project_changed: "changed the project",
  moved: "moved the task",
  archived: "archived the task",
};

function renderEntry(entry: TimelineEntry): string {
  const when = entry.created_at;
  const who = actorLabel(entry);
  if (entry.type === "comment") {
    const kind = entry.parent_id ? "reply" : entry.comment_type || "comment";
    const resolved = entry.resolved_at ? " · resolved" : "";
    const lines: string[] = [`#### ${when} · ${who} · ${kind}${resolved}`, ""];
    const content = (entry.content || "").trim();
    if (content) lines.push(content, "");
    for (const reaction of entry.reactions ?? []) {
      lines.push(`- reaction: ${reaction.emoji}`);
    }
    for (const a of entry.attachments ?? []) {
      lines.push(attachmentLine(a));
    }
    return lines.join("\n");
  }
  const phrase = ACTIVITY_PHRASES[entry.action ?? ""] ?? `activity: ${entry.action ?? "unknown"}`;
  const lines = [`#### ${when} · ${who} · ${phrase}`];
  if (entry.details && Object.keys(entry.details).length > 0) {
    lines.push("", "```json", JSON.stringify(entry.details, null, 2), "```");
  }
  return lines.join("\n");
}

function renderTimeline(timeline: TimelineEntry[]): string | null {
  if (timeline.length === 0) return null;
  // The timeline query returns server order (ascending). Top-level entries
  // and replies are interleaved as given; the `reply` marker in each heading
  // plus original order is enough for an agent to reconstruct threads.
  return timeline.map(renderEntry).join("\n\n");
}

function renderSubIssues(children: Issue[], statusLabel: (key: string) => string): string | null {
  if (children.length === 0) return null;
  return children
    .map((child) => `- ${child.identifier ?? child.id} — ${child.title} [${statusLabel(child.status)}]`)
    .join("\n");
}

function renderAttachments(attachments: Attachment[]): string | null {
  if (attachments.length === 0) return null;
  return attachments.map(attachmentLine).join("\n");
}

export function buildIssueExportMarkdown(input: IssueExportInput): string {
  const { issue } = input;
  const labels = issue.labels?.map((label) => label.name).join(", ");
  const out: string[] = [];

  out.push("---");
  out.push(`multica_export: ${yaml("issue")}`);
  out.push(`identifier: ${yaml(issue.identifier ?? "")}`);
  out.push(`title: ${yaml(issue.title)}`);
  out.push(`status: ${yaml(issue.status)}`);
  out.push(`priority: ${yaml(issue.priority)}`);
  out.push(`url: ${yaml(input.url)}`);
  out.push(`exported_at: ${yaml(input.exportedAt)}`);
  out.push("---");
  out.push("");
  out.push(`# ${issue.identifier ?? issue.id} — ${issue.title}`);
  out.push("");
  out.push(
    [
      `> Exported from Multica at ${input.exportedAt}. This file is a complete,`,
      "self-contained snapshot of the task above, generated for handoff to any",
      "local AI agent (Claude Code, Codex, Cursor, …). The sections below are",
      "the full platform record: properties, the description (Markdown,",
      "verbatim), the complete comment and activity timeline in original order,",
      "sub-issues, and attachments with their durable download URLs. Continue",
      "the work from the latest state in the timeline; treat the timeline as",
      "the authoritative history.",
    ].join("\n> "),
  );
  out.push("");

  out.push("## Properties", "");
  out.push(`- **Status**: ${input.statusLabel}`);
  out.push(`- **Priority**: ${issue.priority}`);
  out.push(
    `- **Assignee**: ${
      input.assigneeName && issue.assignee_type
        ? `${input.assigneeName} (${issue.assignee_type})`
        : "Unassigned"
    }`,
  );
  if (input.creatorName) {
    out.push(`- **Creator**: ${input.creatorName} (${issue.creator_type})`);
  }
  if (issue.start_date) out.push(`- **Start date**: ${issue.start_date}`);
  if (issue.due_date) out.push(`- **Due date**: ${issue.due_date}`);
  if (input.projectName) out.push(`- **Project**: ${input.projectName}`);
  if (input.parentIdentifier) out.push(`- **Parent**: ${input.parentIdentifier}`);
  if (labels) out.push(`- **Labels**: ${labels}`);
  out.push(`- **Created**: ${issue.created_at}`);
  out.push(`- **Updated**: ${issue.updated_at}`);
  out.push("");

  if (issue.description && issue.description.trim().length > 0) {
    out.push("## Description", "", issue.description, "");
  }

  const timeline = renderTimeline(input.timeline);
  if (timeline) {
    out.push("## Timeline", "", timeline, "");
  }

  const subIssues = renderSubIssues(input.childIssues, (key) => key);
  if (subIssues) {
    out.push("## Sub-issues", "", subIssues, "");
  }

  const attachments = renderAttachments(input.attachments);
  if (attachments) {
    out.push("## Attachments", "", attachments, "");
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
