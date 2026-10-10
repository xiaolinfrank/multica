import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test, type Download } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1100 }, locale: "en-US", timezoneId: "Asia/Shanghai", trace: "retain-on-failure" });

async function downloadedBytes(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error("The browser did not retain the fixture download");
  return readFile(path);
}

test("captures an owned attachment into a private fixed version and downloads it after the source is deleted", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const api = new TestApiClient(), run = `${Date.now().toString(36)}-${process.pid}`;
  const reviewerName = `File reviewer ${run}`;
  const auth = await api.login(`e2e-artifact-file-${run}@multica.ai`, reviewerName); let ownsWorkspace = false;
  try {
    const workspace = await api.createWorkspace(`Fixed files ${run}`, `e2e-fixed-file-${run}`); ownsWorkspace = true; await api.markUserOnboarded();
    const project = await api.createProject("Fixed file verification"), module = await api.createModule(project.id, "File evidence");
    const programme = await api.createCockpitNode({ code: "FILE-1", name: project.title, project_id: project.id });
    const group = await api.createCockpitNode({ code: "FILE-2", name: module.title, module_id: module.id, parent_id: programme.id });
    const leaf = await api.createCockpitNode({ code: "FILE-3", name: "Retain verified file evidence", parent_id: group.id });
    const source = await api.createIssue(`Prepare fixed file ${run}`, { project_id: project.id, module_id: module.id, status: "backlog", assignee_type: "member", assignee_id: auth.user.id });
    const filename = `evidence-${run}.txt`;
    const content = "Fixed file evidence\r\nUTF-8 verification: \u56fa\u5b9a\u6587\u4ef6\u8bc1\u636e\nTrailing spaces stay fixed.  \n";
    const expected = Buffer.from(content, "utf8"), expectedHash = createHash("sha256").update(expected).digest("hex");
    const uploaded = await api.uploadOwnedIssueAttachment(source.id, filename, content);
    expect(uploaded.size_bytes).toBe(expected.byteLength);
    const token = api.getToken(); if (!token) throw new Error("Fixture token missing");
    await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = "multica-locale=en; path=/"; }, token);
    const base = `/${workspace.slug}/cockpit`;
    await page.goto(`${base}?node=${leaf.id}&node_view=artifacts&project=${project.id}&module=${module.id}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Register artifact", exact: true }).click();
    const registration = page.getByRole("dialog", { name: "Register artifact", exact: true });
    await registration.getByRole("textbox", { name: "Search existing issues", exact: true }).fill(source.title);
    await registration.getByRole("button", { name: new RegExp(source.title) }).click();
    await registration.getByRole("textbox", { name: "Artifact title", exact: true }).fill("Verified file delivery");
    await registration.getByRole("button", { name: "Reviewer", exact: true }).click(); await page.getByRole("button", { name: reviewerName, exact: true }).click();
    await registration.getByRole("button", { name: "Register artifact", exact: true }).click();
    await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("artifact")));
    const artifactId = new URL(page.url()).searchParams.get("artifact"); if (!artifactId) throw new Error("Artifact identity missing after registration");
    await page.getByRole("button", { name: "Submit a new version", exact: true }).click();
    await page.getByRole("button", { name: "File", exact: true }).click();
    const files = page.getByRole("region", { name: "Production issue files", exact: true });
    await files.getByRole("button", { name: new RegExp(filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).click();
    await page.getByRole("button", { name: "Submit fixed version", exact: true }).click();
    await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("artifact_version")));
    const versionId = new URL(page.url()).searchParams.get("artifact_version"); if (!versionId) throw new Error("Fixed version identity missing after submission");
    await expect.poll(async () => (await api.getCockpitArtifactVersion(artifactId, versionId)).version.capture_status,
      { timeout: 60_000, intervals: [250, 500, 1_000], message: "The actual capture worker should verify the isolated fixture file" }).toBe("ready");
    const fixed = await api.getCockpitArtifactVersion(artifactId, versionId);
    expect(fixed.content_available).toBe(true); expect(fixed.version.payload_kind).toBe("attachment"); expect(fixed.version.source_attachment_id).toBe(uploaded.id);
    expect(fixed.version.producer_issue_id).toBe(source.id); expect(fixed.version.content_hash).toBe(expectedHash); expect(fixed.version.size_bytes).toBe(expected.byteLength);
    expect(fixed.version.decision).toBe("pending"); expect(fixed.version.review_issue?.id).toBeTruthy();
    await page.reload({ waitUntil: "domcontentloaded" });
    const reader = page.getByRole("region", { name: "Fixed version content", exact: true });
    const reviewed = reader.getByRole("checkbox", { name: "I have checked this fixed file.", exact: true });
    await expect(reviewed).toBeDisabled();
    let linkRequests = 0; const signedRequestAuthorization: Array<string | undefined> = [];
    page.on("request", (request) => {
      if (request.method() !== "GET") return;
      const path = new URL(request.url()).pathname;
      if (path === `/api/cockpit/artifacts/${artifactId}/versions/${versionId}/download-link`) linkRequests += 1;
      if (path === `/api/cockpit/artifact-files/${versionId}/download`) signedRequestAuthorization.push(request.headers()["authorization"]);
    });
    const firstDownload = page.waitForEvent("download");
    await reader.getByRole("button", { name: "Download fixed file", exact: true }).click();
    const download = await firstDownload; const address = new URL(download.url());
    expect(address.pathname).toBe(`/api/cockpit/artifact-files/${versionId}/download`); expect(address.searchParams.has("token")).toBe(true);
    expect(address.pathname.startsWith("/uploads/")).toBe(false);
    const firstBytes = await downloadedBytes(download); expect(firstBytes.equals(expected)).toBe(true); expect(createHash("sha256").update(firstBytes).digest("hex")).toBe(expectedHash);
    await expect(reviewed).toBeEnabled(); await reviewed.check();
    await reader.getByRole("textbox", { name: "Review feedback", exact: true }).fill("Downloaded bytes match the fixed file evidence.");
    await reader.getByRole("button", { name: "Submit review", exact: true }).click();
    await expect.poll(async () => (await api.getCockpitArtifact(artifactId)).approved_version?.id).toBe(versionId);
    await api.deleteOwnedIssueAttachment(uploaded.id); expect(await api.getOwnedAttachmentStatus(uploaded.id)).toBe(404);
    const afterDeletion = await api.getCockpitArtifactVersion(artifactId, versionId);
    expect(afterDeletion.content_available).toBe(true); expect(afterDeletion.version.content_hash).toBe(expectedHash); expect(afterDeletion.version.decision).toBe("approved");
    const secondDownload = page.waitForEvent("download");
    await reader.getByRole("button", { name: "Download fixed file", exact: true }).click();
    const retained = await secondDownload; const retainedBytes = await downloadedBytes(retained);
    expect(retainedBytes.equals(expected)).toBe(true); expect(new URL(retained.url()).pathname).toBe(`/api/cockpit/artifact-files/${versionId}/download`);
    expect(linkRequests).toBe(2); expect(signedRequestAuthorization.length).toBeGreaterThanOrEqual(2); expect(signedRequestAuthorization.every((value) => value === undefined)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("artifact-private-file-retained.png"), fullPage: true });
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } finally { if (ownsWorkspace) await api.cleanupCreatedWorkspace(); }
});
