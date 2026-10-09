/**
 * TestApiClient — lightweight API helper for E2E test data setup/teardown.
 *
 * Uses raw fetch so E2E tests have zero build-time coupling to the web app.
 */

import "./env";
import pg from "pg";

// `||` (not `??`) so an empty `NEXT_PUBLIC_API_URL=` in .env still falls
// back to localhost. dotenv sets unset-vs-empty both as "" — treating them
// the same matches user intent.
const API_BASE = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || "8080"}`;
// Defaults to the test database, never the deployment's own. E2E setup and
// teardown write directly through this pool, so an unset DATABASE_URL must not
// silently resolve to a live database — see scripts/ensure-test-db.sh.
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://multica:multica@localhost:5432/multica_test?sslmode=disable";

interface TestWorkspace {
  id: string;
  name: string;
  slug: string;
}

export interface TestCockpitNode {
  id: string;
  parent_id: string | null;
  project_id: string | null;
  module_id: string | null;
  code: string;
  name: string;
}

export interface TestCockpitMeeting {
  id: string;
  code: string;
  title: string;
}

export interface TestCockpitBoard {
  nodes: TestCockpitNode[];
  meetings: TestCockpitMeeting[];
  meeting_issues: Array<{ meeting_id: string; issue_id: string; role: string; roles: string[] }>;
}

export interface TestMeetingWorkflowIssue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  assignee_type: string | null;
  assignee_id: string | null;
}

export interface TestMeetingMinutesVersion {
  id: string;
  version_number: number;
  submission_key: string;
  content: string;
  content_hash: string;
  source_issue_id: string;
  review_issue: TestMeetingWorkflowIssue;
  reviewer_id: string;
  decision: "pending" | "approved" | "changes_requested" | "rejected";
  feedback: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  published_by: string | null;
  published_at: string | null;
}

export interface TestMeetingWorkflow {
  enabled: boolean;
  meeting_id: string;
  revision: number;
  ended_at: string | null;
  materials_ready: boolean;
  released_at: string | null;
  release_task_id: string | null;
  reviewer_id: string | null;
  minutes_issue: TestMeetingWorkflowIssue | null;
  current_version_id: string | null;
  published_version_id: string | null;
  versions: TestMeetingMinutesVersion[];
  can_manage: boolean;
  can_submit: boolean;
  can_review: boolean;
  can_publish: boolean;
  can_reassign_reviewer: boolean;
  reviewer_handoffs: Array<{
    id: string; handoff_key: string; from_reviewer_id: string; to_reviewer_id: string;
    from_reviewer_name?: string; to_reviewer_name?: string; created_by_name?: string;
    version_id: string | null; from_review_issue: TestMeetingWorkflowIssue | null;
    to_review_issue: TestMeetingWorkflowIssue | null; reason: string; created_by: string; revision: number;
  }>;
}

export type TestIssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

export type TestIssuePriority = "urgent" | "high" | "medium" | "low" | "none";

export interface TestTableIssueSeed {
  title: string;
  status?: TestIssueStatus;
  priority?: TestIssuePriority;
  parentIssueId?: string | null;
  position?: number;
}

export interface TestTableIssue {
  id: string;
  title: string;
  status: TestIssueStatus;
  number: number;
}

export class TestApiClient {
  private token: string | null = null;
  private workspaceSlug: string | null = null;
  private workspaceId: string | null = null;
  private email: string | null = null;
  private createdIssueIds: string[] = [];
  private createdProjectIds: string[] = [];
  private createdModuleIds: string[] = [];
  private createdCockpitNodeIds: string[] = [];
  private createdCockpitMeetingIds: string[] = [];
  private createdWorkspaceIds: string[] = [];
  private seededIssueIds: string[] = [];

  async login(email: string, name: string) {
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      // Keep each E2E login isolated so previous test runs do not trip the
      // per-email send-code rate limit.
      await client.query("DELETE FROM verification_code WHERE email = $1", [email]);

      // Step 1: Send verification code
      const sendRes = await fetch(`${API_BASE}/auth/send-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!sendRes.ok) {
        throw new Error(`send-code failed: ${sendRes.status}`);
      }

      // Step 2: Read code from database
      const result = await client.query(
        "SELECT code FROM verification_code WHERE email = $1 AND used = FALSE AND expires_at > now() ORDER BY created_at DESC LIMIT 1",
        [email],
      );
      if (result.rows.length === 0) {
        throw new Error(`No verification code found for ${email}`);
      }

      const configuredDevCode = process.env.MULTICA_DEV_VERIFICATION_CODE?.trim();
      const code = configuredDevCode || result.rows[0].code;

      // Step 3: Verify code to get JWT
      const verifyRes = await fetch(`${API_BASE}/auth/verify-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (!verifyRes.ok) {
        throw new Error(`verify-code failed: ${verifyRes.status}`);
      }
      const data = await verifyRes.json();

      this.token = data.token;
      this.email = email;

      // Update user name if needed
      if (name && data.user?.name !== name) {
        await this.authedFetch("/api/me", {
          method: "PATCH",
          body: JSON.stringify({ name }),
        });
      }

      await client.query("DELETE FROM verification_code WHERE email = $1", [email]);

      return data;
    } finally {
      await client.end();
    }
  }

  async getWorkspaces(): Promise<TestWorkspace[]> {
    const res = await this.authedFetch("/api/workspaces");
    return res.json();
  }

  setWorkspaceId(id: string) {
    this.workspaceId = id;
  }

  setWorkspaceSlug(slug: string) {
    this.workspaceSlug = slug;
  }

  /** Create an isolated workspace, never fall back to a user's existing one. */
  async createWorkspace(name: string, slug: string): Promise<TestWorkspace> {
    const res = await this.authedFetch("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, slug }),
    });
    if (!res.ok) {
      throw new Error(`create workspace failed: ${res.status} ${await res.text()}`);
    }
    const workspace = (await res.json()) as TestWorkspace;
    this.workspaceId = workspace.id;
    this.workspaceSlug = workspace.slug;
    this.createdWorkspaceIds.push(workspace.id);
    return workspace;
  }

  async ensureWorkspace(name = "E2E Workspace", slug = "e2e-workspace") {
    const workspaces = await this.getWorkspaces();
    const workspace = workspaces.find((item) => item.slug === slug) ?? workspaces[0];
    if (workspace) {
      this.workspaceId = workspace.id;
      this.workspaceSlug = workspace.slug;
      return workspace;
    }

    const res = await this.authedFetch("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ name, slug }),
    });
    if (res.ok) {
      const created = (await res.json()) as TestWorkspace;
      this.workspaceId = created.id;
      this.workspaceSlug = created.slug;
      return created;
    }

    const refreshed = await this.getWorkspaces();
    const created = refreshed.find((item) => item.slug === slug) ?? refreshed[0];
    if (created) {
      this.workspaceId = created.id;
      this.workspaceSlug = created.slug;
      return created;
    }

    throw new Error(`Failed to ensure workspace ${slug}: ${res.status} ${res.statusText}`);
  }

  async markUserOnboarded() {
    if (!this.email) {
      throw new Error("Cannot mark E2E user onboarded before login");
    }

    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      const result = await client.query(
        `
          UPDATE "user"
          SET
            onboarded_at = COALESCE(onboarded_at, now()),
            onboarding_questionnaire = COALESCE(onboarding_questionnaire, '{}'::jsonb)
              || '{"source":["friends_colleagues"],"source_other":null,"source_skipped":false}'::jsonb
          WHERE email = $1
        `,
        [this.email],
      );
      if (result.rowCount !== 1) {
        throw new Error(`Failed to mark E2E user onboarded: ${this.email}`);
      }
    } finally {
      await client.end();
    }
  }

  /** Create a project and register it for cleanup. */
  async createProject(title: string, opts?: Record<string, unknown>) {
    const res = await this.authedFetch("/api/projects", {
      method: "POST",
      body: JSON.stringify({ title, ...opts }),
    });
    if (!res.ok) {
      throw new Error(`create project failed: ${res.status} ${await res.text()}`);
    }
    const project = await res.json();
    this.createdProjectIds.push(project.id);
    return project as { id: string; title: string; status: string };
  }

  async updateProject(id: string, updates: Record<string, unknown>) {
    const res = await this.authedFetch(`/api/projects/${id}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      throw new Error(`update project failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  async deleteProject(id: string) {
    await this.authedFetch(`/api/projects/${id}`, { method: "DELETE" });
  }

  async createModule(projectId: string, title: string) {
    const res = await this.authedFetch("/api/modules", {
      method: "POST",
      body: JSON.stringify({ project_id: projectId, title }),
    });
    if (!res.ok) throw new Error(`create module failed: ${res.status} ${await res.text()}`);
    const { module } = (await res.json()) as { module: { id: string; project_id: string; title: string } };
    if (!module?.id) throw new Error("create module returned no module identity");
    this.createdModuleIds.push(module.id);
    return module;
  }

  async createCockpitNode(body: {
    code: string;
    name: string;
    parent_id?: string;
    project_id?: string;
    module_id?: string;
    start_date?: string;
    end_date?: string;
  }): Promise<TestCockpitNode> {
    const res = await this.authedFetch("/api/cockpit/nodes", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`create cockpit node failed: ${res.status} ${await res.text()}`);
    const node = (await res.json()) as TestCockpitNode;
    this.createdCockpitNodeIds.push(node.id);
    return node;
  }

  async createCockpitMeeting(body: { title: string; meet_date: string }): Promise<TestCockpitMeeting> {
    const res = await this.authedFetch("/api/cockpit/meetings", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`create cockpit meeting failed: ${res.status} ${await res.text()}`);
    const meeting = (await res.json()) as TestCockpitMeeting;
    this.createdCockpitMeetingIds.push(meeting.id);
    return meeting;
  }

  async linkCockpitNodeIssue(nodeId: string, issueId: string) {
    const res = await this.authedFetch(`/api/cockpit/nodes/${encodeURIComponent(nodeId)}/issues`, {
      method: "PUT",
      body: JSON.stringify({ issue_ids: [issueId] }),
    });
    if (!res.ok) throw new Error(`link cockpit node failed: ${res.status} ${await res.text()}`);
  }

  async linkCockpitMeetingIssue(meetingId: string, issueId: string) {
    const res = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/issues`, {
      method: "PUT",
      body: JSON.stringify({ issue_ids: [issueId] }),
    });
    if (!res.ok) throw new Error(`link cockpit meeting failed: ${res.status} ${await res.text()}`);
  }

  async getCockpitBoard(): Promise<TestCockpitBoard> {
    const res = await this.authedFetch("/api/cockpit");
    if (!res.ok) throw new Error(`get cockpit failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async getMeetingWorkflow(meetingId: string): Promise<TestMeetingWorkflow> {
    const res = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow`);
    if (!res.ok) throw new Error(`get meeting workflow failed: ${res.status} ${await res.text()}`);
    const workflow = (await res.json()) as TestMeetingWorkflow;
    if (workflow.meeting_id !== meetingId || typeof workflow.enabled !== "boolean") {
      throw new Error("meeting workflow response did not identify the requested meeting");
    }
    return workflow;
  }

  /** Establish a real pending review through the API for handover scenarios. */
  async seedPendingMeetingReview(meetingId: string, reviewerId: string, content: string): Promise<TestMeetingWorkflow> {
    const base = `/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow`;
    const write = async (suffix: string, method: "POST" | "PATCH", body: object) => {
      const response = await this.authedFetch(base + suffix, { method, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`seed meeting review failed: ${response.status} ${await response.text()}`);
      return this.getMeetingWorkflow(meetingId);
    };
    let workflow = await write("", "POST", { reviewer_id: reviewerId });
    workflow = await write("", "PATCH", { expected_revision: workflow.revision, ended: true, materials_ready: true });
    workflow = await write("/release", "POST", { expected_revision: workflow.revision });
    return write("/versions", "POST", { expected_revision: workflow.revision, submission_key: crypto.randomUUID(), content });
  }

  async createIssue(title: string, opts?: Record<string, unknown>) {
    const res = await this.authedFetch("/api/issues", {
      method: "POST",
      body: JSON.stringify({ title, ...opts }),
    });
    if (!res.ok) {
      throw new Error(`create issue failed: ${res.status} ${await res.text()}`);
    }
    const issue = await res.json();
    this.createdIssueIds.push(issue.id);
    return issue;
  }

  /**
   * Insert a large, deterministic issue fixture in one transaction.
   *
   * Browser E2E coverage for cursor-backed Table views needs 1,000+ rows,
   * which would make setup itself dominate the test if every row went through
   * the HTTP create endpoint. These rows intentionally contain no dependent
   * records; cleanup deletes exactly the returned IDs from the isolated E2E
   * workspace.
   */
  async seedTableIssues(rows: TestTableIssueSeed[]): Promise<TestTableIssue[]> {
    if (rows.length === 0) return [];
    if (!this.workspaceId || !this.email) {
      throw new Error("Cannot seed table issues before login and workspace setup");
    }

    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      await client.query("BEGIN");
      const userResult = await client.query<{ id: string }>(
        `SELECT id FROM "user" WHERE email = $1`,
        [this.email],
      );
      const creatorId = userResult.rows[0]?.id;
      if (!creatorId) {
        throw new Error(`Cannot resolve E2E creator for ${this.email}`);
      }

      const counterResult = await client.query<{ issue_counter: number }>(
        `
          UPDATE workspace
          SET issue_counter = issue_counter + $2
          WHERE id = $1
          RETURNING issue_counter
        `,
        [this.workspaceId, rows.length],
      );
      const finalCounter = Number(counterResult.rows[0]?.issue_counter);
      if (!Number.isFinite(finalCounter)) {
        throw new Error(`Cannot reserve issue numbers for workspace ${this.workspaceId}`);
      }
      const firstNumber = finalCounter - rows.length + 1;

      const inserted = await client.query<TestTableIssue>(
        `
          INSERT INTO issue (
            workspace_id,
            title,
            status,
            priority,
            creator_type,
            creator_id,
            parent_issue_id,
            position,
            number
          )
          SELECT
            $1::uuid,
            fixture.title,
            fixture.status,
            fixture.priority,
            'member',
            $2::uuid,
            fixture.parent_issue_id,
            fixture.position,
            fixture.number
          FROM unnest(
            $3::text[],
            $4::text[],
            $5::text[],
            $6::uuid[],
            $7::double precision[],
            $8::integer[]
          ) WITH ORDINALITY AS fixture(
            title,
            status,
            priority,
            parent_issue_id,
            position,
            number,
            ordinal
          )
          ORDER BY fixture.ordinal
          RETURNING id, title, status, number
        `,
        [
          this.workspaceId,
          creatorId,
          rows.map((row) => row.title),
          rows.map((row) => row.status ?? "backlog"),
          rows.map((row) => row.priority ?? "none"),
          rows.map((row) => row.parentIssueId ?? null),
          rows.map((row, index) => row.position ?? index + 1),
          rows.map((_row, index) => firstNumber + index),
        ],
      );
      await client.query("COMMIT");
      this.seededIssueIds.push(...inserted.rows.map((row) => row.id));
      return inserted.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
  }

  async deleteIssue(id: string) {
    await this.authedFetch(`/api/issues/${id}`, { method: "DELETE" });
  }

  async createComment(issueId: string, content: string) {
    const res = await this.authedFetch(`/api/issues/${issueId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      throw new Error(`create comment failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as { id: string };
  }

  /** Adds an existing user to this client's workspace and returns the member id. */
  async addMemberByEmail(email: string, role: "admin" | "member" = "member"): Promise<string> {
    if (!this.workspaceId) throw new Error("Cannot add a member before a workspace is selected");
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      const result = await client.query(
        `INSERT INTO member (workspace_id, user_id, role)
         SELECT $1, id, $3 FROM "user" WHERE email = $2
         RETURNING id`,
        [this.workspaceId, email, role],
      );
      if (result.rowCount !== 1) throw new Error(`No user with email ${email}`);
      return result.rows[0].id as string;
    } finally {
      await client.end();
    }
  }

  async removeMember(memberId: string) {
    const res = await this.authedFetch(`/api/workspaces/${this.workspaceId}/members/${memberId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      throw new Error(`remove member failed: ${res.status} ${await res.text()}`);
    }
  }

  /** Deletes this client's workspace; only for workspaces a test created. */
  async deleteWorkspace() {
    if (!this.workspaceId) return;
    await this.authedFetch(`/api/workspaces/${this.workspaceId}`, { method: "DELETE" });
  }

  /**
   * Workflows protect their meeting and issues from individual deletion.
   * Delete their entire isolated fixture workspace through its atomic API.
   * Never accept ensureWorkspace's existing-workspace fallback here.
   */
  async cleanupCreatedWorkspace() {
    if (!this.workspaceId || this.createdWorkspaceIds.length !== 1 || this.createdWorkspaceIds[0] !== this.workspaceId) {
      throw new Error("Refusing cleanup: current workspace was not this client's only explicitly created workspace");
    }
    const res = await this.authedFetch(`/api/workspaces/${encodeURIComponent(this.workspaceId)}`, { method: "DELETE" });
    if (res.status !== 204) {
      throw new Error(`cleanup owned workspace failed: ${res.status} ${await res.text()}`);
    }
    this.createdCockpitMeetingIds = [];
    this.createdCockpitNodeIds = [];
    this.createdIssueIds = [];
    this.createdModuleIds = [];
    this.createdProjectIds = [];
    this.seededIssueIds = [];
    this.createdWorkspaceIds = [];
    this.workspaceId = null;
    this.workspaceSlug = null;
  }

  /** Server-side issue search, for comparing against what the UI shows. */
  async searchIssues(q: string, opts: { includeClosed?: boolean; limit?: number } = {}) {
    const params = new URLSearchParams({ q, limit: String(opts.limit ?? 20) });
    if (opts.includeClosed) params.set("include_closed", "true");
    const res = await this.authedFetch(`/api/issues/search?${params}`);
    if (!res.ok) {
      throw new Error(`search issues failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as { issues: { id: string; identifier: string; title: string }[] };
  }

  async updateIssue(id: string, updates: Record<string, unknown>) {
    const res = await this.authedFetch(`/api/issues/${id}`, {
      method: "PUT",
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      throw new Error(`update issue failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  /** Remove only tracked fixtures, from cockpit relations down to their workspace. */
  async cleanup() {
    const cleanupErrors: Error[] = [];
    const removeTrackedFixture = async (path: string, kind: string) => {
      try {
        const res = await this.authedFetch(path, { method: "DELETE" });
        if (!res.ok && res.status !== 404) {
          throw new Error(`cleanup ${kind} failed: ${res.status} ${await res.text()}`);
        }
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    };
    // Bound nodes must disappear before their mapped projects/modules. The
    // fixture creates parents first, so reverse order removes leaves first.
    for (const id of this.createdCockpitMeetingIds) {
      await removeTrackedFixture(`/api/cockpit/meetings/${encodeURIComponent(id)}`, "meeting");
    }
    this.createdCockpitMeetingIds = [];
    for (const id of [...this.createdCockpitNodeIds].reverse()) {
      await removeTrackedFixture(`/api/cockpit/nodes/${encodeURIComponent(id)}`, "cockpit node");
    }
    this.createdCockpitNodeIds = [];
    if (this.seededIssueIds.length > 0 && this.workspaceId) {
      const client = new pg.Client(DATABASE_URL);
      await client.connect();
      try {
        await client.query(
          `DELETE FROM issue WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
          [this.workspaceId, this.seededIssueIds],
        );
      } finally {
        await client.end();
      }
      this.seededIssueIds = [];
    }
    for (const id of this.createdIssueIds) {
      try {
        await this.deleteIssue(id);
      } catch {
        /* ignore — may already be deleted */
      }
    }
    this.createdIssueIds = [];
    for (const id of this.createdModuleIds) {
      await removeTrackedFixture(`/api/modules/${encodeURIComponent(id)}`, "module");
    }
    this.createdModuleIds = [];
    // Projects last: an issue delete leaves no project reference behind, and
    // dropping the project first would strand the issues in the list.
    for (const id of this.createdProjectIds) {
      try {
        await this.deleteProject(id);
      } catch {
        /* ignore — may already be deleted */
      }
    }
    this.createdProjectIds = [];
    for (const id of this.createdWorkspaceIds) {
      await removeTrackedFixture(`/api/workspaces/${encodeURIComponent(id)}`, "workspace");
    }
    this.createdWorkspaceIds = [];
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, `E2E fixture cleanup failed: ${cleanupErrors.map((error) => error.message).join("; ")}`);
    }
  }

  getToken() {
    return this.token;
  }

  getEmail() {
    if (!this.email) {
      throw new Error("Test API client is not logged in");
    }
    return this.email;
  }

  private async authedFetch(path: string, init?: RequestInit) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string>) ?? {}),
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (this.workspaceSlug) headers["X-Workspace-Slug"] = this.workspaceSlug;
    else if (this.workspaceId) headers["X-Workspace-ID"] = this.workspaceId;
    return fetch(`${API_BASE}${path}`, { ...init, headers });
  }
}
