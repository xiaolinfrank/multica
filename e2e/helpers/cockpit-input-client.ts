import { createHash, randomUUID } from "node:crypto";
import { TestApiClient } from "../fixtures";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || `http://localhost:${process.env.PORT || "8080"}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface InputReferencePage {
  workspace_id: string; meeting_id: string; agenda_id: string | null; total: number; page_size: number; next_cursor: string | null;
  items: Array<{ id: string; input_id: string; agenda_id: string | null; version: { id: string; capture_state: string } }>;
  summary: { total: number; ready: number; pending: number; needs_attention: number };
}

/** All setup and teardown stays attached to an explicitly created TestApiClient
 * workspace. No existing workspace or business meeting can be adopted. */
export class CockpitInputTestClient {
  readonly api = new TestApiClient();
  private workspace: { id: string; slug: string } | null = null;
  private meetingIds = new Set<string>();
  async createWorkspace(run: string, nas = false) {
    if (this.workspace) throw new Error("Input E2E may own only one workspace");
    const workspace = nas
      ? await this.api.createNASFixtureWorkspace(`输入资料验收 ${run}`, `e2e-input-${run}`)
      : await this.api.createWorkspace(`输入资料验收 ${run}`, `e2e-input-${run}`);
    this.workspace = workspace; return workspace;
  }
  async createMeeting(title: string) {
    if (!this.workspace) throw new Error("Owned workspace required");
    const meeting = await this.api.createCockpitMeeting({ title, meet_date: new Date().toISOString().slice(0, 10) });
    this.meetingIds.add(meeting.id); return meeting;
  }
  private async request(path: string, body?: Record<string, unknown>, method = "GET") {
    if (!this.workspace || !this.api.getToken() || !path.startsWith("/api/cockpit/")) throw new Error("Owned input fixture scope required");
    const response = await fetch(`${API_BASE}${path}`, { method, headers: { Authorization: `Bearer ${this.api.getToken()}`, "X-Workspace-ID": this.workspace.id, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`Owned input fixture ${method} ${path}: ${response.status} ${await response.text()}`);
    const result = await response.json();
    if (result.workspace_id !== this.workspace.id) throw new Error("Input fixture workspace mismatch");
    return result;
  }
  async capabilities() { return this.request("/api/cockpit/inputs/capabilities"); }
  async references(meetingId: string, agendaId?: string): Promise<InputReferencePage> {
    if (!this.meetingIds.has(meetingId) || agendaId && !uuid.test(agendaId)) throw new Error("Owned meeting and exact agenda required");
    const result = await this.request(`/api/cockpit/meetings/${meetingId}${agendaId ? `/agenda/${agendaId}` : ""}/input-references?page_size=100`);
    if (result.meeting_id !== meetingId || result.agenda_id !== (agendaId || null)) throw new Error("Input reference scope mismatch");
    return result;
  }
  async reference(meetingId: string, versionId: string, agendaId: string) {
    if (!this.meetingIds.has(meetingId) || !uuid.test(versionId) || !uuid.test(agendaId)) throw new Error("Exact owned reference required");
    return this.request(`/api/cockpit/meetings/${meetingId}/input-references`, { command_key: randomUUID(), agenda_id: agendaId, input_version_id: versionId, purpose: "material" }, "POST");
  }
  async input(inputId: string) {
    if (!uuid.test(inputId)) throw new Error("Exact input required");
    const result = await this.request(`/api/cockpit/inputs/${inputId}`);
    if (result.id !== inputId) throw new Error("Input header mismatch"); return result;
  }
  async version(inputId: string, versionId: string) {
    if (![inputId, versionId].every((value) => uuid.test(value))) throw new Error("Exact input version required");
    const result = await this.request(`/api/cockpit/inputs/${inputId}/versions/${versionId}`);
    if (result.input_id !== inputId || result.version.id !== versionId) throw new Error("Input version mismatch");
    return result;
  }
  async manifest(issueId: string) {
    if (!uuid.test(issueId)) throw new Error("Exact manifest Issue required");
    const result = await this.request(`/api/cockpit/issues/${issueId}/input-manifest`);
    if (result.issue?.id !== issueId) throw new Error("Input manifest Issue mismatch"); return result;
  }
  async assertCopy(inputId: string, versionId: string, bytes: Buffer) {
    const result = await this.version(inputId, versionId);
    if (result.version.capture_state !== "ready" || result.version.content_hash !== createHash("sha256").update(bytes).digest("hex") || result.version.size_bytes !== bytes.length) throw new Error("Fixed copy does not match uploaded bytes");
    return result;
  }
  async cleanup() {
    if (this.workspace) { await this.api.cleanupCreatedWorkspace(); this.workspace = null; this.meetingIds.clear(); }
  }
}
