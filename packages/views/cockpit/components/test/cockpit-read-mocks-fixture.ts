import { vi, type Mock } from "vitest";
import type { CockpitBoard, MemberWithUser, CockpitTask } from "@multica/core/types";
import type { ApiClient } from "@multica/core/api/client";
import { cockpitContextFixture, cockpitPlanFixture, cockpitNodeDetailFixture, cockpitMeetingDetailFixture, cockpitMeetingRegisterFixture } from "../cockpit-read-test-fixture";

/** Legacy scenario data is split into independent read responses, not fetched through the old API. */
export const readCockpitFixture = vi.fn<() => Promise<CockpitBoard>>();
export const readCockpitMembersFixture = vi.fn<() => Promise<MemberWithUser[]>>();
const role = async () => (await readCockpitMembersFixture()).find((member) => member.user_id === "user-1")?.role ?? "member";
type CockpitReadMockKey = "getCockpitContext" | "getCockpitPlan" | "getCockpitNodeDetail" | "getCockpitMeetingDetail" | "getCockpitMeetingRegister" | "getCockpitPlanMeetingMarkers" | "getCockpitNodeTasks" | "searchCockpitScopeMembers" | "searchCockpitScopes" | "searchCockpitScopeNodes" | "getCockpitMeetingNextCode" | "getCockpitNodeIndex" | "getCockpitNodeCodePreview" | "getCockpitNodePayments" | "getCockpitNodeMeetings" | "getCockpitMeetingIssues" | "getCockpitMeetingNodes" | "appendCockpitNodeIssue" | "appendCockpitMeetingIssue" | "appendCockpitMeetingNode" | "setCockpitMeetingIssueRolesCompact" | "searchCockpitAssignees" | "getCockpitDirectoryPage" | "upsertCockpitDirectoryCompact" | "deleteCockpitDirectoryCompact" | "listCockpitChangePage" | "listCockpitSnapshotPage" | "getCockpitChangePreview" | "applyReviewedCockpitChange";
export function makeCockpitReadApiMocks(): { [Key in CockpitReadMockKey]: Mock<ApiClient[Key]> } {
  return {
    getCockpitContext: vi.fn<ApiClient["getCockpitContext"]>().mockImplementation(async (_ws, scope) => { const value = cockpitContextFixture(await readCockpitFixture(), scope); return { ...value, actor: { ...value.actor, role: await role() } }; }),
    getCockpitPlan: vi.fn<ApiClient["getCockpitPlan"]>().mockImplementation(async (_ws, scope) => { const value = cockpitPlanFixture(await readCockpitFixture(), scope); return { ...value, actor: { ...value.actor, role: await role() } }; }),
    getCockpitNodeDetail: vi.fn<ApiClient["getCockpitNodeDetail"]>().mockImplementation(async (_ws, id, scope) => cockpitNodeDetailFixture(await readCockpitFixture(), id, scope)),
    getCockpitMeetingDetail: vi.fn<ApiClient["getCockpitMeetingDetail"]>().mockImplementation(async (_ws, id, scope) => cockpitMeetingDetailFixture(await readCockpitFixture(), id, scope)),
    getCockpitMeetingRegister: vi.fn<ApiClient["getCockpitMeetingRegister"]>().mockImplementation(async (_ws, scope, query) => cockpitMeetingRegisterFixture(await readCockpitFixture(), scope, query)),
    getCockpitPlanMeetingMarkers: vi.fn<ApiClient["getCockpitPlanMeetingMarkers"]>().mockImplementation(async (_ws, scope, query) => ({ workspace_id: "ws-1", scope: cockpitContextFixture(await readCockpitFixture(), scope).scope, ...query, groups: [], total_groups: 0, next_cursor: null })),
    getCockpitNodeTasks: vi.fn<ApiClient["getCockpitNodeTasks"]>().mockImplementation(async (nodeId, params = {}) => {
      const board = await readCockpitFixture(); const detail = cockpitNodeDetailFixture(board, nodeId);
      const links = params.relation === "reference" ? board.issue_links.filter((link) => link.node_id === nodeId) : [];
      const all: CockpitTask[] = links.map((link) => ({ id: link.issue_id, identifier: link.issue_identifier, title: link.issue_title, status: link.issue_status, status_category: "unknown", priority: "none", assignee_type: null, assignee_id: null, assignee_name: "", due_date: null,
        project_id: null, module_id: null, primary_node_id: null, primary_node_code: "", primary_node_name: "", primary_revision: 0, creation_key: null }));
      const offset = Number(params.cursor || 0), pageSize = params.page_size ?? 25;
      return { node_id: nodeId, items: all.slice(offset, offset + pageSize), total: all.length, filtered_total: all.length, next_cursor: offset + pageSize < all.length ? String(offset + pageSize) : null,
        summary: { total: all.length, by_status: [], by_category: { unstarted: 0, started: 0, done: 0, closed: 0, unknown: all.length }, done: 0, closed: 0, unknown: all.length }, eligibility: detail.binding };
    }),
    searchCockpitScopeMembers: vi.fn<ApiClient["searchCockpitScopeMembers"]>().mockImplementation(async (_ws, query = {}) => {
      const values = (await readCockpitMembersFixture()).filter((member) => !query.ids?.length || query.ids.includes(member.user_id));
      return { workspace_id: "ws-1", scope: { q: query.q ?? "", ids: query.ids ?? [] }, items: values.map((member) => ({ id: member.user_id, title: member.name, avatar_url: member.avatar_url ?? "", role: member.role })), total: values.length, filtered_total: values.length, next_cursor: null };
    }),
    searchCockpitScopes: vi.fn<ApiClient["searchCockpitScopes"]>().mockImplementation(async (_ws, _kind, query) => ({ workspace_id: "ws-1", project_id: query?.project_id ?? null, items: [], total: 0, next_cursor: null })),
    searchCockpitScopeNodes: vi.fn<ApiClient["searchCockpitScopeNodes"]>().mockImplementation(async (_ws, params = {}) => {
      const board = await readCockpitFixture(); const values = board.nodes.map((node) => { const detail = cockpitNodeDetailFixture(board, node.id); return { id: node.id, title: node.name, code: node.code, ...detail.binding }; }).filter((node) => params.eligible === false || node.eligible);
      return { workspace_id: "ws-1", scope: { project_id: params.project_id ?? null, module_id: params.module_id ?? null, q: params.q ?? "", eligible: params.eligible !== false }, items: values.slice(0, 20), total: values.length, filtered_total: values.length, next_cursor: null };
    }),
    getCockpitMeetingNextCode: vi.fn<ApiClient["getCockpitMeetingNextCode"]>().mockImplementation(async (wsId, date) => ({ workspace_id: wsId, date, code: "M-0001" })),
    getCockpitNodeIndex: vi.fn<ApiClient["getCockpitNodeIndex"]>().mockImplementation(async (wsId) => { const board = await readCockpitFixture(); return { workspace_id: wsId, items: board.nodes, total: board.nodes.length }; }),
    getCockpitNodeCodePreview: vi.fn<ApiClient["getCockpitNodeCodePreview"]>().mockImplementation(async (wsId, parentId) => ({ workspace_id: wsId, parent_id: parentId, code: parentId ? "L3-02-01" : "L1-01" })), getCockpitNodePayments: vi.fn(), getCockpitNodeMeetings: vi.fn(), getCockpitMeetingIssues: vi.fn(), getCockpitMeetingNodes: vi.fn(),
    searchCockpitAssignees: vi.fn<ApiClient["searchCockpitAssignees"]>().mockImplementation(async (wsId, query = {}) => {
      const items = (await readCockpitMembersFixture()).filter((person) => !query.selected_id || query.selected_id === person.user_id).map((person) => ({ id: person.user_id, type: "member" as const, title: person.name, email: person.email ?? "", avatar_url: person.avatar_url ?? "", status: "active", runtime_bound: null, can_assign: true, reason: "" }));
      return { workspace_id: wsId, q: query.q ?? "", kind: query.kind ?? "all", selected_type: query.selected_type ?? null, selected_id: query.selected_id ?? null, items, total: items.length, next_cursor: null };
    }),
    getCockpitDirectoryPage: vi.fn<ApiClient["getCockpitDirectoryPage"]>().mockImplementation(async (wsId, query = {}) => ({ workspace_id: wsId, scope: "workspace", q: query.q ?? "", party: query.party ?? null, parties: query.parties ?? null, items: [], total: 0, next_cursor: null })),
    upsertCockpitDirectoryCompact: vi.fn(), deleteCockpitDirectoryCompact: vi.fn(), getCockpitChangePreview: vi.fn(), applyReviewedCockpitChange: vi.fn(),
    listCockpitChangePage: vi.fn<ApiClient["listCockpitChangePage"]>().mockImplementation(async (wsId, scope, query = {}) => ({ workspace_id: wsId, scope: cockpitContextFixture(await readCockpitFixture(), scope).scope, q: query.q ?? "", status: query.status ?? "all", items: [], total: 0, next_cursor: null, counts: { pending: 0, decided: 0 } })),
    listCockpitSnapshotPage: vi.fn<ApiClient["listCockpitSnapshotPage"]>().mockImplementation(async (wsId, query = {}) => ({ workspace_id: wsId, scope: "workspace", q: query.q ?? "", items: [], total: 0, next_cursor: null })),
    appendCockpitNodeIssue: vi.fn(), appendCockpitMeetingIssue: vi.fn(), appendCockpitMeetingNode: vi.fn(), setCockpitMeetingIssueRolesCompact: vi.fn(),
  };
}
