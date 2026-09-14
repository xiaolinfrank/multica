// @vitest-environment node
import { describe, it, expect } from "vitest";
import type {
  AgentTask,
  Attachment,
  GitHubPullRequest,
  Issue,
  IssueProperty,
  IssueSubscriber,
  TimelineEntry,
} from "@multica/core/types";
import {
  EXPORT_EXECUTION_ENTRY_CHAR_LIMIT,
  EXPORT_EXECUTION_MESSAGE_LIMIT,
  buildAttachmentUrlMap,
  buildIssueExportMarkdown,
  decodePropertyValue,
  isSafeRelativePath,
  issueExportFilename,
  renderTaskTranscript,
  rewriteAttachmentUrls,
  type ExportChildIssue,
  type ExportedAttachment,
  type IssueExportInput,
} from "./build-issue-export";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "i-1",
    workspace_id: "ws-1",
    number: 1,
    identifier: "MUL-1",
    title: "Test",
    description: null,
    status: "todo",
    priority: "medium",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "u-1",
    parent_issue_id: null,
    project_id: null,
    position: 0,
    stage: null,
    start_date: null,
    due_date: null,
    metadata: {},
    properties: {},
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-02T00:00:00Z",
    ...overrides,
  };
}

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "a-1",
    workspace_id: "ws-1",
    issue_id: "i-1",
    comment_id: null,
    chat_session_id: null,
    chat_message_id: null,
    uploader_type: "member",
    uploader_id: "u-1",
    filename: "report.pdf",
    content_type: "application/pdf",
    url: "/raw/report.pdf",
    download_url: "/dl/report.pdf",
    markdown_url: "/api/attachments/a-1/download",
    size_bytes: 1536,
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeExportedAttachment(
  overrides: Partial<ExportedAttachment> & { attachment?: Attachment } = {},
): ExportedAttachment {
  const { attachment, ...rest } = overrides;
  return {
    attachment: attachment ?? makeAttachment(),
    absoluteUrl: "http://example.com/api/attachments/a-1/download",
    ...rest,
  };
}

const noActor = (): string | undefined => undefined;

function makeInput(overrides: Partial<IssueExportInput> = {}): IssueExportInput {
  return {
    issue: makeIssue(),
    timeline: [],
    attachments: [],
    workspaces: [],
    executions: [],
    childTree: [],
    statusLabel: "To do",
    agentRuns: [],
    runAgentName: noActor,
    subscribers: [],
    subscriberName: noActor,
    pullRequests: [],
    propertyDefinitions: [],
    actorName: noActor,
    url: "https://example.com/ws/issues/MUL-1",
    exportedAt: "2026-09-13T00:00:00Z",
    ...overrides,
  };
}

describe("issueExportFilename", () => {
  it("derives the filename from the identifier", () => {
    expect(issueExportFilename("MUL-123")).toBe("MUL-123.md");
  });

  it("falls back when the identifier is missing", () => {
    expect(issueExportFilename(undefined)).toBe("issue.md");
    expect(issueExportFilename("")).toBe("issue.md");
  });
});

describe("buildAttachmentUrlMap / rewriteAttachmentUrls", () => {
  it("maps both markdown_url and url to the packed path", () => {
    const map = buildAttachmentUrlMap([
      makeExportedAttachment({ packedName: "attachments/report.pdf" }),
    ]);
    expect(map["/api/attachments/a-1/download"]).toBe("attachments/report.pdf");
    expect(map["/raw/report.pdf"]).toBe("attachments/report.pdf");
  });

  it("maps failed downloads to the absolute URL", () => {
    const map = buildAttachmentUrlMap([makeExportedAttachment()]);
    expect(map["/api/attachments/a-1/download"]).toBe(
      "http://example.com/api/attachments/a-1/download",
    );
  });

  it("rewrites occurrences inside a markdown body", () => {
    const body = "see ![img](/api/attachments/a-1/download) and /raw/report.pdf";
    expect(
      rewriteAttachmentUrls(body, {
        "/api/attachments/a-1/download": "attachments/report.pdf",
        "/raw/report.pdf": "attachments/report.pdf",
      }),
    ).toBe("see ![img](attachments/report.pdf) and attachments/report.pdf");
  });
});

