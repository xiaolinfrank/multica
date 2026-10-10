import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { TestApiClient } from "./fixtures";
import { createNASFilesystemFixture } from "./nas-fixture";

test.use({
  viewport: { width: 1600, height: 1050 }, locale: "en-US", timezoneId: "Asia/Shanghai",
  contextOptions: { reducedMotion: "reduce" }, screenshot: "only-on-failure", trace: "retain-on-failure",
});

test("retains publication while a NAS copy fails, retries safely, and preserves a conflicting file", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  test.skip(process.env.MULTICA_E2E_NAS_WRITE_MODE === "create_only", "Atomic recovery has a separate configured fixture mode");
  const configuredRoot = process.env.MULTICA_E2E_NAS_ROOT_PATH;
  const rootId = process.env.MULTICA_E2E_NAS_ROOT_ID;
  const configured = configuredRoot && rootId && process.env.MULTICA_E2E_NAS_WORKSPACE_ID;
  test.skip(process.env.MULTICA_E2E_REAL_NAS !== "1" && !configured,
    "Requires the explicitly configured, isolated agent 3 NAS fixture server");
  if (!configured) throw new Error("Real NAS verification requires all explicit fixture identities");
  const filesystem = await createNASFilesystemFixture();
  const fixture = filesystem.directory;
  const api = new TestApiClient();
  const run = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  let ownsWorkspace = false;
  try {
    const auth = await api.login(`e2e-nas-${run}@multica.ai`, "NAS Publication Reviewer");
    const workspace = await api.createNASFixtureWorkspace(`NAS Minutes ${run}`, `e2e-nas-${run}`);
    ownsWorkspace = true;
    await api.markUserOnboarded();
    const token = api.getToken();
    if (!token) throw new Error("NAS fixture login did not return a token");
    await page.addInitScript((value) => {
      localStorage.setItem("multica_token", value);
      localStorage.setItem("multica:chat:isOpen", "false");
      document.cookie = "multica-locale=en; path=/";
    }, token);
    const showMeeting = async (meetingId: string) => {
      await page.goto(`/${workspace.slug}/cockpit?meeting=${meetingId}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("button", { name: "Publish version", exact: true })).toBeVisible();
    };
    const content = "# Published meeting minutes\n\nHuman approval remains valid while the NAS is offline.\n\n- Evidence: fixed UTF-8 content.\n- 中文内容也必须原样保存。";
    const meetingDir = join(fixture, "offline-meeting");
    const offlineDir = join(fixture, "offline-meeting-unavailable");
    await mkdir(meetingDir);
    const meeting = await api.createCockpitMeeting({ title: "NAS recovery review", meet_date: new Date().toISOString().slice(0, 10), nas_dir: meetingDir });
    await api.seedPendingMeetingReview(meeting.id, auth.user.id, content);
    const approved = await api.approveMeetingMinutes(meeting.id);
    const version = approved.versions[0]!;
    expect(approved.nas_destination).toEqual({ root_id: rootId, directory: meetingDir, write_mode: "atomic" });
    await showMeeting(meeting.id);

    await test.step("publish once while the meeting directory is unavailable", async () => {
      await expect(page.getByRole("checkbox", { name: "Sync published minutes to NAS", exact: true })).toBeChecked();
      await rename(meetingDir, offlineDir);
      await page.getByRole("button", { name: "Publish version", exact: true }).click();
      await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
      await expect.poll(async () => (await api.getMeetingWorkflow(meeting.id)).nas_exports[0]?.status, { timeout: 30_000 }).toBe("retry_wait");
      await page.getByRole("button", { name: "Refresh NAS status", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Waiting to retry" })).toBeVisible();
      const pending = await api.getMeetingWorkflow(meeting.id);
      expect(pending.published_version_id).toBe(version.id);
      expect(pending.versions[0]).toMatchObject({ id: version.id, content, decision: "approved" });
      expect(pending.nas_exports).toHaveLength(1);
      expect(pending.nas_exports[0]).toMatchObject({ version_id: version.id, directory: meetingDir, content_hash: version.content_hash });
      await page.screenshot({ path: testInfo.outputPath("published-nas-unavailable.png"), animations: "disabled" });
    });

    await test.step("retry the same copy after restoring the fixture directory", async () => {
      const failed = (await api.getMeetingWorkflow(meeting.id)).nas_exports[0]!;
      await rename(offlineDir, meetingDir);
      await page.getByRole("button", { name: "Retry NAS export", exact: true }).click();
      await expect.poll(async () => (await api.getMeetingWorkflow(meeting.id)).nas_exports[0]?.status, { timeout: 30_000 }).toBe("succeeded");
      await page.getByRole("button", { name: "Refresh NAS status", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Exported to NAS" })).toBeVisible();
      const copied = await api.getMeetingWorkflow(meeting.id);
      expect(copied.published_version_id).toBe(version.id);
      expect(copied.nas_exports).toHaveLength(1);
      const operation = copied.nas_exports[0]!;
      expect(operation.id).toBe(failed.id);
      expect(operation.attempts).toBeGreaterThan(failed.attempts);
      expect(operation.target_path).toBe(join(meetingDir, "已发布纪要", `minutes-v0001-${version.id}.md`));
      const bytes = await readFile(operation.target_path);
      expect(bytes.toString("utf8")).toBe(content);
      expect(bytes.length).toBe(operation.size_bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(version.content_hash);
      await page.screenshot({ path: testInfo.outputPath("published-nas-recovered.png"), animations: "disabled" });
    });

    await test.step("request a copy after publication and refuse to overwrite a different existing file", async () => {
      const conflictDir = join(fixture, "conflict-meeting");
      await mkdir(conflictDir);
      const conflict = await api.createCockpitMeeting({ title: "NAS conflicting file review", meet_date: new Date().toISOString().slice(0, 10), nas_dir: conflictDir });
      await api.seedPendingMeetingReview(conflict.id, auth.user.id, content);
      const approvedConflict = await api.approveMeetingMinutes(conflict.id);
      const fixedVersion = approvedConflict.versions[0]!;
      await showMeeting(conflict.id);
      await page.getByRole("checkbox", { name: "Sync published minutes to NAS", exact: true }).click();
      await page.getByRole("button", { name: "Publish version", exact: true }).click();
      await expect(page.getByRole("button", { name: "Export published minutes to NAS", exact: true })).toBeVisible();
      expect((await api.getMeetingWorkflow(conflict.id)).nas_exports).toHaveLength(0);
      const target = join(conflictDir, "已发布纪要", `minutes-v0001-${fixedVersion.id}.md`);
      await mkdir(join(conflictDir, "已发布纪要"));
      const existing = "This independently created file must survive.\n";
      await writeFile(target, existing, { flag: "wx" });
      await page.getByRole("button", { name: "Export published minutes to NAS", exact: true }).click();
      await expect.poll(async () => (await api.getMeetingWorkflow(conflict.id)).nas_exports[0]?.status, { timeout: 30_000 }).toBe("needs_attention");
      await page.getByRole("button", { name: "Refresh NAS status", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Needs attention" })).toBeVisible();
      await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
      expect(await readFile(target, "utf8")).toBe(existing);
      expect((await api.getMeetingWorkflow(conflict.id)).published_version_id).toBe(fixedVersion.id);
      await page.screenshot({ path: testInfo.outputPath("published-nas-file-conflict.png"), animations: "disabled" });
      await page.setViewportSize({ width: 1100, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  } finally {
    try {
      if (ownsWorkspace) await api.cleanupCreatedWorkspace();
    } finally {
      await filesystem.cleanup();
    }
  }
});

test("preserves publication and files when real SMB cannot commit without replacement", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  test.skip(process.env.MULTICA_E2E_REAL_NAS !== "1" || process.env.MULTICA_E2E_NAS_WRITE_MODE === "create_only", "Requires explicitly authorized atomic-mode real SMB verification");
  await page.setViewportSize({ width: 1600, height: 1400 });
  const filesystem = await createNASFilesystemFixture();
  const api = new TestApiClient();
  const run = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  let ownsWorkspace = false;
  try {
    const auth = await api.login(`e2e-smb-capability-${run}@multica.ai`, "SMB Validation Reviewer");
    const workspace = await api.createNASFixtureWorkspace(`SMB capability ${run}`, `e2e-smb-${run}`);
    ownsWorkspace = true;
    await api.markUserOnboarded();
    const token = api.getToken();
    if (!token) throw new Error("SMB fixture login did not return a token");
    await page.addInitScript((value) => {
      localStorage.setItem("multica_token", value);
      localStorage.setItem("multica:chat:isOpen", "false");
      document.cookie = "multica-locale=en; path=/";
    }, token);
    const content = "# Real SMB validation\n\nApproval must survive an unsupported exclusive filesystem commit.\n\n中文内容须保持不变。";
    const meetingDir = join(filesystem.directory, "unsupported-commit");
    await mkdir(meetingDir);
    const meeting = await api.createCockpitMeeting({ title: "SMB commit capability", meet_date: new Date().toISOString().slice(0, 10), nas_dir: meetingDir });
    await api.seedPendingMeetingReview(meeting.id, auth.user.id, content);
    const approved = await api.approveMeetingMinutes(meeting.id);
    const version = approved.versions[0]!;
    await page.goto(`/${workspace.slug}/cockpit?meeting=${meeting.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("checkbox", { name: "Sync published minutes to NAS", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Publish version", exact: true }).click();
    await expect.poll(async () => (await api.getMeetingWorkflow(meeting.id)).nas_exports[0]?.status, { timeout: 30_000 }).toBe("needs_attention");
    let workflow = await api.getMeetingWorkflow(meeting.id);
    const operation = workflow.nas_exports[0]!;
    expect(workflow.published_version_id).toBe(version.id);
    expect(operation).toMatchObject({ last_error_code: "unsupported_commit", completed_at: null, size_bytes: null, content_hash: version.content_hash });
    await expect(lstat(operation.target_path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(meetingDir, "已发布纪要"))).toEqual([]);
    await page.getByRole("button", { name: "Refresh NAS status", exact: true }).click();
    await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "Needs attention" })).toBeVisible();
    await page.getByRole("region", { name: "NAS copies", exact: true }).scrollIntoViewIfNeeded();
    await writeFile(testInfo.outputPath("real-smb-unsupported-commit.json"), JSON.stringify({ root: filesystem.root, operation, published_version_id: workflow.published_version_id }, null, 2));
    await page.screenshot({ path: testInfo.outputPath("real-smb-published-needs-attention.png"), animations: "disabled" });

    await page.getByRole("button", { name: "Retry after storage support is fixed", exact: true }).click();
    await expect.poll(async () => {
      const next = (await api.getMeetingWorkflow(meeting.id)).nas_exports[0];
      return next?.status === "needs_attention" && next.attempts > operation.attempts;
    }, { timeout: 30_000 }).toBe(true);
    workflow = await api.getMeetingWorkflow(meeting.id);
    expect(workflow.published_version_id).toBe(version.id);
    expect(workflow.nas_exports).toHaveLength(1);
    expect(workflow.nas_exports[0]).toMatchObject({ id: operation.id, last_error_code: "unsupported_commit", completed_at: null, size_bytes: null });
    await expect(lstat(operation.target_path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(meetingDir, "已发布纪要"))).toEqual([]);

    const foreign = "This validation-owned foreign file must not be replaced.\n";
    await writeFile(operation.target_path, foreign, { flag: "wx" });
    await page.getByRole("button", { name: "Refresh NAS status", exact: true }).click();
    await page.getByRole("button", { name: "Retry after storage support is fixed", exact: true }).click();
    await expect.poll(async () => (await api.getMeetingWorkflow(meeting.id)).nas_exports[0]?.last_error_code, { timeout: 30_000 }).toBe("file_conflict");
    expect(await readFile(operation.target_path, "utf8")).toBe(foreign);
    workflow = await api.getMeetingWorkflow(meeting.id);
    expect(workflow.published_version_id).toBe(version.id);
    expect(workflow.versions[0]).toMatchObject({ id: version.id, content, decision: "approved" });
    expect(workflow.nas_exports[0]).toMatchObject({ id: operation.id, status: "needs_attention", completed_at: null });
    expect((await readdir(join(meetingDir, "已发布纪要"))).filter((name) => name.startsWith(".multica-"))).toEqual([]);
    await page.getByRole("button", { name: "Refresh NAS status", exact: true }).click();
    await page.getByRole("region", { name: "NAS copies", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("real-smb-foreign-file-preserved.png"), animations: "disabled" });
    const resultPath = testInfo.outputPath("real-smb-result.json");
    await writeFile(resultPath, JSON.stringify({ root: filesystem.root, operation: workflow.nas_exports[0], published_version_id: workflow.published_version_id }, null, 2));
    await testInfo.attach("real-smb-result", { path: resultPath, contentType: "application/json" });
  } finally {
    try { if (ownsWorkspace) await api.cleanupCreatedWorkspace(); }
    finally { await filesystem.cleanup(); }
  }
});

test("publishes an explicit create-only copy with verified evidence and lazily loads attempts", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  test.skip(process.env.MULTICA_E2E_NAS_WRITE_MODE !== "create_only", "Requires an explicitly configured create-only fixture root");
  const filesystem = await createNASFilesystemFixture();
  const api = new TestApiClient(); const run = `${Date.now().toString(36)}-${process.pid}`;
  let ownsWorkspace = false;
  try {
    const auth = await api.login(`e2e-create-only-${run}@multica.ai`, "Create-only publication reviewer");
    const workspace = await api.createNASFixtureWorkspace(`Create-only minutes ${run}`, `e2e-create-only-${run}`); ownsWorkspace = true;
    await api.markUserOnboarded(); await api.updateCockpitBoard({ title: "Verified minutes archive" });
    const directory = join(filesystem.directory, "review-meeting"); await mkdir(directory);
    const meeting = await api.createCockpitMeeting({ title: "Create-only archive review", meet_date: new Date().toISOString().slice(0, 10), nas_dir: directory });
    const content = "# Approved minutes\n\nA verified record identifies this exact fixed version.\n\n中文内容保持原样。";
    await api.seedPendingMeetingReview(meeting.id, auth.user.id, content);
    const approved = await api.approveMeetingMinutes(meeting.id); const version = approved.versions[0]!;
    expect(approved.nas_destination).toEqual({ root_id: filesystem.rootId, directory, write_mode: "create_only" });
    const logical = join(directory, "已发布纪要", "创建式副本", `minutes-v0001-${version.id}.md`);
    await mkdir(join(directory, "已发布纪要", "创建式副本"), { recursive: true });
    await writeFile(logical, "Unrelated existing file must remain byte-for-byte intact.", { flag: "wx" });
    const token = api.getToken(); if (!token) throw new Error("Fixture token missing");
    await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = "multica-locale=en; path=/"; }, token);
    const attemptReads: string[] = [];
    page.on("request", (request) => { if (request.method() === "GET" && new URL(request.url()).pathname.endsWith("/attempts")) attemptReads.push(request.url()); });
    await page.goto(`/${workspace.slug}/cockpit?meeting=${meeting.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Create-only copy", { exact: true })).toBeVisible();
    await expect(page.getByText("Files can be visible while being written. Only a copy with a verified completion record is complete; incomplete attempts are kept.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Publish version", exact: true }).click();
    await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => (await api.getMeetingWorkflow(meeting.id)).nas_exports[0]?.status, { timeout: 30_000 }).toBe("succeeded");
    await page.getByRole("button", { name: "Refresh NAS status", exact: true }).click();
    const operation = (await api.getMeetingWorkflow(meeting.id)).nas_exports[0]!;
    expect(operation).toMatchObject({ write_mode: "create_only", target_path: logical, content_hash: version.content_hash });
    expect(operation.verified_path).toBeTruthy(); expect(operation.receipt_path).toBeTruthy(); expect(operation.verified_attempt_id).toBeTruthy();
    expect(operation.verified_path).not.toBe(operation.target_path);
    const bytes = await readFile(operation.verified_path!);
    expect(bytes.toString("utf8")).toBe(content); expect(createHash("sha256").update(bytes).digest("hex")).toBe(version.content_hash);
    expect(JSON.parse(await readFile(operation.receipt_path!, "utf8"))).toMatchObject({ schema_version: 1, write_mode: "create_only", workspace_id: workspace.id,
      meeting_id: meeting.id, root_id: filesystem.rootId, export_id: operation.id, version_id: version.id, attempt_id: operation.verified_attempt_id, content_hash: version.content_hash, size_bytes: bytes.length });
    expect(await readFile(logical, "utf8")).toBe("Unrelated existing file must remain byte-for-byte intact.");
    expect(attemptReads).toEqual([]);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy verified path", exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(operation.verified_path);
    const verifiedCopy = page.getByRole("status").filter({ hasText: "Exported to NAS" });
    await verifiedCopy.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("create-only-verified-summary.png"), animations: "disabled" });
    await expect(page.getByRole("button", { name: "Export attempts", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Copy & verification details", exact: true }).click();
    await expect(page.getByText("Open completion record", { exact: true })).toBeVisible();
    expect(attemptReads).toEqual([]);
    const attemptsResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/exports/${operation.id}/attempts`));
    await page.getByRole("button", { name: "Export attempts", exact: true }).click();
    const attempts = await (await attemptsResponse).json();
    expect(attempts.workspace_id).toBe(workspace.id); expect(attempts.export_id).toBe(operation.id); expect(attempts.items).toHaveLength(1);
    expect(attempts.items[0]).toMatchObject({ status: "verified", verified_path: operation.verified_path, verified_receipt_path: operation.receipt_path });
    expect(attempts.items[0]).not.toHaveProperty("content");
    const replay = await api.compactMeetingWorkflowCommand(meeting.id, `/versions/${version.id}/nas-export`, approved.nas_destination!);
    expect(replay.data.receipt.nas_export?.id).toBe(operation.id);
    expect(replay.data.receipt.nas_export?.verified_path).toBe(operation.verified_path);
    const copies = page.getByRole("status").filter({ hasText: "Exported to NAS" }); await expect(copies).toBeVisible();
    await copies.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("create-only-verified-minutes.png"), animations: "disabled" });
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } finally {
    try { if (ownsWorkspace) await api.cleanupCreatedWorkspace(); } finally { await filesystem.cleanup(); }
  }
});
