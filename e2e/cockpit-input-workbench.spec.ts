import { expect, test } from "@playwright/test";
import { CockpitInputTestClient } from "./helpers/cockpit-input-client";
import zh from "../packages/views/locales/zh-Hans/cockpit.json" with { type: "json" };

const words = zh.input_materials;
test.use({ viewport: { width: 1500, height: 1050 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", contextOptions: { reducedMotion: "reduce" }, screenshot: "only-on-failure", trace: "retain-on-failure" });

test("uses real fixed inputs without L3, recovers a lost receipt, preserves topic context and requires explicit task delivery and readiness", async ({ page }, testInfo) => {
  test.setTimeout(240_000); page.setDefaultTimeout(20_000);
  const fixture = new CockpitInputTestClient(), api = fixture.api;
  const run = `${Date.now().toString(36)}-${process.pid}`;
  const auth = await api.login(`e2e-input-${run}@multica.ai`, "输入资料验收人");
  try {
    const workspace = await fixture.createWorkspace(run); await api.markUserOnboarded(); await api.updateCockpitBoard({ title: "项目驾驶舱资料闭环验收" });
    const meeting = await fixture.createMeeting("输入资料与人类确认评审会");
    const capabilities = await fixture.capabilities();
    expect(capabilities).toMatchObject({ can_create: true, direct_upload_available: true });
    expect((await api.getMeetingWorkflow(meeting.id)).enabled).toBe(false);
    expect((await api.getOwnedMeetingLifecycle(meeting.id)).materials).toBeNull();
    const token = api.getToken(); if (!token) throw new Error("Owned login token missing");
    await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = "multica-locale=zh-Hans; path=/"; }, token);
    const base = `/${workspace.slug}/cockpit?meeting=${meeting.id}`;
    const resources = `${base}&meeting_view=resources`;
    const bytes = Buffer.from("验收材料：边界、问题和下一步执行方向。\n输入固定不等于人类已确认齐备。\n");
    const filename = "评审会原始资料.txt";
    const title = "评审会固定输入资料";
    let createWrites = 0, createdInputId = "";
    await page.route("**/api/cockpit/inputs", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      createWrites += 1;
      const response = await route.fetch(); expect(response.status()).toBeGreaterThanOrEqual(200); expect(response.status()).toBeLessThan(300);
      const result = await response.json(); createdInputId = result.receipt.input_id; expect(createdInputId).toBeTruthy();
      await route.abort("failed");
    });
    await page.goto(resources, { waitUntil: "domcontentloaded" });
    const materials = () => page.getByRole("region", { name: words.title, exact: true });
    await materials().getByRole("button", { name: words.upload, exact: true }).click();
    const upload = () => page.getByRole("dialog", { name: words.upload, exact: true });
    await upload().locator('input[type="file"]').setInputFiles({ name: filename, mimeType: "text/plain", buffer: bytes });
    await upload().getByRole("textbox", { name: words.name, exact: true }).fill(title);
    await upload().getByRole("button", { name: words.upload_and_fix, exact: true }).click();
    await expect(upload().getByText(words.command_unconfirmed, { exact: true })).toBeVisible();
    await expect(upload().getByRole("button", { name: words.verify_command, exact: true })).toBeEnabled();
    await upload().getByRole("button", { name: words.return_materials, exact: true }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    // The retained request is discoverable before the new-registration toolbar.
    await page.getByRole("button", { name: words.upload, exact: false }).first().click();
    await upload().getByRole("button", { name: words.verify_command, exact: true }).click();
    await expect(upload().getByRole("button", { name: words.continue_upload, exact: true })).toBeVisible();
    await upload().locator('input[type="file"]').setInputFiles({ name: filename, mimeType: "text/plain", buffer: bytes });
    await upload().getByRole("button", { name: words.continue_upload, exact: true }).click();
    const detail = () => page.getByRole("dialog", { name: words.material_detail, exact: true });
    await expect(detail().getByRole("button", { name: words.download_version, exact: true })).toBeEnabled();
    const exact = new URL(page.url()); const inputId = exact.searchParams.get("input"), versionId = exact.searchParams.get("input_version");
    expect(inputId).toBe(createdInputId); expect(versionId).toBeTruthy(); expect(createWrites).toBe(1);
    await fixture.assertCopy(inputId!, versionId!, bytes);
    expect((await fixture.references(meeting.id)).items).toEqual([expect.objectContaining({ input_id: inputId, agenda_id: null, version: expect.objectContaining({ id: versionId, capture_state: "ready" }) })]);
    expect((await api.getOwnedMeetingLifecycle(meeting.id)).materials).toBeNull();
    await page.screenshot({ path: testInfo.outputPath("zh-input-fixed-without-l3.png"), animations: "disabled" });
    await detail().getByRole("button", { name: "Close", exact: true }).click(); await expect(page).toHaveURL(resources);
    await page.unroute("**/api/cockpit/inputs");

    const header = await api.getOwnedMeetingLifecycle(meeting.id);
    const agenda = await api.ownedMeetingLifecycleCommand(meeting.id, "/agenda", { command_key: crypto.randomUUID(), expected_revision: header.agenda_revision,
      title: "边界核对与准备", purposes: ["boundary_confirmation"], desired_outcome: "明确本次准备范围", notes: "议题草稿需在查看材料往返时保留" });
    const agendaId = agenda.receipt.agenda_id!; expect(agendaId).toBeTruthy();
    const preparation = await api.ownedMeetingLifecycleCommand(meeting.id, `/agenda/${agendaId}/preparation-issues`, { command_key: crypto.randomUUID(), expected_revision: agenda.receipt.agenda!.revision,
      primary_node_id: null, new_issue: { title: "人工核对固定输入", description: "确认边界和问题", priority: "none", assignee_type: "member", assignee_id: auth.user.id, project_id: null, module_id: null, due_date: null } });
    const preparationIssueId = preparation.receipt.issue_id!; expect(preparationIssueId).toBeTruthy();
    const agendaPath = `${base}&meeting_view=agenda&agenda=${agendaId}`;
    await page.goto(agendaPath, { waitUntil: "domcontentloaded" });
    const notes = page.getByRole("textbox", { name: zh.meeting_lifecycle.notes, exact: true });
    await notes.fill("尚未保存的议题观察：原始材料与运行固定清单不同。");
    await materials().getByRole("button", { name: words.link_existing, exact: true }).click();
    const library = page.getByRole("dialog", { name: words.choose_fixed_version, exact: true });
    await library.getByRole("button", { name: new RegExp(title) }).click();
    await library.getByRole("button", { name: words.select_version_named.replace("{{name}}", title).replace("{{number}}", "1"), exact: true }).click();
    const reference = page.getByRole("dialog", { name: words.link_version, exact: true });
    await expect(reference.getByText(/边界核对与准备/)).toBeVisible();
    await reference.getByRole("button", { name: words.link_version, exact: true }).click();
    await expect(reference).toBeHidden(); await expect(notes).toHaveValue("尚未保存的议题观察：原始材料与运行固定清单不同。");
    const topicRefs = await fixture.references(meeting.id, agendaId); expect(topicRefs.total).toBe(1); expect(topicRefs.items[0]).toMatchObject({ input_id: inputId, agenda_id: agendaId, version: { id: versionId } });
    expect((await fixture.references(meeting.id)).total).toBe(2);
    await materials().getByRole("button", { name: title, exact: true }).click();
    await detail().getByRole("button", { name: words.handoff, exact: true }).click();
    const handoff = page.getByRole("dialog", { name: words.handoff, exact: true });
    await handoff.getByRole("button", { name: /人工核对固定输入/ }).click();
    const manifest = page.getByRole("dialog", { name: words.manifest_edit, exact: true });
    expect((await fixture.manifest(preparationIssueId)).current_version).toBeNull();
    await manifest.getByRole("button", { name: words.manifest_add_suggested, exact: true }).click();
    expect((await fixture.manifest(preparationIssueId)).current_version).toBeNull();
    await manifest.getByRole("button", { name: words.manifest_save, exact: true }).click();
    await expect(manifest).toBeHidden();
    expect((await fixture.manifest(preparationIssueId)).counts).toMatchObject({ total: 1, required: 1 });
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
    await handoff.getByRole("button", { name: "Close", exact: true }).click();
    await detail().getByRole("button", { name: "Close", exact: true }).click();
    await expect(page).toHaveURL(agendaPath); await expect(notes).toHaveValue("尚未保存的议题观察：原始材料与运行固定清单不同。");

    const project = await api.createProject("纪要任务所属项目"), module = await api.createModule(project.id, "纪要模块");
    await api.enableMeetingWorkflow(meeting.id, { reviewer_id: auth.user.id, project_id: project.id, module_id: module.id, assignee_type: "member", assignee_id: auth.user.id });
    await page.goto(`${base}&meeting_view=workflow`, { waitUntil: "domcontentloaded" });
    const readiness = page.getByRole("region", { name: zh.workflow.readiness, exact: true });
    await expect(readiness).toContainText(zh.workflow.need_materials);
    const prepareLink = readiness.getByRole("link", { name: zh.meeting_materials.prepare, exact: true });
    await expect(prepareLink).toHaveAttribute("href", resources); await prepareLink.click(); await expect(materials()).toBeVisible();
    expect((await api.getMeetingWorkflow(meeting.id)).materials_ready).toBe(false);
    // Populate real topic references using the same immutable copy: no extra
    // file captures, fake material IDs, or unbounded browser fixture payloads.
    let lifecycle = await api.getOwnedMeetingLifecycle(meeting.id);
    for (let index = 1; index <= 30; index++) {
      const result = await api.ownedMeetingLifecycleCommand(meeting.id, "/agenda", { command_key: crypto.randomUUID(), expected_revision: lifecycle.agenda_revision,
        title: `分页讨论议题 ${String(index).padStart(2, "0")}`, purposes: ["question_clarification"], desired_outcome: "逐项核对输入", notes: "" });
      lifecycle = result.current; await fixture.reference(meeting.id, versionId!, result.receipt.agenda_id!);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(materials().getByRole("listitem")).toHaveCount(25);
    await materials().getByRole("button", { name: zh.task_flow.next, exact: true }).click();
    await expect(materials().getByRole("listitem")).toHaveCount(7);
    await materials().getByRole("button", { name: title, exact: true }).first().click(); await detail().getByRole("button", { name: "Close", exact: true }).click();
    await expect(materials().getByRole("listitem")).toHaveCount(7);
    await page.screenshot({ path: testInfo.outputPath("zh-inputs-page-two-wide.png"), animations: "disabled" });
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(materials()).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("zh-inputs-page-two-narrow.png"), animations: "disabled" });
    expect((await api.getMeetingWorkflow(meeting.id)).materials_ready).toBe(false); expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath("failure-before-cleanup.png"), animations: "disabled" });
    throw error;
  } finally { await fixture.cleanup(); }
});

