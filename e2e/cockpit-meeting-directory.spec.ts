import { lstat, mkdir, rmdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { TestApiClient } from "./fixtures";
import { createNASFilesystemFixture } from "./nas-fixture";

test.use({ viewport: { width: 1500, height: 1050 }, locale: "en-US", timezoneId: "Asia/Shanghai", contextOptions: { reducedMotion: "reduce" }, screenshot: "only-on-failure", trace: "retain-on-failure" });

async function expectFullyOnScreen(locator: Locator, page: Page) {
  await expect(locator).toBeInViewport({ ratio: 1 });
  const box = await locator.boundingBox(), viewport = page.viewportSize();
  expect(box).not.toBeNull(); expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);
  return box!;
}

async function expectStepContentsOnScreen(row: Locator, page: Page) {
  const clip = await row.locator("xpath=..").evaluate((element) => { const box = element.getBoundingClientRect(); return { x: box.x + element.clientLeft, y: box.y + element.clientTop, width: element.clientWidth, height: element.clientHeight }; });
  // The last row's empty padding meets a fractional, rounded scroll edge. Check
  // the actual name/state, kind and disclosure instead of that decorative padding.
  for (const content of [row.locator(":scope > div").first(), row.locator(":scope > p").first(), row.locator("summary")]) {
    const box = await expectFullyOnScreen(content, page);
    expect(box.x).toBeGreaterThanOrEqual(clip.x); expect(box.y).toBeGreaterThanOrEqual(clip.y);
    expect(box.x + box.width).toBeLessThanOrEqual(clip.x + clip.width); expect(box.y + box.height).toBeLessThanOrEqual(clip.y + clip.height);
  }
}

/** Read-only previews are closed and reopened explicitly; no confirmation POST is issued by this sampler. */
async function sampleNarrowPreview(page: Page, testInfo: TestInfo, target: string, repair: boolean) {
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => { localStorage.setItem("e2e-directory-locale", "zh-Hans"); document.cookie = "multica-locale=zh-Hans; path=/"; document.documentElement.classList.add("dark"); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: repair ? "重新检查已完成目录" : "检查或准备目录", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "核对目录准备", exact: true }).click();
  const preview = dialog.getByRole("region", { name: "核对目录准备", exact: true });
  const submit = dialog.getByRole("button", { name: "确认目录准备", exact: true });
  await expect(submit).toBeDisabled();
  await expectFullyOnScreen(preview.getByText(target, { exact: true }).first(), page);
  await expectFullyOnScreen(submit, page);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  const prefix = repair ? "meeting-directory-repair-preview" : "meeting-directory-preview";
  await page.screenshot({ path: testInfo.outputPath(`${prefix}-390-zh-dark.png`), animations: "disabled" });
  const missingStep = repair ? preview.locator("ol > li").filter({ has: page.getByText("将创建", { exact: true }) }).first() : null;
  if (missingStep) { await missingStep.scrollIntoViewIfNeeded(); await expectStepContentsOnScreen(missingStep, page); }
  const confirmation = dialog.getByRole("checkbox", { name: "仅准备上方列出的目录，保持已有文件和任务不变。", exact: true });
  const label = confirmation.locator("xpath=..");
  await label.scrollIntoViewIfNeeded();
  const labelBox = await expectFullyOnScreen(label, page); const submitBox = await expectFullyOnScreen(submit, page);
  if (missingStep) await expectStepContentsOnScreen(missingStep, page);
  expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(submitBox.y);
  await confirmation.check(); await expect(submit).toBeEnabled(); await submit.click({ trial: true });
  await expectFullyOnScreen(submit, page);
  await page.screenshot({ path: testInfo.outputPath(`${prefix}-confirmation-390-zh-dark.png`), animations: "disabled" });
  await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1500, height: 1050 }); await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => { localStorage.setItem("e2e-directory-locale", "en"); document.cookie = "multica-locale=en; path=/"; document.documentElement.classList.remove("dark"); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: repair ? "Recheck completed directories" : "Check or prepare directories", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Review directory preparation", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("region", { name: "Review directory preparation", exact: true })).toBeVisible();
}