describe("decodePropertyValue", () => {
  const options = [
    { id: "opt-1", name: "High", color: "#f00" },
    { id: "opt-2", name: "Low", color: "#0f0" },
  ];
  const property = (type: string): IssueProperty =>
    ({
      id: "p-1",
      workspace_id: "ws-1",
      name: "Severity",
      type,
      config: { options },
      position: 0,
      archived: false,
      created_at: "2025-01-01T00:00:00Z",
    }) as IssueProperty;

  it("decodes select to the option name", () => {
    expect(decodePropertyValue(property("select"), "opt-1", noActor)).toBe("High");
  });

  it("keeps the raw id for a deleted option instead of dropping it", () => {
    expect(decodePropertyValue(property("select"), "gone", noActor)).toBe("gone");
  });

  it("decodes multi_select in value order", () => {
    expect(
      decodePropertyValue(property("multi_select"), ["opt-2", "opt-1"], noActor),
    ).toBe("Low, High");
  });

  it("decodes actor refs through the resolver and falls back to the raw ref", () => {
    expect(
      decodePropertyValue(property("actor"), "member:u-9", (_t, id) =>
        id === "u-9" ? "Alice" : undefined,
      ),
    ).toBe("Alice");
    expect(decodePropertyValue(property("actor"), "member:u-9", noActor)).toBe(
      "member:u-9",
    );
  });

  it("stringifies primitives for text/number/checkbox/date/url", () => {
    expect(decodePropertyValue(property("text"), "abc", noActor)).toBe("abc");
    expect(decodePropertyValue(property("number"), 3, noActor)).toBe("3");
    expect(decodePropertyValue(property("checkbox"), true, noActor)).toBe("true");
  });

  it("returns undefined for unset values", () => {
    expect(decodePropertyValue(property("select"), undefined, noActor)).toBeUndefined();
  });
});