test("fixes an owned shared-folder file and ends a changed-source registration without losing the material pointer", async ({ page }, testInfo) => {
  test.setTimeout(180_000); page.setDefaultTimeout(20_000);
  test.skip(!process.env.MULTICA_E2E_NAS_ROOT_PATH || !process.env.MULTICA_E2E_NAS_ROOT_ID || !process.env.MULTICA_E2E_NAS_WORKSPACE_ID,
    "Requires the configured agent 3 local input-e2e root");
  const { createOwnedInputFilesystem } = await import("./helpers/cockpit-input-filesystem");
  const filesystem = await createOwnedInputFilesystem(); const fixture = new CockpitInputTestClient(), api = fixture.api;
  const run = `nas-${Date.now().toString(36)}-${process.pid}`;
  try {
    await api.login(`e2e-input-${run}@multica.ai`, "资料登记验收人");
    const workspace = await fixture.createWorkspace(run, true); await api.markUserOnboarded(); await api.updateCockpitBoard({ title: "共享目录资料验收" });
    const meeting = await fixture.createMeeting("资料登记与结束操作验收");
    const token = api.getToken(); if (!token) throw new Error("Owned login token missing");
    await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = "multica-locale=zh-Hans; path=/"; }, token);
    const resources = `/${workspace.slug}/cockpit?meeting=${meeting.id}&meeting_view=resources`;
    await page.goto(resources, { waitUntil: "domcontentloaded" });
    const materials = page.getByRole("region", { name: words.title, exact: true });
    const choose = async (name: string) => {
      await materials.getByRole("button", { name: words.choose_nas, exact: true }).click();
      const picker = page.getByRole("dialog", { name: words.choose_nas, exact: true });
      // A completed batch preserves this directory for the next selection.
      if (!await picker.getByRole("checkbox", { name, exact: true }).count()) {
        await picker.getByRole("combobox", { name: words.source_directory, exact: true }).click();
        await page.getByRole("option", { name: `${filesystem.root} · input-e2e`, exact: true }).click();
        await picker.getByRole("searchbox", { name: words.search_directory, exact: true }).fill(filesystem.directoryName);
        await picker.getByRole("button", { name: filesystem.directoryName, exact: true }).click();
      }
      await picker.getByRole("checkbox", { name, exact: true }).check();
      await picker.getByRole("button", { name: words.review_selection, exact: true }).click();
      return page.getByRole("dialog", { name: words.review_selection, exact: true });
    };
    const first = await choose(filesystem.names.stable);
    await first.getByRole("button", { name: words.register_selection, exact: true }).click();
    await expect(first.getByRole("button", { name: words.finish_batch, exact: true })).toBeEnabled();
    await first.getByRole("button", { name: words.open_registered, exact: true }).click();
    const detail = page.getByRole("dialog", { name: words.material_detail, exact: true });
    await expect(detail.getByRole("button", { name: words.download_version, exact: true })).toBeEnabled({ timeout: 45_000 });
    const exact = new URL(page.url()); await fixture.assertCopy(exact.searchParams.get("input")!, exact.searchParams.get("input_version")!, filesystem.initial);
    expect((await api.getOwnedMeetingLifecycle(meeting.id)).materials).toBeNull();
    await detail.getByRole("button", { name: "Close", exact: true }).click();
    await materials.getByRole("button", { name: words.choose_nas, exact: true }).click();
    await page.getByRole("dialog", { name: words.review_selection, exact: true }).getByRole("button", { name: words.finish_batch, exact: true }).click();

    let rejectedInputId = "", failures = 0;
    await page.route("**/api/cockpit/inputs/*/versions", async (route) => {
      if (route.request().method() !== "POST" || route.request().postDataJSON()?.source?.kind !== "nas_file") { await route.continue(); return; }
      failures += 1; rejectedInputId = new URL(route.request().url()).pathname.split("/").at(-2)!;
      await filesystem.changeObservedFile();
      // Continue through the real handler. The stale observation must reject
      // this command before a version is created; this is not a mocked 409.
      await route.continue();
    });
    const second = await choose(filesystem.names.changed);
    const rejected = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/cockpit\/inputs\/[^/]+\/versions$/.test(new URL(response.url()).pathname));
    await second.getByRole("button", { name: words.register_selection, exact: true }).click();
    const rejection = await rejected; expect(rejection.status()).toBe(409); expect(await rejection.json()).toMatchObject({ code: "source_changed" });
    await expect(second.getByText(words.header_registered, { exact: true })).toBeVisible();
    await expect(second.getByRole("button", { name: words.end_registration, exact: true })).toBeEnabled();
    expect(await fixture.input(rejectedInputId)).toMatchObject({ current_version: null, version_total: 0, archived_at: null });
    await second.getByRole("button", { name: words.end_registration, exact: true }).click();
    const ending = page.getByRole("dialog", { name: words.end_registration, exact: true });
    await ending.getByRole("textbox", { name: words.end_reason, exact: true }).fill("来源已变化，本次不再需要此资料，保留登记入口供以后核对。");
    await ending.getByRole("button", { name: words.end_registration, exact: true }).click();
    await expect(second.getByText(words.registration_ended, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("zh-nas-registration-ended-wide.png"), animations: "disabled" });
    await second.getByRole("button", { name: words.finish_batch, exact: true }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(words.local_records.replace("{{count}}", "1"), { exact: true }).click();
    await expect(page.getByText(words.local_records_hint, { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText(words.local_records_hint, { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath("zh-local-registration-record-390.png"), animations: "disabled" });
    await page.getByRole("button", { name: words.open_registered, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`input=${rejectedInputId}`));
    await detail.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: words.remove_local_record, exact: true }).click();
    const removal = page.getByRole("dialog", { name: words.remove_local_record, exact: true });
    await expect(removal.getByText(words.remove_local_record_hint, { exact: true })).toBeVisible();
    await removal.getByRole("button", { name: words.remove_local_record, exact: true }).click();
    await expect(page.getByText(words.local_records.replace("{{count}}", "1"), { exact: true })).toHaveCount(0);
    expect(await fixture.input(rejectedInputId)).toMatchObject({ current_version: null, version_total: 0, archived_at: null });
    expect((await fixture.references(meeting.id)).total).toBe(1); expect(failures).toBe(1); expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } finally { try { await fixture.cleanup(); } finally { await filesystem.cleanup(); } }
});
