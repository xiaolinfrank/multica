import type {
  AgentTask,
  Attachment,
  TaskMessagePayload,
  GitHubPullRequest,
  Issue,
  IssueProperty,
  IssuePropertyValue,
  IssueSubscriber,
  TimelineEntry,
} from "@multica/core/types";

/**
 * Builds the Markdown handoff document for a single issue export.
 *
 * The output targets a local AI agent (Claude Code, Codex, Cursor, …), not a
 * human reader's eye: a YAML front matter block for machine-readable identity,
 * then every section the platform knows about the task at export time —
 * properties (built-in and workspace-custom), the description verbatim (it is
 * already Markdown), the full comment/activity timeline, the agent-run
 * history, the parent/sub-issue tree, pull requests, and attachments. Pure
 * string assembly so the whole matrix is testable under a node vitest
 * environment with no DOM.
 *
 * When attachments are exported, the caller packs their bytes next to this
 * file (`attachments/<name>`) and passes back each attachment's packed name;
 * attachment URLs inside the description and comments are then rewritten to
 * those local paths so the document is self-contained offline. Attachments
 * that failed to download keep an absolute platform URL instead.
 */
export interface ExportChildIssue {
  issue: Issue;
  statusLabel: string;
  assigneeName?: string;
  children: ExportChildIssue[];
}

export interface ExportedAttachment {
  attachment: Attachment;
  /** Zip-relative path (`attachments/<name>`) when the bytes were packed. */
  packedName?: string;
  /** Absolute URL used in the document when the bytes were NOT packed. */
  absoluteUrl: string;
}

/**
 * One file pulled from an issue's persistent agent workspace — the daemon-held
 * working directory of an (agent, issue) pair. Only plain files come over:
 * repo checkouts and regenerable artifacts are collapsed tree nodes the file
 * API cannot download individually.
 */
export interface ExportedWorkspaceFile {
  /** Path relative to the workspace root, as the daemon reported it. */
  path: string;
  sizeBytes?: number;
  /** Zip-relative path (`workspace/<taskShort>/<path>`) when packed. */
  packedName?: string;
  /** Why the bytes are absent: "too_large" | "size_cap" | "unavailable". */
  skippedReason?: string;
}

export interface ExportedWorkspace {
  /** First 8 chars of the owning task UUID — the on-disk directory name. */
  taskShort: string;
  agentName?: string;
  /** Fleet node that physically holds the workspace. */
  deviceName?: string;
  files: ExportedWorkspaceFile[];
  /** The daemon's tree listing itself was truncated. */
  treeTruncated?: boolean;
  /** Plain files beyond the export-side per-workspace cap; not listed. */
  fileCapDropped?: number;
  /** Set when the workspace could not be reached at all (daemon offline). */
  error?: string;
}

/** One agent run's execution transcript (message stream), exported under executions/. */
export interface ExportedExecution {
  run: AgentTask;
  /** Zip-relative path (executions/<file>.md) when the transcript was packed. */
  packedName?: string;
  /** Set when the transcript could not be fetched or hit the bundle size cap. */
  error?: string;
}

export interface IssueExportInput {
  issue: Issue;
  /** Server-ordered timeline (comments + activities). Rendered as given. */
  timeline: TimelineEntry[];
  attachments: ExportedAttachment[];
  /** Persistent agent workspaces for this issue, with their plain files. */
  workspaces: ExportedWorkspace[];
  /** Per-run execution transcripts for this issue's agent runs. */
  executions: ExportedExecution[];
  childTree: ExportChildIssue[];
  /** Set when the sub-issue walk hit its depth or node cap. */
  childTreeTruncated?: { atDepth: boolean; nodes: number } | null;
  /** Localized display label for `issue.status`, resolved by the caller. */
  statusLabel: string;
  assigneeName?: string;
  creatorName?: string;
  parent?: { identifier: string; title: string; statusLabel: string };
  projectName?: string;
  agentRuns: AgentTask[];
  /** Resolves an AgentTask.agent_id to a display name. */
  runAgentName: (agentId: string) => string | undefined;
  subscribers: IssueSubscriber[];
  subscriberName: (type: string, id: string) => string | undefined;
  pullRequests: GitHubPullRequest[];
  /** Workspace property catalog, used to decode `issue.properties`. */
  propertyDefinitions: IssueProperty[];
  /** Resolves "member:<id>" style actor references in property values. */
  actorName: (type: string, id: string) => string | undefined;
  /** Shareable absolute URL of the issue. */
  url: string;
  /** ISO timestamp of the export moment. */
  exportedAt: string;
}

