import { expect, test, type Locator, type Page } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({ viewport: { width: 1500, height: 1050 }, locale: "en-US", timezoneId: "Asia/Shanghai", contextOptions: { reducedMotion: "reduce" }, screenshot: "only-on-failure", trace: "retain-on-failure" });

async function authenticate(page: Page, api: TestApiClient) {
  const token = api.getToken(); if (!token) throw new Error("Missing owned fixture token");
  await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = `multica-locale=${localStorage.getItem("e2e-preparation-locale") || "en"}; path=/`; }, token);
}

async function choose(page: Page, trigger: Locator, name: string) {
  await trigger.click(); await page.getByRole("option", { name, exact: true }).click();
}

test("applies a human preparation template across bounded pages, reconciles an unknown effect and explicitly reviews changed facts", async ({ page }, testInfo) => {
  test.setTimeout(240_000); page.setDefaultTimeout(15_000);
  const api = new TestApiClient(), run = `${Date.now().toString(36)}-${process.pid}`; let owned = false;
  await api.login(`e2e-preparation-${run}@multica.ai`, "Preparation owner");
  try {
    const workspace = await api.createWorkspace(`Preparation programme ${run}`, `e2e-preparation-${run}`); owned = true; await api.markUserOnboarded();
    await api.updateCockpitBoard({ title: "Meeting preparation and accountable follow-up" });
    const meeting = await api.createCockpitMeeting({ title: "Prepare the programme handover", meet_date: "2026-01-15" });
    const source = await api.createIssue("Existing handover evidence", { status: "backlog" });
    const sourceIssue = await api.getIssue(source.id);
    await authenticate(page, api);
    const base = `/${workspace.slug}/cockpit?meeting=${meeting.id}&meeting_view=agenda`;
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Use a preparation template", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "New template", exact: true }).click();
    const templateName = "Programme handover checklist";
    await dialog.getByRole("textbox", { name: "Template name", exact: true }).fill(templateName);
    await dialog.getByRole("button", { name: "New agenda", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Agenda title", exact: true }).fill("Agree the handover boundary");
    await dialog.getByRole("textbox", { name: "Initial working notes", exact: true }).fill("Working notes stay editable and do not confirm readiness.");
    for (let i = 1; i <= 25; i++) {
      await dialog.getByRole("button", { name: "New preparation issue", exact: true }).click();
      await dialog.getByRole("textbox", { name: "Issue title", exact: true }).fill(`Prepare evidence ${String(i).padStart(2, "0")}`);
    }
    await dialog.getByRole("button", { name: "Link an existing issue", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Item label", exact: true }).fill("Check the existing evidence");
    const saved = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/cockpit/meeting-templates");
    await dialog.getByRole("button", { name: "Save template version", exact: true }).click();
    const savedResponse = await saved; expect(savedResponse.ok()).toBe(true);
    const template = await savedResponse.json(); expect(template.receipt.config.slots).toHaveLength(27);
    await dialog.getByRole("button", { name: "Use version 1", exact: true }).click();
    const firstChoices = dialog.locator('input[type="checkbox"]'); await expect(firstChoices).toHaveCount(25);
    for (const checkbox of await firstChoices.all()) await expect(checkbox).not.toBeChecked();
    for (let i = 0; i < 25; i++) await firstChoices.nth(i).check();
    await dialog.getByRole("button", { name: "Next page", exact: true }).click();
    const lastChoices = dialog.locator('input[type="checkbox"]'); await expect(lastChoices).toHaveCount(2);
    await lastChoices.nth(0).check(); await lastChoices.nth(1).check();
    await dialog.getByRole("textbox", { name: "Search existing issues", exact: true }).fill(source.title);
    await dialog.getByRole("button", { name: `${sourceIssue.identifier} ${source.title}`, exact: true }).click();
    await dialog.getByRole("button", { name: "Review the planned changes", exact: true }).click();
    const preview = dialog.getByRole("region", { name: "Review the planned changes", exact: true });
    await expect(preview.getByText("27 selected items", { exact: true })).toBeVisible();
    await expect(preview.getByText("26 new objects", { exact: true })).toBeVisible(); await expect(preview.getByText("1 links to existing objects", { exact: true })).toBeVisible();
    await expect(preview.locator(":scope > ul > li")).toHaveCount(25);
    await preview.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(preview.locator(":scope > ul > li")).toHaveCount(2);

    // Reopening keeps only user choices; the reviewer explicitly refreshes the preview.
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.evaluate(() => { localStorage.setItem("e2e-preparation-locale", "zh-Hans"); document.cookie = "multica-locale=zh-Hans; path=/"; });
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    await page.getByRole("button", { name: "继续模板设置", exact: true }).click();
    await dialog.getByRole("button", { name: "核对将执行的变更", exact: true }).click();
    const chinesePreview = dialog.getByRole("region", { name: "核对将执行的变更", exact: true }); await expect(chinesePreview).toBeVisible();
    await expect(chinesePreview.locator(":scope > ul > li")).toHaveCount(25);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("meeting-preparation-preview-390-zh-dark.png"), animations: "disabled" });
    const paginationBefore = await chinesePreview.getByRole("button", { name: "下一页", exact: true }).boundingBox();
    const confirmationBefore = await dialog.getByRole("checkbox").boundingBox(); expect(paginationBefore).not.toBeNull(); expect(confirmationBefore).not.toBeNull();
    await chinesePreview.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(chinesePreview.locator(":scope > ul > li")).toHaveCount(2);
    await expect.poll(async () => Math.abs((await chinesePreview.getByRole("button", { name: "下一页", exact: true }).boundingBox())!.y - paginationBefore!.y)).toBeLessThan(2);
    await expect.poll(async () => Math.abs((await dialog.getByRole("checkbox").boundingBox())!.y - confirmationBefore!.y)).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath("meeting-preparation-preview-page-two-390-zh-dark.png"), animations: "disabled" });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.evaluate(() => { localStorage.setItem("e2e-preparation-locale", "en"); document.cookie = "multica-locale=en; path=/"; });
    await page.setViewportSize({ width: 1500, height: 1050 }); await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Continue template setup", exact: true }).click();
    await dialog.getByRole("button", { name: "Review the planned changes", exact: true }).click();
    await expect(preview.getByText("27 selected items", { exact: true })).toBeVisible();

    const effectPattern = new RegExp(`/api/cockpit/meetings/${meeting.id}/preparation-operations/[^/]+/effects/[^/]+/apply$`);
    const writes: { effectId: string; status: number; body: { command_key: string; authorization_key: string; authorization_revision: number } }[] = [];
    let firstEffectId = "";
    let exactReadsAfterLost = 0;
    page.on("request", (request) => { if (request.method() === "GET" && firstEffectId && new URL(request.url()).pathname.endsWith(`/effects/${firstEffectId}`)) exactReadsAfterLost += 1; });
    await page.route(effectPattern, async (route) => {
      const request = route.request(); const effectId = new URL(request.url()).pathname.split("/").at(-2)!;
      if (request.method() !== "POST") { await route.continue(); return; }
      // Commit the first real effect, then simulate only its response being lost.
      if (writes.length === 0) {
        firstEffectId = effectId; const response = await route.fetch(); expect(response.ok()).toBe(true);
        writes.push({ effectId, status: response.status(), body: request.postDataJSON() }); await route.abort("failed"); return;
      }
      const response = await route.fetch(); writes.push({ effectId, status: response.status(), body: request.postDataJSON() }); await route.fulfill({ response });
    });
    await dialog.getByRole("checkbox", { name: "Apply only these selected changes. New issues remain in backlog and no execution starts.", exact: true }).check();
    await dialog.getByRole("button", { name: "Apply selected changes", exact: true }).click(); await expect(dialog).toBeHidden();
    await expect.poll(() => new URL(page.url()).searchParams.get("preparation")).toBeTruthy(); const operationId = new URL(page.url()).searchParams.get("preparation")!;
    const progress = page.getByRole("region", { name: "Preparation progress", exact: true });
    await expect(progress.getByText("Further items have stopped. Check the last item’s result before choosing to continue.", { exact: true })).toBeVisible();
    expect(writes).toHaveLength(1); expect(exactReadsAfterLost).toBeGreaterThan(0);
    expect((await api.getOwnedPreparationOperation(meeting.id, operationId)).counts).toMatchObject({ total: 27, applied: 1, pending: 26 });
    await progress.getByRole("button", { name: "Continue remaining items", exact: true }).click();
    await expect.poll(async () => (await api.getOwnedPreparationOperation(meeting.id, operationId)).state, { timeout: 45_000 }).toBe("completed");
    expect(writes).toHaveLength(27); expect(writes.every((write) => write.status >= 200 && write.status < 300)).toBe(true);
    expect(writes.filter((write) => write.effectId === firstEffectId)).toHaveLength(1);
    await page.unroute(effectPattern);
    const first = await api.getOwnedPreparationEffects(meeting.id, operationId); expect(first.items).toHaveLength(25); expect(first.next_cursor).toBeTruthy();
    const second = await api.getOwnedPreparationEffects(meeting.id, operationId, first.next_cursor!); expect(second.items).toHaveLength(2); expect(second.next_cursor).toBeNull();
    const effects = [...first.items, ...second.items]; expect(new Set(effects.map((effect) => effect.id)).size).toBe(27); expect(effects.every((effect) => effect.state === "applied" && effect.receipt)).toBe(true);
    const createdIssues = effects.filter((effect) => effect.kind === "preparation_issue"); expect(createdIssues).toHaveLength(25);
    for (const effect of createdIssues) expect(await api.getIssue(effect.receipt!.issue_id!)).toMatchObject({ status: "backlog", assignee_type: null, assignee_id: null });
    expect(await api.getWorkspaceAgentRunCount()).toBe(0); expect((await api.getOwnedMeetingLifecycle(meeting.id)).materials).toBeNull();

    // Cancellation and subsequent disposition are distinct explicit confirmations.
    const cancelledIssueId = createdIssues.find((effect) => effect.label === "Prepare evidence 01")!.receipt!.issue_id!;
    await page.getByRole("button", { name: "Meeting actions", exact: true }).click();
    await expect(dialog.getByRole("button", { name: `Delete meeting ${meeting.title}`, exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel meeting", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Reason", exact: true }).fill("The planned discussion will not be held.");
    const impact = dialog.getByRole("region", { name: "Preparation affected by cancellation", exact: true });
    for (let i = 1; i <= 25; i++) {
      const title = `Prepare evidence ${String(i).padStart(2, "0")}`;
      await impact.getByRole("textbox", { name: "Search preparation issues", exact: true }).fill(title);
      const row = impact.getByRole("listitem").filter({ has: page.getByRole("link", { name: new RegExp(title) }) });
      await choose(page, row.getByRole("combobox"), i === 1 ? "Cancel preparation issue" : "Change preparation deadline");
      if (i !== 1) await row.getByLabel(/^Due date/).fill("2027-01-15");
    }
    await impact.getByRole("textbox", { name: "Search preparation issues", exact: true }).fill(source.title);
    const sourceRow = impact.getByRole("listitem").filter({ has: page.getByRole("link", { name: new RegExp(source.title) }) });
    await choose(page, sourceRow.getByRole("combobox"), "Change preparation deadline"); await sourceRow.getByLabel(/^Due date/).fill("2027-01-15");
    const cancellationWrites: typeof writes = []; let changedEffectId = "", forceChange = true;
    await page.route(effectPattern, async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      const effectId = new URL(route.request().url()).pathname.split("/").at(-2)!;
      // Only deadline disposition freezes the Issue revision; references retain identity.
      if (cancellationWrites.length === 25 && forceChange) {
        forceChange = false; changedEffectId = effectId; await api.updateIssue(source.id, { title: "Existing evidence revised by a participant" });
      }
      const response = await route.fetch(); cancellationWrites.push({ effectId, status: response.status(), body: route.request().postDataJSON() }); await route.fulfill({ response });
    });
    const cancellationPreviewRead = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/cockpit/meetings/${meeting.id}/cancellation/preview`);
    await dialog.getByRole("button", { name: "Preview cancellation", exact: true }).click();
    const cancellationPreviewResponse = await cancellationPreviewRead; expect(cancellationPreviewResponse.ok()).toBe(true);
    const cancellationPreview = await cancellationPreviewResponse.json();
    const cancellationEffect = cancellationPreview.effects.find((effect: { kind: string; issue_impact: { issue: { id: string }; cancel_status: string | null } | null }) => effect.kind === "cancel_issue" && effect.issue_impact?.issue.id === cancelledIssueId);
    const observedCancelStatus = cancellationEffect?.issue_impact?.cancel_status;
    if (typeof observedCancelStatus !== "string" || !observedCancelStatus) throw new Error("Cancellation preview did not acknowledge an exact issue status key");
    await dialog.getByRole("checkbox", { name: "Record this cancellation and only the dispositions shown above.", exact: true }).check();
    await dialog.getByRole("button", { name: "Cancel meeting", exact: true }).click(); await expect(dialog).toBeHidden();
    await expect.poll(async () => (await api.getOwnedMeetingLifecycle(meeting.id)).occurrence.state).toBe("cancelled");
    const cancellation = (await api.getOwnedMeetingLifecycle(meeting.id)).occurrence;
    await expect.poll(() => { const id = new URL(page.url()).searchParams.get("preparation"); return Boolean(id && id !== operationId); }).toBe(true);
    const cancellationOperation = new URL(page.url()).searchParams.get("preparation")!; expect(cancellationOperation).toBeTruthy();
    await expect.poll(async () => (await api.getOwnedPreparationOperation(meeting.id, cancellationOperation)).counts, { timeout: 45_000 }).toMatchObject({ total: 26, applied: 25, needs_attention: 1 });
    await expect(progress.getByText("Processing stopped at an item that requires review. Confirmed earlier items remain intact.", { exact: true })).toBeVisible();
    expect(cancellationWrites).toHaveLength(26); expect(cancellationWrites.at(-1)?.status).toBe(409);
    await progress.getByRole("button", { name: "Locate the current item", exact: true }).click();
    const changedRow = progress.getByRole("listitem", { name: source.title, exact: true }); await expect(changedRow).toBeVisible();
    await changedRow.getByRole("button", { name: "Review this item again", exact: true }).click();
    await expect(dialog.getByText(`${sourceIssue.identifier} ${source.title}`, { exact: true })).toBeVisible();
    await expect(dialog.getByText(`${sourceIssue.identifier} Existing evidence revised by a participant`, { exact: true })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Reason", exact: true }).fill("Reviewed the participant's revision; retain this explicit later deadline.");
    await dialog.getByRole("checkbox", { name: "I have compared the previous and current impact and authorize this original item.", exact: true }).check();
    await dialog.getByRole("button", { name: "Confirm current impact", exact: true }).click(); await expect(dialog).toBeHidden();
    expect(cancellationWrites).toHaveLength(26);
    await progress.getByRole("button", { name: "Continue remaining items", exact: true }).click();
    await expect.poll(async () => (await api.getOwnedPreparationOperation(meeting.id, cancellationOperation)).state, { timeout: 45_000 }).toBe("completed");
    const retry = cancellationWrites.filter((write) => write.effectId === changedEffectId); expect(retry).toHaveLength(2);
    expect(retry[1]!.body.command_key).toBe(retry[0]!.body.command_key); expect(retry[1]!.body.authorization_key).not.toBe(retry[0]!.body.authorization_key);
    expect(retry[1]!.body.authorization_revision).toBeGreaterThan(retry[0]!.body.authorization_revision);
    expect((await api.getIssue(source.id)).due_date).toBe("2027-01-15"); await page.unroute(effectPattern);

    expect(await api.getIssue(cancelledIssueId)).toMatchObject({ status: observedCancelStatus, status_category: "cancelled" });
    await page.getByRole("button", { name: "Meeting actions", exact: true }).first().click();
    await dialog.getByRole("button", { name: "Handle remaining preparation", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Reason", exact: true }).fill("Retain the remaining evidence with an explicit later deadline.");
    await impact.getByRole("textbox", { name: "Search preparation issues", exact: true }).fill("Prepare evidence 02");
    const dueRow = impact.getByRole("listitem").filter({ has: page.getByRole("link", { name: /Prepare evidence 02/ }) });
    await choose(page, dueRow.getByRole("combobox"), "Change preparation deadline"); await dueRow.getByLabel(/^Due date/).fill("2027-02-15");
    await dialog.getByRole("button", { name: "Preview preparation changes", exact: true }).click();
    await dialog.getByRole("checkbox", { name: "Apply only these preparation changes. Keep the existing cancellation record.", exact: true }).check();
    await dialog.getByRole("button", { name: "Handle remaining preparation", exact: true }).click(); await expect(dialog).toBeHidden();
    await expect.poll(() => { const id = new URL(page.url()).searchParams.get("preparation"); return Boolean(id && id !== cancellationOperation); }).toBe(true);
    const appendedOperation = new URL(page.url()).searchParams.get("preparation")!; expect(appendedOperation).toBeTruthy(); expect(appendedOperation).not.toBe(cancellationOperation);
    await expect.poll(async () => (await api.getOwnedPreparationOperation(meeting.id, appendedOperation)).state, { timeout: 45_000 }).toBe("completed");
    expect((await api.getOwnedMeetingLifecycle(meeting.id)).occurrence).toEqual(cancellation);
    const changedDueIssue = createdIssues.find((effect) => effect.label === "Prepare evidence 02")!.receipt!.issue_id!;
    expect(await api.getIssue(changedDueIssue)).toMatchObject({ due_date: "2027-02-15", status: "backlog" });

    await page.getByRole("button", { name: "Meeting actions", exact: true }).first().click(); await dialog.getByRole("button", { name: "Archive meeting", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Reason", exact: true }).fill("Keep this cancelled meeting and its preparation history available.");
    await dialog.getByRole("button", { name: "Archive meeting", exact: true }).click(); await expect(dialog).toBeHidden();
    await expect.poll(async () => Boolean((await api.getOwnedMeetingLifecycle(meeting.id)).archive?.archived_at)).toBe(true);
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    await expect(page.getByRole("link", { name: `Open ${meeting.title}`, exact: true })).toHaveCount(0);
    await choose(page, page.getByRole("combobox", { name: "Meeting archive filter", exact: true }), "All meetings");
    await page.getByRole("link", { name: `Open ${meeting.title}`, exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("meeting_archive")).toBe("all");
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Meeting archive filter", exact: true }).locator('[data-slot="select-value"]')).toHaveText("All meetings");
    await page.getByRole("link", { name: `Open ${meeting.title}`, exact: true }).click();
    await page.getByRole("button", { name: "Meeting actions", exact: true }).first().click(); await dialog.getByRole("button", { name: "Unarchive meeting", exact: true }).click();
    await dialog.getByRole("textbox", { name: "Reason", exact: true }).fill("Return this retained meeting to the active register.");
    await dialog.getByRole("button", { name: "Unarchive meeting", exact: true }).click(); await expect(dialog).toBeHidden();
    await expect.poll(async () => (await api.getOwnedMeetingLifecycle(meeting.id)).archive?.archived_at).toBeNull();
    expect((await api.getOwnedMeetingLifecycle(meeting.id)).occurrence).toEqual(cancellation); expect(await api.getWorkspaceAgentRunCount()).toBe(0);

    // Read the fixed results in Chinese at a narrow size; no additional writes.
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.evaluate(() => { localStorage.setItem("e2e-preparation-locale", "zh-Hans"); document.cookie = "multica-locale=zh-Hans; path=/"; });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${workspace.slug}/cockpit?meeting=${meeting.id}&meeting_view=agenda&preparation=${operationId}&meeting_archive=all`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveClass(/dark/);
    const narrow = page.getByRole("region", { name: "准备处理进度", exact: true }); await expect(narrow).toBeVisible();
    await narrow.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("meeting-preparation-progress-390-zh-dark.png"), animations: "disabled" });
    await narrow.getByRole("button", { name: "下一页", exact: true }).click(); await expect(narrow.getByRole("listitem", { name: "Check the existing evidence", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("meeting-preparation-results-390-zh-dark.png"), animations: "disabled" });
  } finally { if (owned) await api.cleanupCreatedWorkspace(); }
});
