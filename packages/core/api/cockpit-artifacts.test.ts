// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./client";
import { artifactFixture, artifactVersionDetailFixture, artifactVersionFixture, acceptanceFixture, ARTIFACT_SUBMISSION_KEY } from "../cockpit/artifact-test-fixtures";

const scope = { project_id: "project-1", module_id: null, node_id: null, source_issue_id: null, q: "", status: "" };
const page = () => ({ workspace_id: "ws-1", scope, items: [artifactFixture()], total: 1, filtered_total: 1, next_cursor: null, can_create: true });
function reply(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return { client: new ApiClient("https://example.test"), fetchMock };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("artifact API scopes and fixed response boundaries", () => {
  it("requests one workspace-scoped page and verifies the complete requested filter scope", async () => {
    const body = page();
    const { client, fetchMock } = reply(body);
    await expect(client.getCockpitArtifacts("ws-1", { project_id: "project-1", page_size: 25 })).resolves.toEqual(body);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(new URL(url).pathname).toBe("/api/cockpit/artifacts");
    expect(new URL(url).searchParams.get("page_size")).toBe("25");
    expect(new Headers(options.headers).get("X-Workspace-ID")).toBe("ws-1");
  });

  it("refuses wrong workspace, project and nested pin scopes instead of returning a misleading list", async () => {
    for (const body of [
      { ...page(), workspace_id: "other" },
      { ...page(), scope: { ...scope, project_id: "other" } },
      { ...page(), scope: { ...scope, q: "different filter" } },
      { ...page(), items: [artifactFixture({ workspace_id: "other" })] },
      { ...page(), items: [artifactFixture({ current_version: artifactVersionFixture({ artifact_id: "other" }) })] },
      { ...page(), total: -1 },
    ]) {
      const { client } = reply(body);
      await expect(client.getCockpitArtifacts("ws-1", { project_id: "project-1" })).resolves.toBeNull();
    }
  });

  it("enforces the requested page size as well as the absolute version history limit", async () => {
    const { client } = reply({ ...page(), total: 2, filtered_total: 2, items: [artifactFixture(), artifactFixture()] });
    await expect(client.getCockpitArtifacts("ws-1", { project_id: "project-1", page_size: 1 })).resolves.toBeNull();
    const history = { workspace_id: "ws-1", artifact_id: "artifact-1", artifact_revision: 2, total: 26, next_cursor: null,
      items: Array.from({ length: 26 }, () => artifactVersionFixture()) };
    await expect(reply(history).client.getCockpitArtifactVersions("ws-1", "artifact-1", { page_size: 25 })).resolves.toBeNull();
  });

  it("keeps a replay's exact historical version and sends text without trimming its bytes", async () => {
    const content = "# Fixed report\r\nEvidence  \n";
    const result = { workspace_id: "ws-1", artifact: artifactFixture({ current_version: artifactVersionFixture({ id: "version-2", version_number: 2 }), version_count: 2 }),
      version: artifactVersionDetailFixture({ content }) };
    const { client, fetchMock } = reply(result, 202);
    await expect(client.submitCockpitArtifactVersion("ws-1", "artifact-1", { expected_revision: 1, submission_key: ARTIFACT_SUBMISSION_KEY, payload: { kind: "text", content } })).resolves.toEqual(result);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).payload.content).toBe(content);
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("X-Workspace-ID")).toBe("ws-1");
  });

  it("does not return another request or node from an acceptance detail route", async () => {
    const result = acceptanceFixture();
    await expect(reply(result).client.getCockpitAcceptanceRequest("ws-1", "node-1", "acceptance-1")).resolves.toEqual(result);
    await expect(reply(result).client.getCockpitAcceptanceRequest("ws-1", "node-2", "acceptance-1")).resolves.toBeNull();
    await expect(reply(result).client.getCockpitAcceptanceRequest("ws-1", "node-1", "acceptance-2")).resolves.toBeNull();
  });

  it("accepts only a fresh link for the exact artifact version, excluding executable and unrelated relative URLs", async () => {
    const link = { workspace_id: "ws-1", artifact_id: "artifact-1", version_id: "version-1", url: "https://storage.example.test/fixed-file?signature=test", expires_at: new Date(Date.now() + 60_000).toISOString() };
    await expect(reply(link).client.getCockpitArtifactDownloadLink("ws-1", "artifact-1", "version-1")).resolves.toEqual(link);
    for (const patch of [{ url: "javascript:alert(1)" }, { url: "//other.example/file" }, { url: "https://user:secret@example.test/file" },
      { url: "/api/cockpit/artifacts/other/versions/version-1/download?signature=test" }, { version_id: "version-2" }, { expires_at: "2000-01-01T00:00:00Z" }]) {
      await expect(reply({ ...link, ...patch }).client.getCockpitArtifactDownloadLink("ws-1", "artifact-1", "version-1")).resolves.toBeNull();
    }
  });

  it("keeps attachment choices bounded to one artifact source and search", async () => {
    const body = { workspace_id: "ws-1", artifact_id: "artifact-1", source_issue_id: "source-1", q: "report", items: [
      { id: "attachment-1", source_issue_id: "source-1", filename: "report.pdf", content_type: "application/pdf", size_bytes: 100, created_at: "2026-10-10T00:00:00Z" },
    ], total: 10, filtered_total: 1, next_cursor: null };
    await expect(reply(body).client.getCockpitArtifactSourceAttachments("ws-1", "artifact-1", { q: "report" })).resolves.toEqual(body);
    await expect(reply({ ...body, q: "another" }).client.getCockpitArtifactSourceAttachments("ws-1", "artifact-1", { q: "report" })).resolves.toBeNull();
    await expect(reply({ ...body, items: [{ ...body.items[0], source_issue_id: "other" }] }).client.getCockpitArtifactSourceAttachments("ws-1", "artifact-1", { q: "report" })).resolves.toBeNull();
  });
});