describe("buildIssueExportMarkdown", () => {
  it("renders the front matter with escaped scalars", () => {
    const md = buildIssueExportMarkdown(
      makeInput({ issue: makeIssue({ title: 'A "quoted" title' }) }),
    );
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain('title: "A \\"quoted\\" title"');
    expect(md).toContain('multica_export: "issue"');
    expect(md).toContain('identifier: "MUL-1"');
    expect(md).toContain('url: "https://example.com/ws/issues/MUL-1"');
    expect(md).toContain('exported_at: "2026-09-13T00:00:00Z"');
  });

  it("renders properties with resolved display values", () => {
    const md = buildIssueExportMarkdown(
      makeInput({
        issue: makeIssue({
          assignee_type: "agent",
          assignee_id: "ag-1",
          start_date: "2026-09-01",
          due_date: "2026-09-30",
          labels: [{ id: "l1", name: "bug", color: "#f00" }] as Issue["labels"],
          metadata: { origin: "sweep" },
        }),
        assigneeName: "Mika",
        creatorName: "Alice",
        projectName: "Platform",
        parent: { identifier: "MUL-0", title: "Parent task", statusLabel: "In progress" },
      }),
    );
    expect(md).toContain("- **Status**: To do");
    expect(md).toContain("- **Priority**: medium");
    expect(md).toContain("- **Assignee**: Mika (agent)");
    expect(md).toContain("- **Creator**: Alice (member)");
    expect(md).toContain("- **Start date**: 2026-09-01");
    expect(md).toContain("- **Due date**: 2026-09-30");
    expect(md).toContain("- **Project**: Platform");
    expect(md).toContain("- **Parent**: MUL-0 — Parent task [In progress]");
    expect(md).toContain("- **Labels**: bug");
    expect(md).toContain('- **Metadata**: {"origin":"sweep"}');
    expect(md).toContain("- **Created**: 2025-01-01T00:00:00Z");
    expect(md).toContain("- **Updated**: 2025-01-02T00:00:00Z");
  });

  it("shows Unassigned when there is no assignee", () => {
    const md = buildIssueExportMarkdown(makeInput());
    expect(md).toContain("- **Assignee**: Unassigned");
  });

  it("renders subscribers and custom properties in the properties block", () => {
    const definition = {
      id: "p-1",
      workspace_id: "ws-1",
      name: "Severity",
      type: "select",
      config: { options: [{ id: "opt-1", name: "High", color: "#f00" }] },
      position: 0,
      archived: false,
      created_at: "2025-01-01T00:00:00Z",
    } as IssueProperty;
    const subscribers: IssueSubscriber[] = [
      {
        issue_id: "i-1",
        user_type: "member",
        user_id: "u-1",
        reason: "assignee",
        created_at: "2025-01-01T00:00:00Z",
      },
      {
        issue_id: "i-1",
        user_type: "agent",
        user_id: "ag-1",
        reason: "mentioned",
        created_at: "2025-01-01T00:00:00Z",
      },
    ];
    const md = buildIssueExportMarkdown(
      makeInput({
        issue: makeIssue({ properties: { "p-1": "opt-1" } }),
        propertyDefinitions: [definition],
        subscribers,
        subscriberName: (type, id) =>
          type === "member" && id === "u-1"
            ? "Alice"
            : type === "agent" && id === "ag-1"
              ? "Mika"
              : undefined,
      }),
    );
    expect(md).toContain("- **Subscribers**: Alice, Mika (agent)");
    expect(md).toContain("- **Severity**: High");
  });

  it("embeds the description verbatim and rewrites packed attachment urls", () => {
    const description =
      "## Steps\n\n1. do a thing\n\nsee ![img](/api/attachments/a-1/download)";
    const md = buildIssueExportMarkdown(
      makeInput({
        issue: makeIssue({ description }),
        attachments: [makeExportedAttachment({ packedName: "attachments/report.pdf" })],
      }),
    );
    expect(md).toContain("## Description");
    expect(md).toContain("## Steps");
    expect(md).toContain("![img](attachments/report.pdf)");
    expect(md).not.toContain("/api/attachments/a-1/download)");
  });

  it("omits empty sections entirely", () => {
    const md = buildIssueExportMarkdown(makeInput());
    expect(md).not.toContain("## Description");
    expect(md).not.toContain("## Timeline");
    expect(md).not.toContain("## Agent runs");
    expect(md).not.toContain("## Sub-issues");
    expect(md).not.toContain("## Pull requests");
    expect(md).not.toContain("## Attachments");
  });

  it("renders comments, replies, resolution, reactions and their attachments", () => {
    const timeline: TimelineEntry[] = [
      {
        type: "comment",
        id: "c-1",
        actor_type: "member",
        actor_id: "u-1",
        actor_name: "Alice",
        content: "First comment",
        parent_id: null,
        created_at: "2025-01-01T01:00:00Z",
        reactions: [
          {
            id: "r1",
            comment_id: "c-1",
            actor_type: "member",
            actor_id: "u-2",
            emoji: "👍",
            created_at: "2025-01-01T01:05:00Z",
          },
        ],
      },
      {
        type: "comment",
        id: "c-2",
        actor_type: "agent",
        actor_id: "ag-1",
        actor_name: "Mika",
        content: "A reply with [file](/api/attachments/a-1/download)",
        parent_id: "c-1",
        resolved_at: "2025-01-01T03:00:00Z",
        created_at: "2025-01-01T02:00:00Z",
        attachments: [makeAttachment({ id: "a-2", filename: "log.txt", size_bytes: 10 })],
      },
    ];
    const md = buildIssueExportMarkdown(
      makeInput({
        timeline,
        attachments: [makeExportedAttachment({ packedName: "attachments/report.pdf" })],
      }),
    );
    expect(md).toContain("## Timeline");
    expect(md).toContain("#### 2025-01-01T01:00:00Z · Alice (member) · comment");
    expect(md).toContain("First comment");
    expect(md).toContain("#### 2025-01-01T02:00:00Z · Mika (agent) · reply · resolved");
    expect(md).toContain("[file](attachments/report.pdf)");
    expect(md).toContain("- reaction: 👍");
    // Comment-scoped attachment urls rewrite through the same map.
    expect(md).toContain("- [log.txt](attachments/report.pdf) (10 B)");
  });

  it("renders activities with a phrase and a JSON details block", () => {
    const timeline: TimelineEntry[] = [
      {
        type: "activity",
        id: "ac-1",
        actor_type: "member",
        actor_id: "u-1",
        actor_name: "Alice",
        action: "status_changed",
        details: { from: "todo", to: "in_progress" },
        created_at: "2025-01-01T00:30:00Z",
      },
      {
        type: "activity",
        id: "ac-2",
        actor_type: "member",
        actor_id: "u-1",
        actor_name: "Alice",
        action: "something_exotic",
        created_at: "2025-01-01T00:40:00Z",
      },
    ];
    const md = buildIssueExportMarkdown(makeInput({ timeline }));
    expect(md).toContain("#### 2025-01-01T00:30:00Z · Alice (member) · changed the status");
    expect(md).toContain('"from": "todo"');
    expect(md).toContain("#### 2025-01-01T00:40:00Z · Alice (member) · activity: something_exotic");
  });

  it("falls back to the actor id when no name was hydrated", () => {
    const timeline: TimelineEntry[] = [
      {
        type: "activity",
        id: "ac-3",
        actor_type: "system",
        actor_id: "00000000-0000-0000-0000-000000000000",
        action: "created",
        created_at: "2025-01-01T00:10:00Z",
      },
    ];
    const md = buildIssueExportMarkdown(makeInput({ timeline }));
    expect(md).toContain("(system) · created the task");
  });

  it("renders the sub-issue tree recursively with descriptions indented", () => {
    const childTree: ExportChildIssue[] = [
      {
        issue: makeIssue({
          id: "i-2",
          number: 2,
          identifier: "MUL-2",
          title: "Child",
          status: "done",
          description: "child body",
        }),
        statusLabel: "Done",
        assigneeName: "Bob",
        children: [
          {
            issue: makeIssue({
              id: "i-3",
              number: 3,
              identifier: "MUL-3",
              title: "Grandchild",
              status: "todo",
            }),
            statusLabel: "To do",
            children: [],
          },
        ],
      },
    ];
    const md = buildIssueExportMarkdown(makeInput({ childTree }));
    expect(md).toContain("## Sub-issues");
    expect(md).toContain("- **MUL-2 — Child** [Done] · Bob");
    expect(md).toContain("  child body");
    expect(md).toContain("  - **MUL-3 — Grandchild** [To do]");
  });

  it("notes when the sub-issue tree was truncated", () => {
    const md = buildIssueExportMarkdown(
      makeInput({
        childTree: [],
        childTreeTruncated: { atDepth: false, nodes: 200 },
      }),
    );
    expect(md).toContain("Sub-issue tree truncated");
  });

  it("renders agent runs with name, status, error and a truncated result", () => {
    const run = {
      id: "t-1",
      agent_id: "ag-1",
      runtime_id: "rt-1",
      issue_id: "i-1",
      status: "failed",
      priority: 0,
      dispatched_at: "2025-01-01T01:00:00Z",
      started_at: "2025-01-01T01:00:05Z",
      completed_at: "2025-01-01T01:02:00Z",
      result: { summary: "x".repeat(5000) },
      error: "boom",
    } as unknown as AgentTask;
    const md = buildIssueExportMarkdown(
      makeInput({ agentRuns: [run], runAgentName: (id) => (id === "ag-1" ? "Mika" : undefined) }),
    );
    expect(md).toContain("## Agent runs");
    expect(md).toContain("- **Mika** · failed · 2025-01-01T01:00:00Z → 2025-01-01T01:00:05Z → 2025-01-01T01:02:00Z");
    expect(md).toContain("  - error: boom");
    expect(md).toContain("…(truncated, ");
  });

  it("renders pull requests with repo, state and author", () => {
    const pr = {
      id: "pr-1",
      workspace_id: "ws-1",
      repo_owner: "acme",
      repo_name: "app",
      number: 42,
      title: "Fix export",
      state: "closed",
      html_url: "https://github.com/acme/app/pull/42",
      branch: "fix/export",
      author_login: "alice",
      author_avatar_url: null,
      merged_at: "2025-01-02T00:00:00Z",
      closed_at: "2025-01-02T00:00:00Z",
      pr_created_at: "2025-01-01T00:00:00Z",
      pr_updated_at: "2025-01-02T00:00:00Z",
    } as GitHubPullRequest;
    const md = buildIssueExportMarkdown(makeInput({ pullRequests: [pr] }));
    expect(md).toContain("## Pull requests");
    expect(md).toContain(
      "- [acme/app#42 — Fix export](https://github.com/acme/app/pull/42) · closed · merged · @alice",
    );
  });

  it("marks packed and failed attachments in the attachment list", () => {
    const md = buildIssueExportMarkdown(
      makeInput({
        attachments: [
          makeExportedAttachment({ packedName: "attachments/report.pdf" }),
          makeExportedAttachment({
            attachment: makeAttachment({
              id: "a-3",
              filename: "big.bin",
              size_bytes: 5 * 1024 * 1024,
            }),
            absoluteUrl: "http://example.com/api/attachments/a-3/download",
          }),
        ],
      }),
    );
    expect(md).toContain("- [report.pdf](attachments/report.pdf) (1.5 KB) — included in this export");
    expect(md).toContain(
      "- [big.bin](http://example.com/api/attachments/a-3/download) (5 MB) — not included (download failed; requires platform access)",
    );
  });
});

