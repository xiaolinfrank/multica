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
export interface TestDirectoryOperation {
  workspace_id: string; meeting_id: string; id: string; state: string; revision: number; command_key: string;
  target: { directory: string; root_id: string }; counts: { total: number; satisfied: number; needs_attention: number };
}
export interface TestDirectoryStep { id: string; operation_id: string; kind: string; label: string; relative_path: string; state: string; outcome: string | null; attempt_count: number }

export interface TestArtifactVersion {
  id: string; version_number: number; revision: number; producer_issue_id: string; content_hash: string | null;
  capture_status: string; decision: string; reviewer_id: string; review_issue: { id: string; status: string } | null;
  payload_kind: string; source_attachment_id: string | null; size_bytes: number | null;
}
export interface TestOwnedAttachment { id: string; workspace_id: string; issue_id: string; filename: string; content_type: string; size_bytes: number }
export interface TestArtifactHeader {
  id: string; node_id: string; source_issue: { id: string }; producer_issue: { id: string }; revision: number;
  workspace_id: string; title: string; description: string;
  current_version: TestArtifactVersion | null; approved_version: TestArtifactVersion | null;
}
export interface TestArtifactVersionDetail { artifact_id: string; version: TestArtifactVersion; content: string | null; feedback: string; content_available: boolean }
export interface TestAcceptanceRequest {
  id: string; revision: number; decision: string; criteria_revision: number; reviewer_id: string; review_issue: { id: string; status: string };
}
export interface TestAcceptanceHeader { node_id: string; criteria_revision: number; current_request: TestAcceptanceRequest | null; last_approved_request: TestAcceptanceRequest | null }

export interface TestCockpitBoard {
  nodes: TestCockpitNode[];
  meetings: TestCockpitMeeting[];
  issue_links: Array<{ node_id: string; issue_id: string }>;
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

export interface TestCockpitTask extends TestMeetingWorkflowIssue {
  status_category: string;
  project_id: string | null;
  module_id: string | null;
  primary_node_id: string | null;
  primary_revision: number;
  due_date: string | null;
}

export interface TestCockpitTaskPage {
  node_id: string;
  items: TestCockpitTask[];
  total: number;
  filtered_total: number;
  next_cursor: string | null;
  summary: { total: number; done: number; closed: number; unknown: number; by_category: Record<string, number> };
  eligibility: { eligible: boolean; reason: string; project_id: string | null; module_id: string | null };
}

export interface TestMeetingAction {
  id: string;
  meeting_id: string;
  version_id: string;
  title: string;
  status: string;
  resolution: string | null;
  revision: number;
  decision_key: string | null;
  node_id: string | null;
  issue: TestCockpitTask | null;
  reason: string;
}

export interface TestMeetingActionPage {
  meeting_id: string;
  items: TestMeetingAction[];
  total: number;
  filtered_total: number;
  next_cursor: string | null;
  can_add: boolean;
}

export interface TestCockpitAttentionItem {
  id: string;
  kind: string;
  reason: string;
  title: string;
  flags: string[];
  created_at: string;
  responsibility: string;
  assignee_type: string | null;
  assignee_id: string | null;
  can_act: boolean;
  target: { kind: string; id: string; meeting_id: string | null; version_id: string | null; node_id: string | null; issue_id: string | null; action_id: string | null };
}

export interface TestCockpitAttentionPage {
  workspace_id: string;
  project_id: string | null;
  as_of: string;
  view: string;
  kind: string;
  items: TestCockpitAttentionItem[];
  total: number;
  next_cursor: string | null;
}

export interface TestCockpitWorkOverview {
  workspace_id: string;
  project_id: string | null;
  project_title: string;
  as_of: string;
  summary: {
    primary_issues: { total: number; active: number; done: number; closed: number; unknown: number; overdue: number; blocked: number };
    my_primary_issues: { total: number; active: number; done: number; closed: number; unknown: number };
    execution_nodes: { total: number; with_active_issues: number };
    attention: { team_total: number; mine_total: number; team_by_kind: Record<string, number>; mine_by_kind: Record<string, number> };
  };
  attention: TestCockpitAttentionPage;
  execution_nodes: { items: Array<{ id: string; project_id: string; name: string }>; total: number; next_cursor: string | null };
  recent_meetings: { items: Array<{ id: string; title: string }>; total: number; next_cursor: string | null; range_start: string; range_end: string };
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
  nas_destination: { root_id: string; directory: string; write_mode?: string } | null;
  nas_unavailable_reason: string;
  can_export_nas: boolean;
  nas_exports: Array<{
    id: string; version_id: string; version_number: number; source_issue_id: string;
    content_hash: string; root_id: string; directory: string; target_path: string;
    size_bytes: number | null; status: string; attempts: number; revision: number;
    next_retry_at: string | null; completed_at: string | null; last_error_code: string;
    last_error: string; can_retry: boolean; write_mode?: string; verified_path?: string | null;
    receipt_path?: string | null; verified_attempt_id?: string | null; verified_at?: string | null;
  }>;
  reviewer_handoffs: Array<{
    id: string; handoff_key: string; from_reviewer_id: string; to_reviewer_id: string;
    from_reviewer_name?: string; to_reviewer_name?: string; created_by_name?: string;
    version_id: string | null; from_review_issue: TestMeetingWorkflowIssue | null;
    to_review_issue: TestMeetingWorkflowIssue | null; reason: string; created_by: string; revision: number;
  }>;
}

export interface TestMinutesMetadata extends Omit<TestMeetingMinutesVersion, "content" | "feedback"> {
  has_feedback: boolean;
}

export interface TestWorkflowSummary extends Omit<TestMeetingWorkflow, "versions" | "reviewer_handoffs" | "nas_exports"> {
  representation: "summary";
  workspace_id: string;
  current_version: TestMinutesMetadata | null;
  published_version: TestMinutesMetadata | null;
  published_nas_export: (TestMeetingWorkflow["nas_exports"][number] & { source_version: TestMinutesMetadata }) | null;
  history_counts: { versions: number; reviewer_handoffs: number; nas_exports: number; nas_active: number };
}

export interface TestWorkflowHistoryPage<T> {
  workspace_id: string;
  meeting_id: string;
  workflow_revision: number;
  items: T[];
  total: number;
  next_cursor: string | null;
}

export interface TestMinutesDetail {
  workspace_id: string;
  meeting_id: string;
  workflow_revision: number;
  version: TestMeetingMinutesVersion;
  can_review: boolean;
  can_publish: boolean;
  can_export_nas: boolean;
}

export interface TestWorkflowCompactCommand {
  representation: "compact";
  workspace_id: string;
  meeting_id: string;
  workflow: TestWorkflowSummary;
  receipt: {
    action: string;
    version: TestMeetingMinutesVersion | null;
    handoff: (TestMeetingWorkflow["reviewer_handoffs"][number] & { version_number: number | null }) | null;
    nas_export: (TestMeetingWorkflow["nas_exports"][number] & { source_version: TestMinutesMetadata }) | null;
  };
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
  /** Stored custom or unknown keys are valid compatibility fixtures too. */
  status?: string;
  priority?: TestIssuePriority;
  parentIssueId?: string | null;
  position?: number;
  projectId?: string;
  moduleId?: string;
  assigneeId?: string;
  dueDate?: string;
}

export interface TestTableIssue {
  id: string;
  title: string;
  status: TestIssueStatus;
  number: number;
}

export interface TestMeetingLifecycle {
  workspace_id: string; meeting_id: string; lifecycle_revision: number; agenda_revision: number; workflow_enabled: boolean;
  occurrence: { state: string; ended_at: string | null; actual_started_at: string | null; actual_ended_at: string | null; ended_source: string | null };
  materials: { ready: boolean; workflow_revision: number } | null;
  archive?: { archived_at: string | null; archived_by: string | null; reason: string };
}
export interface TestPreparationOperation {
  workspace_id: string; meeting_id: string; id: string; kind: string; state: string; revision: number;
  counts: { total: number; applied: number; pending: number; needs_attention: number; skipped: number };
}
export interface TestPreparationEffect {
  id: string; operation_id: string; kind: string; label: string; state: string; command_key: string;
  authorization_key: string; authorization_revision: number;
  receipt: { issue_id: string | null; agenda_id: string | null; reference_id: string | null; command_key: string } | null;
}
export interface TestMeetingAgendaItem {
  id: string; workspace_id: string; meeting_id: string; revision: number; title: string; purposes: string[]; desired_outcome?: string; notes?: string;
}
export interface TestMeetingLifecycleCommand {
  workspace_id: string; meeting_id: string; command_key: string; action: string; replayed: boolean; current: TestMeetingLifecycle;
  receipt: { agenda_id: string | null; reference_id: string | null; issue_id: string | null; agenda: TestMeetingAgendaItem | null };
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
  private ownedAttachmentIssues = new Map<string, { issueId: string; workspaceId: string }>();

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

