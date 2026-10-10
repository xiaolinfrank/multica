// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { CockpitUnconfirmedWriteError } from "../cockpit/errors";
const facts = { issue_id: "issue", issue_number: 12, issue_identifier: "BIO-12", issue_title: "Issue", issue_status: "backlog", position: 9 };
function reply(body: unknown) {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock); return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => vi.unstubAllGlobals());
describe("bounded reference append acknowledgements", () => {
  it("confirms compact purpose edits without accepting a legacy whole-set or mismatched purpose receipt", async () => {
    const receipt = { workspace_id: "ws", meeting_id: "meeting", link: { ...facts, meeting_id: "meeting", role: "", roles: ["preparation", "review"], required_roles: [] } };
    const { client, fetchMock } = reply(receipt);
    await expect(client.setCockpitMeetingIssueRolesCompact("ws", "meeting", "issue", ["review", "preparation"])).resolves.toEqual(receipt.link);
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/roles?response=compact");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "PUT", body: JSON.stringify({ roles: ["review", "preparation"] }) });
    for (const invalid of [{ meeting_id: "meeting", links: [receipt.link] }, { ...receipt, link: { ...receipt.link, roles: ["reference"] } }]) {
      await expect(reply(invalid).client.setCockpitMeetingIssueRolesCompact("ws", "meeting", "issue", ["review", "preparation"])).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });
  it("uses one POST and a single scoped link without replacing an unloaded collection", async () => {
    const node = { workspace_id: "ws", node_id: "node", link: { ...facts, id: "link", node_id: "node" } };
    const first = reply(node);
    await expect(first.client.appendCockpitNodeIssue("ws", "node", "issue")).resolves.toEqual(node.link);
    expect(first.fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", headers: { "X-Workspace-ID": "ws" }, body: JSON.stringify({ issue_id: "issue" }) });
    const meeting = { workspace_id: "ws", meeting_id: "meeting", link: { ...facts, meeting_id: "meeting", role: "", roles: ["minutes"], required_roles: ["minutes"] } };
    await expect(reply(meeting).client.appendCockpitMeetingIssue("ws", "meeting", "issue")).resolves.toEqual(meeting.link);
    const meetingNode = { workspace_id: "ws", meeting_id: "meeting", link: { meeting_id: "meeting", node_id: "node", position: 8 } };
    await expect(reply(meetingNode).client.appendCockpitMeetingNode("ws", "meeting", "node")).resolves.toEqual(meetingNode.link);
  });
  it("rejects old whole-set responses, other scopes and defaulted relationship facts", async () => {
    const valid = { workspace_id: "ws", meeting_id: "meeting", link: { ...facts, meeting_id: "meeting", role: "", roles: [], required_roles: [] } };
    for (const body of [{ meeting_id: "meeting", links: [valid.link] }, { ...valid, workspace_id: "other" }, { ...valid, meeting_id: "other" },
      { ...valid, link: { ...valid.link, issue_id: "other" } }, { ...valid, link: { ...valid.link, roles: undefined } }]) {
      await expect(reply(body).client.appendCockpitMeetingIssue("ws", "meeting", "issue")).rejects.toBeInstanceOf(CockpitUnconfirmedWriteError);
    }
  });
});