describe("agent workspace files section", () => {
  it("omits the section when there are no workspaces", () => {
    const md = buildIssueExportMarkdown(makeInput());
    expect(md).not.toContain("## Agent workspace files");
  });

  it("renders packed files with their in-bundle path and skipped files with reasons", () => {
    const md = buildIssueExportMarkdown(
      makeInput({
        workspaces: [
          {
            taskShort: "abc12345",
            agentName: "Research Bot",
            deviceName: "mac-mini-3",
            files: [
              { path: "notes.md", sizeBytes: 2048, packedName: "workspace/abc12345/notes.md" },
              { path: "big-model.bin", sizeBytes: 11 << 20, skippedReason: "too_large" },
              { path: "late.log", sizeBytes: 10, skippedReason: "size_cap" },
              { path: "gone.txt", sizeBytes: 3, skippedReason: "unavailable" },
            ],
            fileCapDropped: 12,
            treeTruncated: true,
          },
        ],
      }),
    );
    expect(md).toContain("## Agent workspace files");
    expect(md).toContain("**Research Bot** (`abc12345`) on mac-mini-3");
    expect(md).toContain(
      "`notes.md` (2 KB) — included in this export (workspace/abc12345/notes.md)",
    );
    expect(md).toContain(
      "`big-model.bin` (11 MB) — not included: too large for the workspace download cap",
    );
    expect(md).toContain(
      "`late.log` (10 B) — not included: dropped to keep the bundle within its size budget",
    );
    expect(md).toContain(
      "`gone.txt` (3 B) — not included: could not be downloaded (node offline or file missing)",
    );
    expect(md).toContain("12 more file(s) not listed (per-workspace export cap)");
    expect(md).toContain("tree listing was truncated by the server; more files may exist");
  });

  it("notes an unreachable workspace instead of failing", () => {
    const md = buildIssueExportMarkdown(
      makeInput({
        workspaces: [{ taskShort: "deadbeef", files: [], error: "workspace unreachable" }],
      }),
    );
    expect(md).toContain("workspace unreachable: workspace unreachable");
  });

  it("falls back to the task dir when the agent name is missing", () => {
    const md = buildIssueExportMarkdown(
      makeInput({ workspaces: [{ taskShort: "ff00ff00", files: [] }] }),
    );
    expect(md).toContain("**ff00ff00** (`ff00ff00`)");
  });
});