test("prepares owned meeting directories, recovers the fixed receipt and explicitly repairs later missing material folders", async ({ page }, testInfo) => {
  test.setTimeout(180_000); page.setDefaultTimeout(15_000);
  const configured = process.env.MULTICA_E2E_NAS_ROOT_PATH && process.env.MULTICA_E2E_NAS_ROOT_ID && process.env.MULTICA_E2E_NAS_WORKSPACE_ID;
  test.skip(!configured, "Requires the explicitly configured agent 3 directory preparation fixture");
  if (process.env.MULTICA_E2E_REAL_NAS === "1") throw new Error("This directory preparation test requires the owned local QA root");
  const filesystem = await createNASFilesystemFixture("directory"); const api = new TestApiClient(); let owned = false;
  const run = `${Date.now().toString(36)}-${process.pid}`;
  try {
    await api.login(`e2e-directory-${run}@multica.ai`, "Directory coordinator");
    const workspace = await api.createNASFixtureWorkspace(`Directory preparation ${run}`, `e2e-directory-${run}`); owned = true;
    await api.markUserOnboarded(); await api.updateCockpitBoard({ title: "Meeting directory preparation" });
    const target = join(filesystem.directory, "source-materials"); await mkdir(target);
    const baseIdentity = await lstat(target, { bigint: true });
    const meeting = await api.createCockpitMeeting({ title: "Prepare recording and reference material folders", meet_date: "2026-10-11", nas_dir: target });
    const token = api.getToken(); if (!token) throw new Error("Missing owned fixture token");
    await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = `multica-locale=${localStorage.getItem("e2e-directory-locale") || "en"}; path=/`; }, token);
    const base = `/${workspace.slug}/cockpit?meeting=${meeting.id}&meeting_view=resources`;
    const attempts: string[] = []; const issueWrites: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.includes("/directory-preparations/") && path.includes("/attempts")) attempts.push(path);
      if (request.method() === "POST" && (path === "/api/issues" || path.endsWith("/preparation-issues"))) issueWrites.push(path);
    });
    await page.goto(base, { waitUntil: "domcontentloaded" });
    const notes = page.getByRole("textbox", { name: "Meeting notes", exact: true }); await notes.fill("Keep these unsaved source-material notes while checking directories.");
    await page.getByRole("button", { name: "Check or prepare directories", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("textbox", { name: "Directory location below the managed root", exact: true })).toHaveValue(new RegExp("directory-e2e/.+/source-materials$"));
    await dialog.getByRole("button", { name: "Review directory preparation", exact: true }).click();
    await expect(dialog.getByRole("region", { name: "Review directory preparation", exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Confirm directory preparation", exact: true })).toBeDisabled();
    await sampleNarrowPreview(page, testInfo, target, false);
    await dialog.getByRole("checkbox", { name: "Prepare only these listed directories. Keep existing files and issues unchanged.", exact: true }).check();
    let creates = 0, operationId = "", commandKey = "";
    const createPath = `/api/cockpit/meetings/${meeting.id}/directory-preparations`;
    await page.route(`**${createPath}`, async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      creates += 1; const response = await route.fetch(); expect(response.status()).toBeGreaterThanOrEqual(200); expect(response.status()).toBeLessThan(300);
      const data = await response.json(); operationId = data.receipt.directory_operation_id; commandKey = data.command_key;
      expect(operationId).toMatch(/^[0-9a-f-]{36}$/); await route.abort("failed");
    });
    await dialog.getByRole("button", { name: "Confirm directory preparation", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Check the previous request", exact: true })).toBeEnabled();
    const lookup = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname.endsWith(`/lifecycle/commands/${commandKey}`));
    await dialog.getByRole("button", { name: "Check the previous request", exact: true }).click(); expect((await lookup).status()).toBe(200);
    await expect(dialog).toBeHidden(); await expect(page).toHaveURL(new RegExp(`directory_operation=${operationId}`)); expect(creates).toBe(1);
    await page.unroute(`**${createPath}`);
    await expect.poll(async () => (await api.getOwnedDirectoryOperation(meeting.id, operationId)).state, { timeout: 40_000 }).toBe("completed");
    const reader = page.getByRole("region", { name: "View directory progress", exact: true });
    await reader.getByRole("button", { name: "Reload latest record", exact: true }).click(); await expect(reader.getByRole("heading", { name: "Preparation verified", exact: true })).toBeVisible();
    const initial = await api.getOwnedDirectorySteps(meeting.id, operationId);
    expect(initial.total).toBeLessThanOrEqual(32); expect(initial.items.every((step) => step.state === "satisfied")).toBe(true);
    expect(initial.items.find((step) => step.kind === "base")?.outcome).toBe("observed_existing");
    for (const section of ["会议纪要与录音转写", "会议材料", "照片"]) expect((await lstat(join(target, section))).isDirectory()).toBe(true);
    expect(attempts).toEqual([]);
    const baseStep = initial.items.find((step) => step.kind === "base")!;
    const baseRow = reader.locator("ol > li").filter({ has: page.getByText(baseStep.label, { exact: true }) });
    await baseRow.getByRole("button", { name: /^Attempts \(/ }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: /^Attempt 1/ })).toBeVisible(); expect(attempts).toHaveLength(1);
    await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toBeHidden();
    await page.getByRole("link", { name: "Back to meeting materials", exact: true }).click(); await expect(notes).toHaveValue("Keep these unsaved source-material notes while checking directories.");

    await page.getByRole("button", { name: "Directory history (1)", exact: true }).click();
    const completedPlan = page.getByRole("link", { name: target, exact: true });
    await expect(completedPlan).toHaveAttribute("href", new RegExp(`directory_operation=${operationId}`));
    await completedPlan.click(); await expect(page).toHaveURL(new RegExp(`directory_operation=${operationId}`));
    await rmdir(join(target, "照片"));
    await reader.getByRole("button", { name: "Recheck completed directories", exact: true }).click();
    const repair = page.getByRole("dialog"); await repair.getByRole("button", { name: "Review directory preparation", exact: true }).click();
    const preview = repair.getByRole("region", { name: "Review directory preparation", exact: true }); await expect(preview.getByText("Will create", { exact: true })).toHaveCount(1);
    await sampleNarrowPreview(page, testInfo, target, true);
    await expect(preview.getByText("Will create", { exact: true })).toHaveCount(1);
    await repair.getByRole("checkbox", { name: "Prepare only these listed directories. Keep existing files and issues unchanged.", exact: true }).check();
    const repaired = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === createPath);
    await repair.getByRole("button", { name: "Confirm directory preparation", exact: true }).click(); const repairResult = await (await repaired).json(); const repairId = repairResult.receipt.directory_operation_id;
    expect(repairId).not.toBe(operationId); await expect(page).toHaveURL(new RegExp(`directory_operation=${repairId}`));
    await expect.poll(async () => (await api.getOwnedDirectoryOperation(meeting.id, repairId)).state, { timeout: 40_000 }).toBe("completed");
    expect((await lstat(join(target, "照片"))).isDirectory()).toBe(true);
    const sameBase = await lstat(target, { bigint: true }); expect([sameBase.dev, sameBase.ino]).toEqual([baseIdentity.dev, baseIdentity.ino]);
    expect((await api.getOwnedDirectoryOperation(meeting.id, operationId)).state).toBe("completed"); expect(issueWrites).toEqual([]); expect(await api.getWorkspaceAgentRunCount()).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: "dark" });
    await page.evaluate(() => { localStorage.setItem("e2e-directory-locale", "zh-Hans"); document.cookie = "multica-locale=zh-Hans; path=/"; document.documentElement.classList.add("dark"); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("link", { name: "返回会议资料", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("meeting-directory-progress-390-zh-dark.png"), animations: "disabled" });
    await page.getByRole("link", { name: "返回会议资料", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "会议说明", exact: true })).toHaveValue("Keep these unsaved source-material notes while checking directories.");

    const customTarget = join(filesystem.directory, "custom-scope"), customPartition = "raw-session-audio";
    await mkdir(customTarget);
    const customMeeting = await api.createCockpitMeeting({ title: "Repair only the original custom input folder", meet_date: "2026-10-11", nas_dir: customTarget });
    const customOperation = await api.seedOwnedDirectoryPlan(customMeeting.id, filesystem.rootId, relative(filesystem.root, customTarget), [customPartition]);
    await expect.poll(async () => (await api.getOwnedDirectoryOperation(customMeeting.id, customOperation)).state, { timeout: 40_000 }).toBe("completed");
    await rmdir(join(customTarget, customPartition));
    await page.goto(`/${workspace.slug}/cockpit?meeting=${customMeeting.id}&meeting_view=resources&directory_operation=${customOperation}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "重新检查已完成目录", exact: true }).click();
    const customDialog = page.getByRole("dialog");
    await expect(customDialog.getByRole("checkbox", { name: customPartition, exact: true })).toBeChecked();
    await expect(customDialog.getByRole("checkbox", { name: customPartition, exact: true })).toBeDisabled();
    for (const name of ["会议纪要与录音转写", "会议材料", "照片"]) await expect(customDialog.getByRole("checkbox", { name, exact: true })).toHaveCount(0);
    const customPreviewPath = `/api/cockpit/meetings/${customMeeting.id}/directory-preparations/preview`;
    const customPreview = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === customPreviewPath);
    await customDialog.getByRole("button", { name: "核对目录准备", exact: true }).click();
    const observed = await customPreview; expect(observed.status()).toBe(200);
    expect(observed.request().postDataJSON()).toMatchObject({ mode: "repair", root_id: filesystem.rootId, relative_directory: relative(filesystem.root, customTarget), partitions: [customPartition] });
    const customRegion = customDialog.getByRole("region", { name: "核对目录准备", exact: true });
    await expect(customRegion.getByText("将创建", { exact: true })).toHaveCount(1);
    await expectFullyOnScreen(customRegion.getByText(customTarget, { exact: true }).first(), page);
    const customConfirmation = customDialog.getByRole("checkbox", { name: "仅准备上方列出的目录，保持已有文件和任务不变。", exact: true });
    await customConfirmation.locator("xpath=..").scrollIntoViewIfNeeded(); await expectFullyOnScreen(customConfirmation.locator("xpath=.."), page);
    const customSubmit = customDialog.getByRole("button", { name: "确认目录准备", exact: true }); await expectFullyOnScreen(customSubmit, page);
    await customConfirmation.check();
    await page.screenshot({ path: testInfo.outputPath("meeting-directory-custom-repair-preview-390-zh-dark.png"), animations: "disabled" });
    const customWrite = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/cockpit/meetings/${customMeeting.id}/directory-preparations`);
    await customSubmit.click(); const customResult = await (await customWrite).json(); const repairedCustomId = customResult.receipt.directory_operation_id;
    expect(repairedCustomId).not.toBe(customOperation);
    await expect.poll(async () => (await api.getOwnedDirectoryOperation(customMeeting.id, repairedCustomId)).state, { timeout: 40_000 }).toBe("completed");
    const customSteps = await api.getOwnedDirectorySteps(customMeeting.id, repairedCustomId);
    expect(customSteps.items.filter((step) => step.kind === "partition").map((step) => step.relative_path)).toEqual([`${relative(filesystem.root, customTarget)}/${customPartition}`]);
    expect((await lstat(join(customTarget, customPartition))).isDirectory()).toBe(true);
    for (const name of ["会议纪要与录音转写", "会议材料", "照片"]) await expect(lstat(join(customTarget, name))).rejects.toMatchObject({ code: "ENOENT" });
    expect(issueWrites).toEqual([]); expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } finally {
    try { if (owned) await api.cleanupCreatedWorkspace(); } finally { await filesystem.cleanup(); }
  }
});