  /** Seed the fresh UUID explicitly allowed by the isolated NAS test server. */
  async createNASFixtureWorkspace(name: string, slug: string): Promise<TestWorkspace> {
    const id = process.env.MULTICA_E2E_NAS_WORKSPACE_ID;
    const database = decodeURIComponent(new URL(DATABASE_URL).pathname.slice(1));
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      || !database.endsWith("_test") || !this.email || this.workspaceId) {
      throw new Error("NAS fixture requires a fresh configured UUID, a test database, and an authenticated owner without a workspace");
    }
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    let workspace: TestWorkspace;
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [this.email]);
      if (owner.rows.length !== 1) throw new Error("NAS fixture owner does not exist");
      // INSERT must fail if the configured UUID already exists. Never adopt or
      // replace an existing workspace, even after an interrupted test run.
      const inserted = await client.query<TestWorkspace>(
        "INSERT INTO workspace (id, name, slug, issue_prefix) VALUES ($1, $2, $3, 'NAS') RETURNING id, name, slug",
        [id, name, slug],
      );
      await client.query("INSERT INTO member (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [id, owner.rows[0]!.id]);
      workspace = inserted.rows[0]!;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      await client.end();
    }
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

  async createCockpitMeeting(body: { title: string; meet_date: string; nas_dir?: string; note?: string; parties?: string }): Promise<TestCockpitMeeting> {
    const res = await this.authedFetch("/api/cockpit/meetings", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`create cockpit meeting failed: ${res.status} ${await res.text()}`);
    const meeting = (await res.json()) as TestCockpitMeeting;
    this.createdCockpitMeetingIds.push(meeting.id);
    return meeting;
  }

  private assertOwnedMeeting(meetingId: string) {
    if (!this.workspaceId || !this.createdWorkspaceIds.includes(this.workspaceId) || !this.createdCockpitMeetingIds.includes(meetingId)) throw new Error("Meeting lifecycle fixture requires an owned meeting and workspace");
  }