describe("isSafeRelativePath", () => {
  it("accepts plain relative paths and rejects traversal", () => {
    expect(isSafeRelativePath("a/b.txt")).toBe(true);
    expect(isSafeRelativePath("a/b/c.md")).toBe(true);
    expect(isSafeRelativePath("")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("../x")).toBe(false);
    expect(isSafeRelativePath("a/../../x")).toBe(false);
    expect(isSafeRelativePath("a//b")).toBe(false);
    expect(isSafeRelativePath("C:\\x")).toBe(false);
  });
});

describe("execution transcripts", () => {
  const run = {
    id: "t-1",
    agent_id: "ag-1",
    runtime_id: "rt-1",
    issue_id: "i-1",
    status: "completed",
    priority: 0,
    dispatched_at: "2025-01-01T01:00:00Z",
    started_at: null,
    completed_at: "2025-01-01T01:02:00Z",
    result: null,
    error: null,
  } as unknown as AgentTask;

  it("renders the message stream per type in seq order", () => {
    const md = renderTaskTranscript({
      run,
      agentName: "Mika",
      messages: [
        { task_id: "t-1", issue_id: "i-1", seq: 2, type: "tool_use", tool: "web_search", input: { q: "GDPR" }, created_at: "2025-01-01T01:00:10Z" },
        { task_id: "t-1", issue_id: "i-1", seq: 1, type: "thinking", content: "Plan first.", created_at: "2025-01-01T01:00:05Z" },
        { task_id: "t-1", issue_id: "i-1", seq: 3, type: "tool_result", output: "found 3 docs", created_at: "2025-01-01T01:00:20Z" },
        { task_id: "t-1", issue_id: "i-1", seq: 4, type: "text", content: "Done.", created_at: "2025-01-01T01:01:00Z" },
        { task_id: "t-1", issue_id: "i-1", seq: 5, type: "error", content: "boom", created_at: "2025-01-01T01:01:30Z" },
      ],
      exportedAt: "2026-09-14T00:00:00Z",
    });
    const heads = md.split("\n").filter((l) => l.startsWith("### #"));
    expect(heads[0]).toContain("#1 · thinking");
    expect(heads[1]).toContain("#2 · tool_use · web_search");
    expect(heads[2]).toContain("#3 · tool_result");
    expect(md).toContain('"q": "GDPR"');
    expect(md).toContain("found 3 docs");
    expect(md).toContain("Done.");
    expect(md).toContain("boom");
    expect(md).toContain("# Execution transcript — Mika · completed");
  });

  it("truncates oversized message bodies and caps message count", () => {
    const many = Array.from({ length: EXPORT_EXECUTION_MESSAGE_LIMIT + 3 }, (_, i) => ({
      task_id: "t-1",
      issue_id: "i-1",
      seq: i + 1,
      type: "text" as const,
      content: "x",
    }));
    const md = renderTaskTranscript({
      run,
      messages: [
        ...many,
        {
          task_id: "t-1",
          issue_id: "i-1",
          seq: 0,
          type: "tool_result" as const,
          output: "y".repeat(EXPORT_EXECUTION_ENTRY_CHAR_LIMIT + 10),
        },
      ],
      exportedAt: "2026-09-14T00:00:00Z",
    });
    expect(md).toContain("4 more message(s) not exported");
    expect(md).toContain(`…(truncated, ${EXPORT_EXECUTION_ENTRY_CHAR_LIMIT + 10} chars total)`);
  });

  it("stops at the per-file size cap", () => {
    const big = Array.from({ length: 300 }, (_, i) => ({
      task_id: "t-1",
      issue_id: "i-1",
      seq: i + 1,
      type: "text" as const,
      content: "z".repeat(4096),
    }));
    const md = renderTaskTranscript({ run, messages: big, exportedAt: "x" });
    expect(md).toContain("transcript size cap reached; remaining messages not exported");
  });

  it("links each run to its transcript file in the Agent runs section", () => {
    const md = buildIssueExportMarkdown(
      makeInput({
        agentRuns: [run],
        executions: [{ run, packedName: "executions/run-1-abc12345.md" }],
      }),
    );
    expect(md).toContain("[transcript](executions/run-1-abc12345.md)");
  });

  it("notes an unavailable transcript next to the run", () => {
    const md = buildIssueExportMarkdown(
      makeInput({ agentRuns: [run], executions: [{ run, error: "transcript unavailable" }] }),
    );
    expect(md).toContain("transcript unavailable (transcript unavailable)");
  });
});
