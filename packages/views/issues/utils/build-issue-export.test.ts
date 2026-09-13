// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { Attachment, Issue, TimelineEntry } from "@multica/core/types";
import {
  buildIssueExportMarkdown,
  issueExportFilename,
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

function makeInput(overrides: Partial<IssueExportInput> = {}): IssueExportInput {
  return {
    issue: makeIssue(),
    timeline: [],
    attachments: [],
    childIssues: [],
    statusLabel: "To do",
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

describe("buildIssueExportMarkdown", () => {
  it("renders the front matter with escaped scalars", () => {
    const md = buildIssueExportMarkdown(
      makeInput({
        issue: makeIssue({ title: 'A "quoted" title' }),
      }),
    );
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain('title: "A \\"quoted\\" title"');
    expect(md).toContain('multica_export: "issue"');
    expect(md).toContain('identifier: "MUL-1"');
    expect(md).toContain('status: "todo"');
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
          labels: [
            { id: "l1", name: "bug", color: "#f00" },
          ] as Issue["labels"],
        }),
        assigneeName: "Mika",
        creatorName: "Alice",
        projectName: "Platform",
        parentIdentifier: "MUL-0",
      }),
    );
    expect(md).toContain("- **Status**: To do");
    expect(md).toContain("- **Priority**: medium");
    expect(md).toContain("- **Assignee**: Mika (agent)");
    expect(md).toContain("- **Creator**: Alice (member)");
    expect(md).toContain("- **Start date**: 2026-09-01");
    expect(md).toContain("- **Due date**: 2026-09-30");
    expect(md).toContain("- **Project**: Platform");
    expect(md).toContain("- **Parent**: MUL-0");
    expect(md).toContain("- **Labels**: bug");
    expect(md).toContain("- **Created**: 2025-01-01T00:00:00Z");
    expect(md).toContain("- **Updated**: 2025-01-02T00:00:00Z");
  });

  it("shows Unassigned when there is no assignee", () => {
    const md = buildIssueExportMarkdown(makeInput());
    expect(md).toContain("- **Assignee**: Unassigned");
  });

  it("embeds the description verbatim", () => {
    const description = "## Steps\n\n1. do a thing\n\n```go\nfmt.Println(1)\n```";
    const md = buildIssueExportMarkdown(
      makeInput({ issue: makeIssue({ description }) }),
    );
    expect(md).toContain("## Description");
    expect(md).toContain(description);
  });

  it("omits empty sections entirely", () => {
    const md = buildIssueExportMarkdown(makeInput());
    expect(md).not.toContain("## Description");
    expect(md).not.toContain("## Timeline");
    expect(md).not.toContain("## Sub-issues");
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
        reactions: [{ id: "r1", comment_id: "c-1", actor_type: "member", actor_id: "u-2", emoji: "👍", created_at: "2025-01-01T01:05:00Z" }],
      },
      {
        type: "comment",
        id: "c-2",
        actor_type: "agent",
        actor_id: "ag-1",
        actor_name: "Mika",
        content: "A reply",
        parent_id: "c-1",
        resolved_at: "2025-01-01T03:00:00Z",
        created_at: "2025-01-01T02:00:00Z",
        attachments: [makeAttachment({ id: "a-2", filename: "log.txt", size_bytes: 10 })],
      },
    ];
    const md = buildIssueExportMarkdown(makeInput({ timeline }));
    expect(md).toContain("## Timeline");
    expect(md).toContain("#### 2025-01-01T01:00:00Z · Alice (member) · comment");
    expect(md).toContain("First comment");
    expect(md).toContain("#### 2025-01-01T02:00:00Z · Mika (agent) · reply · resolved");
    expect(md).toContain("- reaction: 👍");
    expect(md).toContain("- [log.txt](/api/attachments/a-1/download) (10 B)");
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

  it("lists sub-issues with identifier and status key", () => {
    const md = buildIssueExportMarkdown(
      makeInput({
        childIssues: [
          makeIssue({ id: "i-2", number: 2, identifier: "MUL-2", title: "Child", status: "done" }),
        ],
      }),
    );
    expect(md).toContain("## Sub-issues");
    expect(md).toContain("- MUL-2 — Child [done]");
  });

  it("prefers markdown_url over url for attachments and formats sizes", () => {
    const md = buildIssueExportMarkdown(
      makeInput({
        attachments: [
          makeAttachment({ markdown_url: "/durable/report.pdf" }),
          makeAttachment({ id: "a-3", filename: "big.bin", markdown_url: "", size_bytes: 5 * 1024 * 1024 }),
        ],
      }),
    );
    expect(md).toContain("- [report.pdf](/durable/report.pdf) (1.5 KB)");
    // An empty markdown_url (older server) falls back to the raw url.
    expect(md).toContain("- [big.bin](/raw/report.pdf)");
    expect(md).toContain("5 MB");
  });
});