/** Tree-walk caps: pathological sub-issue graphs must not hang the export. */
export const EXPORT_CHILD_DEPTH_LIMIT = 5;
export const EXPORT_CHILD_NODE_LIMIT = 200;

/**
 * Workspace export caps so a pathological workspace can neither hang the
 * export nor blow up the in-memory zip: plain files per workspace, and packed
 * bytes across the whole bundle (attachments + workspace files).
 */
export const EXPORT_WORKSPACE_FILE_LIMIT = 200;
export const EXPORT_PACKED_BYTES_LIMIT = 128 * 1024 * 1024;

/**
 * Per-run transcript caps so one pathological run (a tool result carrying a
 * huge payload, or a stuck loop) cannot dominate the bundle: messages per
 * run, chars per single message body, and chars for the whole file.
 */
export const EXPORT_EXECUTION_MESSAGE_LIMIT = 2000;
export const EXPORT_EXECUTION_ENTRY_CHAR_LIMIT = 64 * 1024;
export const EXPORT_EXECUTION_FILE_CHAR_LIMIT = 1_000_000;

/** Zip entries must stay inside the bundle: no absolute paths, no "..". */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  return path
    .split("/")
    .every((segment) => segment && segment !== "." && segment !== "..");
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

/**
 * Maps every URL form an attachment may appear under (durable `markdown_url`
 * and raw `url`) to what the exported document should reference: the packed
 * zip path when the bytes were included, an absolute platform URL otherwise.
 */
export function buildAttachmentUrlMap(
  attachments: ExportedAttachment[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const { attachment, packedName, absoluteUrl } of attachments) {
    const target = packedName ?? absoluteUrl;
    for (const key of [attachment.markdown_url, attachment.url]) {
      if (key) map[key] = target;
    }
  }
  return map;
}

/** Rewrites attachment URLs inside a Markdown body to their export targets. */
export function rewriteAttachmentUrls(
  markdown: string,
  map: Record<string, string>,
): string {
  let out = markdown;
  for (const [from, to] of Object.entries(map)) {
    if (!from || from === to) continue;
    out = out.split(from).join(to);
  }
  return out;
}

/**
 * Decodes one custom-property value the way the sidebar renders it
 * (select/multi_select ids → option names, actor refs → names), but keeps
 * raw values for ids that no longer resolve — an export must not silently
 * drop information the way a chip display can.
 */