  async getOwnedDirectoryOperation(meetingId: string, operationId: string): Promise<TestDirectoryOperation> {
    this.assertOwnedMeeting(meetingId);
    if (!/^[0-9a-f-]{36}$/i.test(operationId)) throw new Error("Directory operation requires an exact UUID");
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/directory-preparations/${operationId}`);
    if (!response.ok) throw new Error(`Directory operation read failed: ${response.status} ${await response.text()}`);
    const data = await response.json() as TestDirectoryOperation;
    if (data.workspace_id !== this.workspaceId || data.meeting_id !== meetingId || data.id !== operationId) throw new Error("Directory operation scope mismatch");
    return data;
  }

  async getOwnedDirectorySteps(meetingId: string, operationId: string): Promise<{ workspace_id: string; meeting_id: string; operation_id: string; items: TestDirectoryStep[]; total: number }> {
    this.assertOwnedMeeting(meetingId);
    if (!/^[0-9a-f-]{36}$/i.test(operationId)) throw new Error("Directory steps require an exact operation UUID");
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/directory-preparations/${operationId}/steps`);
    if (!response.ok) throw new Error(`Directory steps read failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    if (data.workspace_id !== this.workspaceId || data.meeting_id !== meetingId || data.operation_id !== operationId || data.total > 32) throw new Error("Directory step scope or bound mismatch");
    return data;
  }

  /** Seed a legitimate custom plan only inside the explicitly owned local directory fixture. */
  async seedOwnedDirectoryPlan(meetingId: string, rootId: string, relativeDirectory: string, partitions: string[]): Promise<string> {
    this.assertOwnedMeeting(meetingId);
    if (process.env.MULTICA_E2E_REAL_NAS === "1" || rootId !== process.env.MULTICA_E2E_NAS_ROOT_ID
      || this.workspaceId !== process.env.MULTICA_E2E_NAS_WORKSPACE_ID
      || !/^directory-e2e\/directory-e2e-[A-Za-z0-9]+\/[^/\\]+$/.test(relativeDirectory)
      || relativeDirectory.split("/").some((part) => part === "." || part === "..")) throw new Error("Custom directory plan must remain in the owned local fixture boundary");
    const base = `/api/cockpit/meetings/${encodeURIComponent(meetingId)}`;
    const summaryResponse = await this.authedFetch(`${base}/directory-preparation`);
    if (!summaryResponse.ok) throw new Error(`Directory summary read failed: ${summaryResponse.status}`);
    const summary = await summaryResponse.json();
    if (summary.workspace_id !== this.workspaceId || summary.meeting_id !== meetingId) throw new Error("Directory summary scope mismatch");
    const body = { mode: "prepare", root_id: rootId, relative_directory: relativeDirectory, partitions, observed_nas_dir: summary.binding.nas_dir,
      observed_binding_revision: summary.binding.revision, bind_after_base: false };
    const previewResponse = await this.authedFetch(`${base}/directory-preparations/preview`, { method: "POST", body: JSON.stringify(body) });
    if (!previewResponse.ok) throw new Error(`Custom directory preview failed: ${previewResponse.status} ${await previewResponse.text()}`);
    const preview = await previewResponse.json();
    if (!preview.can_confirm || preview.workspace_id !== this.workspaceId || preview.meeting_id !== meetingId || preview.target.root_id !== rootId
      || preview.target.relative_directory !== relativeDirectory || preview.target.directory !== summary.binding.nas_dir) throw new Error("Custom directory preview did not confirm the owned target");
    const commandKey = crypto.randomUUID();
    const response = await this.authedFetch(`${base}/directory-preparations`, { method: "POST", body: JSON.stringify({ ...body, command_key: commandKey, expected_revision: summary.binding.revision, context_token: preview.context_token }) });
    if (!response.ok) throw new Error(`Custom directory registration failed: ${response.status} ${await response.text()}`);
    const result = await response.json();
    if (result.workspace_id !== this.workspaceId || result.meeting_id !== meetingId || result.command_key !== commandKey || !/^[0-9a-f-]{36}$/i.test(result.receipt?.directory_operation_id ?? "")) throw new Error("Custom directory receipt scope mismatch");
    return result.receipt.directory_operation_id;
  }

  async getOwnedMeetingLifecycle(meetingId: string): Promise<TestMeetingLifecycle> {
    this.assertOwnedMeeting(meetingId);
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/lifecycle`);
    if (!response.ok) throw new Error(`Meeting lifecycle read failed: ${response.status} ${await response.text()}`);
    const data = await response.json() as TestMeetingLifecycle;
    if (data.workspace_id !== this.workspaceId || data.meeting_id !== meetingId) throw new Error("Meeting lifecycle scope mismatch");
    return data;
  }

  async getOwnedMeetingAgenda(meetingId: string, query: Record<string, string | number> = {}): Promise<{ workspace_id: string; meeting_id: string; agenda_revision: number; items: TestMeetingAgendaItem[]; total: number; next_cursor: string | null }> {
    this.assertOwnedMeeting(meetingId); const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/agenda?${params}`);
    if (!response.ok) throw new Error(`Meeting agenda read failed: ${response.status} ${await response.text()}`);
    const data = await response.json(); if (data.workspace_id !== this.workspaceId || data.meeting_id !== meetingId) throw new Error("Meeting agenda scope mismatch");
    return data;
  }

  async getOwnedPreparationOperation(meetingId: string, operationId: string): Promise<TestPreparationOperation> {
    this.assertOwnedMeeting(meetingId);
    if (!/^[0-9a-f-]{36}$/i.test(operationId)) throw new Error("Preparation operation requires an exact UUID");
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/preparation-operations/${operationId}`);
    if (!response.ok) throw new Error(`Preparation operation read failed: ${response.status} ${await response.text()}`);
    const data = await response.json() as TestPreparationOperation;
    if (data.workspace_id !== this.workspaceId || data.meeting_id !== meetingId || data.id !== operationId) throw new Error("Preparation operation scope mismatch");
    return data;
  }

  async getOwnedPreparationEffects(meetingId: string, operationId: string, cursor?: string): Promise<{ workspace_id: string; meeting_id: string; operation_id: string; items: TestPreparationEffect[]; total: number; next_cursor: string | null }> {
    this.assertOwnedMeeting(meetingId);
    if (!/^[0-9a-f-]{36}$/i.test(operationId)) throw new Error("Preparation effects require an exact operation UUID");
    const params = new URLSearchParams({ page_size: "25" }); if (cursor) params.set("cursor", cursor);
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/preparation-operations/${operationId}/effects?${params}`);
    if (!response.ok) throw new Error(`Preparation effect read failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    if (data.workspace_id !== this.workspaceId || data.meeting_id !== meetingId || data.operation_id !== operationId) throw new Error("Preparation effect scope mismatch");
    return data;
  }

  async getOwnedMeetingOperationBasis(meetingId: string): Promise<{ workspace_id: string; meeting_id: string; availability: string; delete: { state: string; reason_codes: string[] }; cancel: { state: string; reason_codes: string[] }; archive: { state: string; reason_codes: string[] } }> {
    this.assertOwnedMeeting(meetingId);
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/operation-basis`);
    if (!response.ok) throw new Error(`Meeting operation basis read failed: ${response.status} ${await response.text()}`);
    const data = await response.json();
    if (data.workspace_id !== this.workspaceId || data.meeting_id !== meetingId) throw new Error("Meeting operation basis scope mismatch");
    return data;
  }

  async ownedMeetingLifecycleCommand(meetingId: string, suffix: string, body: Record<string, unknown>, method: "POST" | "PATCH" = "POST"): Promise<TestMeetingLifecycleCommand> {
    this.assertOwnedMeeting(meetingId);
    if (!/^\/(?:lifecycle\/(?:occurrence|materials)|agenda(?:\/[0-9a-f-]{36}(?:\/preparation-issues)?)?)$/.test(suffix)) throw new Error("Unsupported owned lifecycle fixture command");
    if (suffix.endsWith("/preparation-issues") && method !== "POST") throw new Error("Preparation issue fixture requires creation");
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}${suffix}`, { method, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Meeting lifecycle fixture command failed: ${response.status} ${await response.text()}`);
    const data = await response.json() as TestMeetingLifecycleCommand;
    if (data.workspace_id !== this.workspaceId || data.meeting_id !== meetingId || data.command_key !== body.command_key) throw new Error("Meeting lifecycle command acknowledgement mismatch");
    return data;
  }

  async seedCockpitProposals(changes: Array<{ node: string; field: string; new_value: string; reason?: string }>) {
    if (!this.workspaceId || !this.createdWorkspaceIds.includes(this.workspaceId) || changes.some((change) => !this.createdCockpitNodeIds.includes(change.node))) throw new Error("Proposal fixture must reference only this client's nodes");
    const response = await this.authedFetch("/api/cockpit/changes/ingest", { method: "POST", body: JSON.stringify({ changes }) });
    if (!response.ok) throw new Error(`Proposal fixture failed: ${response.status} ${await response.text()}`);
    const result = await response.json();
    if (result.results?.length !== changes.length || result.results.some((row: { status: string }) => row.status !== "queued")) throw new Error("Proposal fixture did not queue every change");
  }
  async patchOwnedCockpitNode(nodeId: string, patch: { progress?: number; owner?: string; name?: string; code?: string; budget_amount?: number; exec_status?: string; collaborators?: string }) {
    if (!this.createdCockpitNodeIds.includes(nodeId)) throw new Error("Node mutation requires fixture ownership");
    const response = await this.authedFetch(`/api/cockpit/nodes/${encodeURIComponent(nodeId)}`, { method: "PATCH", body: JSON.stringify(patch) });
    if (!response.ok) throw new Error(`Node fixture patch failed: ${response.status} ${await response.text()}`);
    const node = await response.json(); if (node.id !== nodeId) throw new Error("Node fixture patch identity mismatch");
    return node;
  }
  async createOwnedCockpitMilestone(nodeId: string, name: string, planDate: string, actualDate: string | null = null) {
    if (!this.workspaceId || !this.createdWorkspaceIds.includes(this.workspaceId) || !this.createdCockpitNodeIds.includes(nodeId)) throw new Error("Milestone fixture requires this client's workspace and node");
    const response = await this.authedFetch("/api/cockpit/milestones", { method: "POST", body: JSON.stringify({ node_id: nodeId, name, plan_date: planDate, actual_date: actualDate, status: "" }) });
    if (!response.ok) throw new Error(`Milestone fixture failed: ${response.status} ${await response.text()}`);
    const milestone = await response.json();
    if (!milestone.id || milestone.node_id !== nodeId || milestone.name !== name) throw new Error("Milestone fixture identity mismatch");
    return milestone;
  }

  async getOwnedCockpitNode(nodeId: string) {
    if (!this.createdCockpitNodeIds.includes(nodeId)) throw new Error("Node read requires fixture ownership");
    const response = await this.authedFetch(`/api/cockpit/nodes/${encodeURIComponent(nodeId)}`);
    if (!response.ok) throw new Error(`Node fixture read failed: ${response.status}`);
    const detail = await response.json(); if (detail.node?.id !== nodeId) throw new Error("Node fixture read identity mismatch");
    return detail.node;
  }

  async deleteOwnedCockpitNode(nodeId: string) {
    if (!this.createdCockpitNodeIds.includes(nodeId)) throw new Error("Node deletion requires fixture ownership");
    const response = await this.authedFetch(`/api/cockpit/nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Node fixture deletion failed: ${response.status} ${await response.text()}`);
  }

  async saveOwnedCockpitSnapshot(label: string): Promise<{ id: string; label: string; node_count: number }> {
    if (!this.workspaceId || !this.createdWorkspaceIds.includes(this.workspaceId)) throw new Error("Snapshot requires fixture workspace ownership");
    const response = await this.authedFetch("/api/cockpit/snapshots", { method: "POST", body: JSON.stringify({ label }) });
    if (!response.ok) throw new Error(`Snapshot fixture save failed: ${response.status} ${await response.text()}`);
    const result = await response.json();
    if (typeof result.id !== "string" || result.label !== label || !Number.isInteger(result.node_count)) throw new Error("Snapshot fixture identity was not confirmed");
    return result;
  }

  async getOwnedCockpitMeetingRegister() {
    if (!this.workspaceId || !this.createdWorkspaceIds.includes(this.workspaceId)) throw new Error("Meeting register read requires fixture ownership");
    const response = await this.authedFetch("/api/cockpit/meetings?page_size=25");
    if (!response.ok) throw new Error(`Meeting register fixture read failed: ${response.status}`);
    const page = await response.json(); if (page.workspace_id !== this.workspaceId) throw new Error("Meeting register fixture scope mismatch");
    return page;
  }

  async seedCockpitDirectory(entries: Array<{ party: string; name: string; position?: string }>) {
    if (!this.workspaceId || !this.createdWorkspaceIds.includes(this.workspaceId)) throw new Error("Directory fixtures require a workspace created by this client");
    const response = await this.authedFetch("/api/cockpit/directory?response=compact", { method: "PUT", body: JSON.stringify({ entries }) });
    if (!response.ok) throw new Error(`Directory fixture failed: ${response.status} ${await response.text()}`);
    const receipt = await response.json();
    if (receipt.workspace_id !== this.workspaceId || receipt.scope !== "workspace" || receipt.action !== "upserted" || receipt.entries?.length !== entries.length) throw new Error("Directory fixture receipt mismatch");
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

  async appendCockpitMeetingNode(meetingId: string, nodeId: string) {
    if (!this.createdCockpitMeetingIds.includes(meetingId) || !this.createdCockpitNodeIds.includes(nodeId)) throw new Error("Meeting reference fixture must use this client's owned objects");
    const res = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/nodes`, { method: "POST", body: JSON.stringify({ node_id: nodeId }) });
    if (!res.ok) throw new Error(`append meeting node failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    if (body.workspace_id !== this.workspaceId || body.meeting_id !== meetingId || body.link?.meeting_id !== meetingId || body.link?.node_id !== nodeId || body.links) {
      throw new Error("Meeting reference returned no exact single-link receipt");
    }
  }

  async getCockpitTasks(nodeId: string, query: Record<string, string | number> = {}): Promise<TestCockpitTaskPage> {
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    const res = await this.authedFetch(`/api/cockpit/nodes/${encodeURIComponent(nodeId)}/tasks?${params}`);
    if (!res.ok) throw new Error(`get cockpit tasks failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async getCockpitWorkOverview(query: Record<string, string | number> = {}): Promise<TestCockpitWorkOverview> {
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    const response = await this.authedFetch(`/api/cockpit/overview?${params}`);
    if (!response.ok) throw new Error(`get work overview failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  async getCockpitAttention(query: Record<string, string | number> = {}): Promise<TestCockpitAttentionPage> {
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    const response = await this.authedFetch(`/api/cockpit/overview/attention?${params}`);
    if (!response.ok) throw new Error(`get attention page failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  /** Profile the checked-in SELECT for this fixture only; no query result bodies are returned. */
  async explainCockpitAttention(source: string, asOf: string): Promise<Record<string, unknown>> {
    if (!this.workspaceId || !this.email || this.createdWorkspaceIds.length !== 1 || this.createdWorkspaceIds[0] !== this.workspaceId) {
      throw new Error("Read-model profiling requires one explicitly owned test workspace");
    }
    const marker = "-- name: GetCockpitOverviewReadModel :one";
    const parts = source.split(marker);
    if (parts.length !== 2 || parts[1]!.includes("-- name:")) throw new Error("Unexpected overview query inventory");
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const actor = await client.query<{ user_id: string; role: string }>(`SELECT m.user_id,m.role FROM member m JOIN "user" u ON u.id=m.user_id WHERE m.workspace_id=$1 AND u.email=$2`, [this.workspaceId, this.email]);
      if (actor.rows.length !== 1) throw new Error("Profiling actor is not the fixture workspace's member");
      const input: Record<string, unknown> = { workspace_id: this.workspaceId, project_id: null, actor_id: actor.rows[0]!.user_id,
        actor_role: actor.rows[0]!.role, human: true, as_of: asOf, view: "team", kind: "", section: "attention", cursor_key: "", page_size: 25, days: 30 };
      const keys: string[] = [];
      const sql = parts[1]!.replace(/sqlc\.(?:arg|narg)\('([a-z_]+)'\)/g, (_match, key: string) => {
        if (!(key in input)) throw new Error(`Unknown overview query parameter: ${key}`);
        if (!keys.includes(key)) keys.push(key);
        return `$${keys.indexOf(key) + 1}`;
      });
      const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, keys.map((key) => input[key]));
      await client.query("ROLLBACK");
      return result.rows[0]["QUERY PLAN"][0] as Record<string, unknown>;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { await client.end(); }
  }

  async setCockpitPrimaryNode(issueId: string, nodeId: string | null, revision = 0): Promise<{ issue_id: string; node_id: string | null; revision: number }> {
    const res = await this.authedFetch(`/api/cockpit/issues/${encodeURIComponent(issueId)}/primary-node`, {
      method: "PUT", body: JSON.stringify({ node_id: nodeId, expected_revision: revision }),
    });
    if (!res.ok) throw new Error(`set primary node failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async getMeetingActions(meetingId: string, query: Record<string, string | number> = {}): Promise<TestMeetingActionPage> {
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    const res = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow/actions?${params}`);
    if (!res.ok) throw new Error(`get meeting actions failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async createMeetingAction(meetingId: string, versionId: string, body: { title: string; description?: string; source_quote?: string; proposal_key?: string }): Promise<TestMeetingAction> {
    const res = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow/versions/${encodeURIComponent(versionId)}/actions`, {
      method: "POST", body: JSON.stringify({ proposal_key: crypto.randomUUID(), ...body }),
    });
    if (!res.ok) throw new Error(`create meeting action failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async resolveMeetingAction(meetingId: string, actionId: string, body: Record<string, unknown>): Promise<TestMeetingAction> {
    const res = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow/actions/${encodeURIComponent(actionId)}/resolve`, {
      method: "POST", body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`resolve meeting action failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async getWorkspaceAgentRunCount(): Promise<number> {
    if (!this.workspaceId) throw new Error("Cannot count runs without a workspace");
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      const result = await client.query<{ count: string }>("SELECT count(*) FROM agent_task_queue q JOIN issue i ON i.id=q.issue_id WHERE i.workspace_id=$1", [this.workspaceId]);
      return Number(result.rows[0]!.count);
    } finally { await client.end(); }
  }

  async getWorkspaceIssueIdsByTitle(title: string): Promise<string[]> {
    if (!this.workspaceId) throw new Error("Cannot inspect issues without a workspace");
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      const result = await client.query<{ id: string }>("SELECT id FROM issue WHERE workspace_id=$1 AND title=$2 ORDER BY id", [this.workspaceId, title]);
      return result.rows.map((issue) => issue.id);
    } finally { await client.end(); }
  }

  async getCockpitBoard(): Promise<TestCockpitBoard> {
    const res = await this.authedFetch("/api/cockpit");
    if (!res.ok) throw new Error(`get cockpit failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async getCockpitArtifact(artifactId: string): Promise<TestArtifactHeader> {
    const response = await this.authedFetch(`/api/cockpit/artifacts/${encodeURIComponent(artifactId)}`);
    if (!response.ok) throw new Error(`get artifact failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  async createOwnedPendingTextArtifact(nodeId: string, sourceIssueId: string, reviewerId: string): Promise<TestArtifactHeader> {
    if (!this.workspaceId || !this.createdWorkspaceIds.includes(this.workspaceId) || !this.createdCockpitNodeIds.includes(nodeId)
      || !this.createdIssueIds.includes(sourceIssueId)) throw new Error("Artifact fixture must use this client's owned workspace, node and source issue");
    const source = await this.getIssue(sourceIssueId);
    if (source.workspace_id !== this.workspaceId) throw new Error("Artifact source fixture workspace mismatch");
    const created = await this.authedFetch("/api/cockpit/artifacts", { method: "POST", body: JSON.stringify({ creation_key: crypto.randomUUID(), node_id: nodeId, source_issue_id: sourceIssueId, title: "Formal interface evidence", description: "", reviewer_id: reviewerId }) });
    if (!created.ok) throw new Error(`Create owned artifact failed: ${created.status} ${await created.text()}`);
    const artifact: TestArtifactHeader = await created.json();
    if (artifact.workspace_id !== this.workspaceId || artifact.node_id !== nodeId || artifact.source_issue.id !== sourceIssueId || artifact.producer_issue.id !== sourceIssueId) throw new Error("Artifact fixture identity mismatch");
    const submitted = await this.authedFetch(`/api/cockpit/artifacts/${encodeURIComponent(artifact.id)}/versions`, { method: "POST", body: JSON.stringify({ expected_revision: artifact.revision, submission_key: crypto.randomUUID(), producer_issue_id: sourceIssueId, payload: { kind: "text", content: "# Formal interface evidence\n\nA fixed human review fixture." } }) });
    if (!submitted.ok) throw new Error(`Submit owned artifact failed: ${submitted.status} ${await submitted.text()}`);
    return this.getCockpitArtifact(artifact.id);
  }

  async renameOwnedArtifactForLayout(artifactId: string, title: string): Promise<void> {
    if (!this.workspaceId || !this.createdWorkspaceIds.includes(this.workspaceId) || !title || title.length > 500) {
      throw new Error("Artifact layout fixture must belong to this client's created workspace");
    }
    const artifact = await this.getCockpitArtifact(artifactId);
    if (artifact.workspace_id !== this.workspaceId || !this.createdIssueIds.includes(artifact.source_issue.id)) {
      throw new Error("Artifact layout fixture must retain this client's created source issue");
    }
    const response = await this.authedFetch(`/api/cockpit/artifacts/${encodeURIComponent(artifactId)}`, { method: "PATCH",
      body: JSON.stringify({ expected_revision: artifact.revision, title, description: artifact.description }) });
    if (!response.ok) throw new Error(`rename artifact layout fixture failed: ${response.status} ${await response.text()}`);
  }

  async getCockpitArtifactVersion(artifactId: string, versionId: string): Promise<TestArtifactVersionDetail> {
    const response = await this.authedFetch(`/api/cockpit/artifacts/${encodeURIComponent(artifactId)}/versions/${encodeURIComponent(versionId)}`);
    if (!response.ok) throw new Error(`get artifact version failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  async getCockpitAcceptance(nodeId: string): Promise<TestAcceptanceHeader> {
    const response = await this.authedFetch(`/api/cockpit/nodes/${encodeURIComponent(nodeId)}/acceptance`);
    if (!response.ok) throw new Error(`get acceptance failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  async updateCockpitBoard(body: { title?: string; goal_title?: string; goal_date?: string; meeting_project_id?: string; meeting_module_id?: string }): Promise<void> {
    const response = await this.authedFetch("/api/cockpit", { method: "PATCH", body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`update cockpit failed: ${response.status} ${await response.text()}`);
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

  async enableMeetingWorkflow(meetingId: string, body: Record<string, unknown>): Promise<TestMeetingWorkflow> {
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow`, {
      method: "POST", body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`enable workflow failed: ${response.status} ${await response.text()}`);
    return this.getMeetingWorkflow(meetingId);
  }

  async getMeetingWorkflowSummary(meetingId: string): Promise<TestWorkflowSummary> {
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow/summary`);
    if (!response.ok) throw new Error(`get workflow summary failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  async getMeetingMinutesHistory(meetingId: string, query: Record<string, string | number> = {}): Promise<TestWorkflowHistoryPage<TestMinutesMetadata>> {
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow/versions?${params}`);
    if (!response.ok) throw new Error(`get minutes history failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  async getMeetingMinutesDetail(meetingId: string, versionId: string): Promise<TestMinutesDetail> {
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow/versions/${encodeURIComponent(versionId)}`);
    if (!response.ok) throw new Error(`get minutes detail failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  /** Send the real workflow command while retaining its exact response size for E2E assertions. */
  async compactMeetingWorkflowCommand(meetingId: string, suffix: string, body: Record<string, unknown>, method: "POST" | "PATCH" = "POST"):
    Promise<{ data: TestWorkflowCompactCommand; bytes: number; text: string }> {
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow${suffix}?response=compact`, {
      method, body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`compact workflow command failed: ${response.status} ${text}`);
    return { data: JSON.parse(text) as TestWorkflowCompactCommand, bytes: Buffer.byteLength(text, "utf8"), text };
  }

  /** Exercise a test-built Multica CLI using only this fixture's token and private config root. */
  async replayMinutesWithCompactCLI(meetingId: string, submissionKey: string, content: string): Promise<TestWorkflowCompactCommand> {
    const binary = process.env.MULTICA_E2E_CLI_BINARY;
    if (!binary || !binary.startsWith("/") || !this.token || !this.workspaceId
      || this.createdWorkspaceIds.length !== 1 || this.createdWorkspaceIds[0] !== this.workspaceId
      || !decodeURIComponent(new URL(DATABASE_URL).pathname).endsWith("_test")
      || !["127.0.0.1", "localhost"].includes(new URL(API_BASE).hostname)) {
      throw new Error("CLI smoke requires a configured test-built executable and this client's isolated local test workspace");
    }
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = await mkdtemp(join(tmpdir(), "multica-history-cli-"));
    try {
      const filename = join(root, "minutes.md");
      await writeFile(filename, `${content}\n`, { mode: 0o600 });
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["HOME", "PATH", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key];
      Object.assign(env, { MULTICA_TASK_CONFIG_ROOT: join(root, "config"), MULTICA_TOKEN: this.token,
        MULTICA_SERVER_URL: API_BASE, MULTICA_WORKSPACE_ID: this.workspaceId });
      const result = await promisify(execFile)(binary, ["cockpit", "meeting", "workflow", "submit", meetingId, "--revision", "1",
        "--submission-key", submissionKey, "--content-file", filename, "--compact"], { env, cwd: root, maxBuffer: 256 * 1024, timeout: 30_000 });
      return JSON.parse(result.stdout) as TestWorkflowCompactCommand;
    } finally { await rm(root, { recursive: true, force: true }); }
  }

  /** Establish a real pending review through the API for handover scenarios. */
  async seedPendingMeetingReview(meetingId: string, reviewerId: string, content: string, scope: {
    project_id?: string; module_id?: string; node_id?: string;
    assignee_type?: "member" | "agent"; assignee_id?: string;
  } = {}): Promise<TestMeetingWorkflow> {
    const base = `/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow`;
    const write = async (suffix: string, method: "POST" | "PATCH", body: object) => {
      const response = await this.authedFetch(base + suffix, { method, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`seed meeting review failed: ${response.status} ${await response.text()}`);
      return this.getMeetingWorkflow(meetingId);
    };
    let workflow = await write("", "POST", { reviewer_id: reviewerId, ...scope });
    workflow = await write("", "PATCH", { expected_revision: workflow.revision, ended: true, materials_ready: true });
    workflow = await write("/release", "POST", { expected_revision: workflow.revision });
    return write("/versions", "POST", { expected_revision: workflow.revision, submission_key: crypto.randomUUID(), content });
  }

  async approveMeetingMinutes(meetingId: string): Promise<TestMeetingWorkflow> {
    const workflow = await this.getMeetingWorkflow(meetingId);
    if (!workflow.current_version_id) throw new Error("Meeting has no submitted minutes version");
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow/versions/${encodeURIComponent(workflow.current_version_id)}/review`, {
      method: "POST",
      body: JSON.stringify({ expected_revision: workflow.revision, decision: "approved", feedback: "Checked the fixed acceptance evidence." }),
    });
    if (!response.ok) throw new Error(`approve minutes failed: ${response.status} ${await response.text()}`);
    return this.getMeetingWorkflow(meetingId);
  }

  async publishMeetingMinutes(meetingId: string): Promise<TestMeetingWorkflow> {
    const workflow = await this.getMeetingWorkflow(meetingId);
    if (!workflow.current_version_id) throw new Error("Meeting has no submitted minutes version");
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow/versions/${encodeURIComponent(workflow.current_version_id)}/publish`, {
      method: "POST", body: JSON.stringify({ expected_revision: workflow.revision }),
    });
    if (!response.ok) throw new Error(`publish minutes failed: ${response.status} ${await response.text()}`);
    return this.getMeetingWorkflow(meetingId);
  }

  async submitMeetingMinutesVersion(meetingId: string, content: string): Promise<TestMeetingWorkflow> {
    const workflow = await this.getMeetingWorkflow(meetingId);
    const response = await this.authedFetch(`/api/cockpit/meetings/${encodeURIComponent(meetingId)}/workflow/versions`, {
      method: "POST", body: JSON.stringify({ expected_revision: workflow.revision, submission_key: crypto.randomUUID(), content }),
    });
    if (!response.ok) throw new Error(`submit minutes failed: ${response.status} ${await response.text()}`);
    return this.getMeetingWorkflow(meetingId);
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

  /** A small source file belonging only to this client's isolated fixture workspace and issue. */
  async uploadOwnedIssueAttachment(issueId: string, filename: string, content: string): Promise<TestOwnedAttachment> {
    if (!this.token || !this.workspaceId || !this.createdWorkspaceIds.includes(this.workspaceId) || !this.createdIssueIds.includes(issueId)) {
      throw new Error("Attachment fixture must belong to this client's created workspace and issue");
    }
    if (!filename || /[\\/]/.test(filename) || Buffer.byteLength(content, "utf8") > 64 * 1024 || content.length === 0) {
      throw new Error("Attachment fixture must be a named, nonempty UTF-8 file of at most 64 KiB");
    }
    const issue = await this.getIssue(issueId);
    if (issue.id !== issueId || issue.workspace_id !== this.workspaceId) throw new Error("Attachment fixture issue is outside the current fixture workspace");
    const form = new FormData();
    form.append("file", new Blob([content], { type: "text/plain" }), filename);
    form.append("issue_id", issueId);
    const response = await fetch(`${API_BASE}/api/upload-file`, { method: "POST", body: form,
      headers: { Authorization: `Bearer ${this.token}`, "X-Workspace-ID": this.workspaceId } });
    if (!response.ok) throw new Error(`upload owned attachment failed: ${response.status} ${await response.text()}`);
    const attachment = await response.json() as TestOwnedAttachment;
    if (!attachment.id || attachment.workspace_id !== this.workspaceId || attachment.issue_id !== issueId || attachment.filename !== filename) {
      throw new Error("Uploaded attachment did not identify the exact fixture owner and filename");
    }
    this.ownedAttachmentIssues.set(attachment.id, { issueId, workspaceId: this.workspaceId });
    return attachment;
  }

  async deleteOwnedIssueAttachment(attachmentId: string): Promise<void> {
    const owner = this.ownedAttachmentIssues.get(attachmentId);
    if (!this.workspaceId || !this.createdWorkspaceIds.includes(this.workspaceId) || owner?.workspaceId !== this.workspaceId || !this.createdIssueIds.includes(owner.issueId)) {
      throw new Error("Can only delete an attachment uploaded by this fixture client");
    }
    const response = await this.authedFetch(`/api/attachments/${encodeURIComponent(attachmentId)}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`delete owned attachment failed: ${response.status} ${await response.text()}`);
  }

  async getOwnedAttachmentStatus(attachmentId: string): Promise<number> {
    const owner = this.ownedAttachmentIssues.get(attachmentId);
    if (!this.workspaceId || !this.createdWorkspaceIds.includes(this.workspaceId) || owner?.workspaceId !== this.workspaceId || !this.createdIssueIds.includes(owner.issueId)) {
      throw new Error("Can only inspect an attachment uploaded by this fixture client");
    }
    return (await this.authedFetch(`/api/attachments/${encodeURIComponent(attachmentId)}`)).status;
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
            number,
            project_id,
            module_id,
            assignee_type,
            assignee_id,
            due_date
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
            fixture.number,
            fixture.project_id,
            fixture.module_id,
            CASE WHEN fixture.assignee_id IS NOT NULL THEN 'member' ELSE NULL END,
            fixture.assignee_id,
            fixture.due_date
          FROM unnest(
            $3::text[],
            $4::text[],
            $5::text[],
            $6::uuid[],
            $7::double precision[],
            $8::integer[],
            $9::uuid[],
            $10::uuid[],
            $11::uuid[],
            $12::timestamptz[]
          ) WITH ORDINALITY AS fixture(
            title,
            status,
            priority,
            parent_issue_id,
            position,
            number,
            project_id,
            module_id,
            assignee_id,
            due_date,
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
          rows.map((row) => row.projectId ?? null),
          rows.map((row) => row.moduleId ?? null),
          rows.map((row) => row.assigneeId ?? null),
          rows.map((row) => row.dueDate ?? null),
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

  /** Backdate only issues in this client's explicitly created test workspace. */
  async backdateFixtureIssues(issueIds: string[], timestamp: string): Promise<void> {
    if (!this.workspaceId || this.createdWorkspaceIds.length !== 1 || this.createdWorkspaceIds[0] !== this.workspaceId
      || !Number.isFinite(Date.parse(timestamp))) {
      throw new Error("Historical fixtures require an explicitly owned workspace and a valid timestamp");
    }
    const ids = [...new Set(issueIds)];
    if (ids.length === 0) return;
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("UPDATE issue SET created_at=$3::timestamptz,updated_at=$3::timestamptz WHERE workspace_id=$1 AND id=ANY($2::uuid[]) RETURNING id", [this.workspaceId, ids, timestamp]);
      if (result.rowCount !== ids.length) throw new Error("Historical fixture includes an issue outside the owned workspace");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { await client.end(); }
  }

  /** Give one owned workflow realistic old timestamps without changing its state or fixed content. */
  async backdateFixtureMeetingWorkflow(meetingId: string, timestamp: string): Promise<void> {
    if (!this.workspaceId || this.createdWorkspaceIds.length !== 1 || this.createdWorkspaceIds[0] !== this.workspaceId
      || !this.createdCockpitMeetingIds.includes(meetingId) || !Number.isFinite(Date.parse(timestamp))) {
      throw new Error("Historical workflow fixtures require an explicitly owned meeting and a valid timestamp");
    }
    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      await client.query("BEGIN");
      const saved = await client.query(`UPDATE cockpit_meeting_work_package SET created_at=$3::timestamptz,updated_at=$3::timestamptz,
        ended_at=CASE WHEN ended_at IS NOT NULL THEN $3::timestamptz END,
        released_at=CASE WHEN released_at IS NOT NULL THEN $3::timestamptz END
        WHERE workspace_id=$1 AND meeting_id=$2 RETURNING minutes_issue_id`, [this.workspaceId, meetingId, timestamp]);
      if (saved.rowCount !== 1) throw new Error("Historical workflow fixture was not found in the owned workspace");
      await client.query("UPDATE cockpit_meeting SET created_at=$3::timestamptz,updated_at=$3::timestamptz WHERE workspace_id=$1 AND id=$2", [this.workspaceId, meetingId, timestamp]);
      await client.query(`UPDATE cockpit_minutes_version SET created_at=$3::timestamptz,
        reviewed_at=CASE WHEN reviewed_at IS NOT NULL THEN $3::timestamptz END,
        published_at=CASE WHEN published_at IS NOT NULL THEN $3::timestamptz END
        WHERE workspace_id=$1 AND meeting_id=$2`, [this.workspaceId, meetingId, timestamp]);
      await client.query(`UPDATE cockpit_meeting_action SET created_at=$3::timestamptz,updated_at=$3::timestamptz,
        resolved_at=CASE WHEN resolved_at IS NOT NULL THEN $3::timestamptz END
        WHERE workspace_id=$1 AND meeting_id=$2`, [this.workspaceId, meetingId, timestamp]);
      await client.query(`UPDATE issue SET created_at=$3::timestamptz,updated_at=$3::timestamptz WHERE workspace_id=$1
        AND (id=$4::uuid OR id IN (SELECT review_issue_id FROM cockpit_minutes_version WHERE workspace_id=$1 AND meeting_id=$2))`,
      [this.workspaceId, meetingId, timestamp, saved.rows[0].minutes_issue_id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { await client.end(); }
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
  async searchIssues(q: string, opts: { includeClosed?: boolean; limit?: number; offset?: number } = {}) {
    const params = new URLSearchParams({ q, limit: String(opts.limit ?? 20) });
    if (opts.includeClosed) params.set("include_closed", "true");
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
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

  async getIssue(id: string) {
    const res = await this.authedFetch(`/api/issues/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`get issue failed: ${res.status} ${await res.text()}`);
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