export function decodePropertyValue(
  property: IssueProperty,
  value: IssuePropertyValue | undefined,
  actorName: (type: string, id: string) => string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const options = property.config.options ?? [];
  switch (property.type) {
    case "select": {
      const option = options.find((o) => o.id === value);
      return option ? option.name : String(value);
    }
    case "multi_select": {
      const ids = Array.isArray(value) ? value : [value];
      const names = ids.map(
        (id) => options.find((o) => o.id === id)?.name ?? String(id),
      );
      return names.length > 0 ? names.join(", ") : undefined;
    }
    case "actor": {
      const ref = String(value);
      const [type, id] = ref.split(":", 2);
      const name = type && id ? actorName(type, id) : undefined;
      return name ?? ref;
    }
    case "multi_actor": {
      const refs = Array.isArray(value) ? value : [value];
      const names = refs.map((ref) => {
        const [type, id] = String(ref).split(":", 2);
        return (type && id ? actorName(type, id) : undefined) ?? String(ref);
      });
      return names.length > 0 ? names.join(", ") : undefined;
    }
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

function attachmentLine({ attachment, packedName, absoluteUrl }: ExportedAttachment): string {
  const href = packedName ?? absoluteUrl;
  const note = packedName
    ? "included in this export"
    : "not included (download failed; requires platform access)";
  return `- [${attachment.filename}](${href}) (${formatBytes(attachment.size_bytes)}) — ${note}`;
}

function workspaceFileLine(file: ExportedWorkspaceFile): string {
  const size =
    file.sizeBytes !== undefined ? ` (${formatBytes(file.sizeBytes)})` : "";
  if (file.packedName) {
    return `  - \`${file.path}\`${size} — included in this export (${file.packedName})`;
  }
  const reason =
    file.skippedReason === "too_large"
      ? "too large for the workspace download cap"
      : file.skippedReason === "size_cap"
        ? "dropped to keep the bundle within its size budget"
        : "could not be downloaded (node offline or file missing)";
  return `  - \`${file.path}\`${size} — not included: ${reason}`;
}

function renderWorkspace(workspace: ExportedWorkspace): string {
  const who = workspace.agentName || workspace.taskShort;
  const where = workspace.deviceName ? ` on ${workspace.deviceName}` : "";
  const lines = [`- **${who}** (\`${workspace.taskShort}\`)${where}`];
  if (workspace.error) {
    lines.push(`  - workspace unreachable: ${workspace.error}`);
  }
  for (const file of workspace.files) lines.push(workspaceFileLine(file));
  if (workspace.fileCapDropped) {
    lines.push(
      `  - ${workspace.fileCapDropped} more file(s) not listed (per-workspace export cap)`,
    );
  }
  if (workspace.treeTruncated) {
    lines.push("  - tree listing was truncated by the server; more files may exist");
  }
  return lines.join("\n");
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

function renderEntry(entry: TimelineEntry, urlMap: Record<string, string>): string {
  const when = entry.created_at;
  const who = actorLabel(entry);
  if (entry.type === "comment") {
    const kind = entry.parent_id ? "reply" : entry.comment_type || "comment";
    const resolved = entry.resolved_at ? " · resolved" : "";
    const lines: string[] = [`#### ${when} · ${who} · ${kind}${resolved}`, ""];
    const content = rewriteAttachmentUrls((entry.content || "").trim(), urlMap);
    if (content) lines.push(content, "");
    for (const reaction of entry.reactions ?? []) {
      lines.push(`- reaction: ${reaction.emoji}`);
    }
    for (const a of entry.attachments ?? []) {
      const target = urlMap[a.markdown_url || a.url] || a.markdown_url || a.url;
      lines.push(`- [${a.filename}](${target}) (${formatBytes(a.size_bytes)})`);
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

function renderChildTree(
  children: ExportChildIssue[],
  urlMap: Record<string, string>,
  depth: number,
): string {
  const indent = "  ".repeat(depth);
  return children
    .map(({ issue, statusLabel, assigneeName }) => {
      const assignee = assigneeName ? ` · ${assigneeName}` : "";
      const head = `${indent}- **${issue.identifier ?? issue.id} — ${issue.title}** [${statusLabel}]${assignee}`;
      const description = (issue.description ?? "").trim();
      if (!description) return head;
      const body = rewriteAttachmentUrls(description, urlMap)
        .split("\n")
        .map((line) => (line.trim() === "" ? "" : `${indent}  ${line}`))
        .join("\n");
      return `${head}\n${body}`;
    })
    .concat(
      children.length > 0 && children.some((c) => c.children.length > 0)
        ? children
            .filter((c) => c.children.length > 0)
            .map((c) => renderChildTree(c.children, urlMap, depth + 1))
        : [],
    )
    .filter(Boolean)
    .join("\n");
}

const RESULT_SNIPPET_LIMIT = 4000;

function clip(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n…(truncated, ${text.length} chars total)`
    : text;
}

/**
 * Renders one agent run's execution transcript — the message stream behind
 * the platform's "view run process" dialog (text, thinking, tool calls and
 * results, errors) — as a standalone Markdown file for the executions/
 * folder of the export bundle.
 */
export function renderTaskTranscript(input: {
  run: AgentTask;
  agentName?: string;
  messages: TaskMessagePayload[];
  exportedAt: string;
}): string {
  const { run, agentName, messages, exportedAt } = input;
  const who = agentName || run.agent_id;
  const when = [run.dispatched_at, run.started_at, run.completed_at]
    .filter(Boolean)
    .join(" → ");
  const out: string[] = [];
  out.push("---");
  out.push(`multica_export: ${yaml("task_transcript")}`);
  out.push(`task_id: ${yaml(run.id)}`);
  out.push(`agent: ${yaml(who)}`);
  out.push(`status: ${yaml(run.status)}`);
  out.push(`exported_at: ${yaml(exportedAt)}`);
  out.push("---", "");
  out.push(`# Execution transcript — ${who} · ${run.status}${when ? ` · ${when}` : ""}`, "");
  if (run.error) {
    out.push(`> error: ${run.error}`, "");
  }
  const ordered = [...messages].sort((a, b) => a.seq - b.seq);
  const count = Math.min(ordered.length, EXPORT_EXECUTION_MESSAGE_LIMIT);
  let used = 0;
  for (const message of ordered.slice(0, count)) {
    const head = `### #${message.seq} · ${message.type}${
      message.tool ? ` · ${message.tool}` : ""
    }${message.created_at ? ` · ${message.created_at}` : ""}`;
    const body: string[] = [];
    if (message.type === "tool_use") {
      body.push("```json", JSON.stringify(message.input ?? {}, null, 2), "```");
    } else if (message.type === "tool_result") {
      body.push("```", clip(message.output ?? "", EXPORT_EXECUTION_ENTRY_CHAR_LIMIT), "```");
    } else {
      body.push(clip((message.content ?? "").trim(), EXPORT_EXECUTION_ENTRY_CHAR_LIMIT));
    }
    const block = [head, "", ...body, ""].join("\n");
    used += block.length;
    if (used > EXPORT_EXECUTION_FILE_CHAR_LIMIT) {
      out.push("<!-- transcript size cap reached; remaining messages not exported -->", "");
      break;
    }
    out.push(block);
  }
  if (ordered.length > count) {
    out.push(
      `> ${ordered.length - count} more message(s) not exported (per-run message cap).`,
      "",
    );
  }
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function renderAgentRun(
  run: AgentTask,
  agentName: (id: string) => string | undefined,
  execution?: ExportedExecution,
): string {
  const who = agentName(run.agent_id) || run.agent_id;
  const when = [run.dispatched_at, run.started_at, run.completed_at]
    .filter(Boolean)
    .join(" → ");
  const link = execution?.packedName
    ? ` · [transcript](${execution.packedName})`
    : execution?.error
      ? ` · transcript unavailable (${execution.error})`
      : "";
  const lines = [`- **${who}** · ${run.status}${when ? ` · ${when}` : ""}${link}`];
  if (run.error) {
    lines.push(`  - error: ${run.error}`);
  }
  if (run.result !== undefined && run.result !== null) {
    const text =
      typeof run.result === "string"
        ? run.result
        : JSON.stringify(run.result, null, 2);
    const snippet =
      text.length > RESULT_SNIPPET_LIMIT
        ? `${text.slice(0, RESULT_SNIPPET_LIMIT)}\n…(truncated, ${text.length} chars total)`
        : text;
    lines.push("  - result:", "    ```json", ...snippet.split("\n").map((l) => `    ${l}`), "    ```");
  }
  return lines.join("\n");
}

export function buildIssueExportMarkdown(input: IssueExportInput): string {
  const { issue } = input;
  const labels = issue.labels?.map((label) => label.name).join(", ");
  const urlMap = buildAttachmentUrlMap(input.attachments);
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
      "the full platform record: properties (built-in and custom), the",
      "description (Markdown, verbatim), the complete comment and activity",
      "timeline in original order, agent-run history, the parent/sub-issue",
      "tree, pull requests, and attachments. Attachment files, when included,",
      "sit in the `attachments/` folder next to this document and are",
      "referenced from it by relative path. Files from the issue's agent",
      "workspaces, when included, sit under the `workspace/` folder with",
      "their original paths. Per-run execution transcripts sit under",
      "the `executions/` folder, linked from the Agent runs section.",
      "Continue the work from the latest",
      "state in the timeline; treat the timeline as the authoritative history.",
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
  if (input.parent) {
    out.push(
      `- **Parent**: ${input.parent.identifier} — ${input.parent.title} [${input.parent.statusLabel}]`,
    );
  }
  if (labels) out.push(`- **Labels**: ${labels}`);
  out.push(`- **Created**: ${issue.created_at}`);
  out.push(`- **Updated**: ${issue.updated_at}`);
  if (issue.metadata && Object.keys(issue.metadata).length > 0) {
    out.push(`- **Metadata**: ${JSON.stringify(issue.metadata)}`);
  }
  const subscriberNames = input.subscribers
    .map((s) => {
      const name = input.subscriberName(s.user_type, s.user_id);
      return name ? (s.user_type === "agent" ? `${name} (agent)` : name) : s.user_id;
    })
    .filter(Boolean);
  if (subscriberNames.length > 0) {
    out.push(`- **Subscribers**: ${subscriberNames.join(", ")}`);
  }
  for (const property of input.propertyDefinitions) {
    const decoded = decodePropertyValue(
      property,
      issue.properties?.[property.id],
      input.actorName,
    );
    if (decoded !== undefined) {
      out.push(`- **${property.name}**: ${decoded}`);
    }
  }
  out.push("");

  if (issue.description && issue.description.trim().length > 0) {
    out.push("## Description", "", rewriteAttachmentUrls(issue.description, urlMap), "");
  }

  if (input.timeline.length > 0) {
    out.push(
      "## Timeline",
      "",
      input.timeline.map((entry) => renderEntry(entry, urlMap)).join("\n\n"),
      "",
    );
  }

  if (input.agentRuns.length > 0) {
    out.push(
      "## Agent runs",
      "",
      input.agentRuns
        .map((run) =>
          renderAgentRun(
            run,
            input.runAgentName,
            input.executions.find((e) => e.run.id === run.id),
          ),
        )
        .join("\n"),
      "",
    );
  }

  if (input.childTree.length > 0 || input.childTreeTruncated) {
    out.push("## Sub-issues", "", renderChildTree(input.childTree, urlMap, 0), "");
    if (input.childTreeTruncated) {
      const why = input.childTreeTruncated.atDepth
        ? `depth > ${EXPORT_CHILD_DEPTH_LIMIT}`
        : `> ${EXPORT_CHILD_NODE_LIMIT} nodes`;
      out.push(
        `> Sub-issue tree truncated at ${why} (${input.childTreeTruncated.nodes} exported). Open the parent task in the platform for the rest.`,
        "",
      );
    }
  }

  if (input.pullRequests.length > 0) {
    const prLines = input.pullRequests.map((pr) => {
      const repo = `${pr.repo_owner}/${pr.repo_name}#${pr.number}`;
      const merged = pr.merged_at ? " · merged" : "";
      const author = pr.author_login ? ` · @${pr.author_login}` : "";
      return `- [${repo} — ${pr.title}](${pr.html_url}) · ${pr.state}${merged}${author}`;
    });
    out.push("## Pull requests", "", prLines.join("\n"), "");
  }

  if (input.attachments.length > 0) {
    out.push(
      "## Attachments",
      "",
      input.attachments.map(attachmentLine).join("\n"),
      "",
    );
  }

  if (input.workspaces.length > 0) {
    out.push(
      "## Agent workspace files",
      "",
      "Persistent agent working directories for this issue. Packed files sit under `workspace/` in this bundle, preserving their in-directory paths.",
      "",
      input.workspaces.map(renderWorkspace).join("\n"),
      "",
    );
  }

  return `${out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
