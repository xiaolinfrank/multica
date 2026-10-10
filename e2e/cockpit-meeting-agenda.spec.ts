import { expect, test, type Page } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({ viewport: { width: 1500, height: 1050 }, locale: "en-US", timezoneId: "Asia/Shanghai", contextOptions: { reducedMotion: "reduce" }, screenshot: "only-on-failure", trace: "retain-on-failure" });
async function authenticate(page: Page, api: TestApiClient) {
  const token = api.getToken(); if (!token) throw new Error("Missing owned fixture token");
  await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = `multica-locale=${localStorage.getItem("e2e-meeting-locale") || "en"}; path=/`; }, token);
}

test("keeps agenda preparation and occurrence explicit, bounded and recoverable without a minutes workflow", async ({ page }, testInfo) => {
  test.setTimeout(180_000); page.setDefaultTimeout(15_000);
  const api = new TestApiClient(), run = `${Date.now().toString(36)}-${process.pid}`; let owned = false;
  const auth = await api.login(`e2e-agenda-${run}@multica.ai`, "Agenda owner");
  try {
    const workspace = await api.createWorkspace(`Agenda workbench ${run}`, `e2e-agenda-${run}`); owned = true; await api.markUserOnboarded();
    await api.updateCockpitBoard({ title: "Programme meeting preparation" });
    const meeting = await api.createCockpitMeeting({ title: "Boundary and preparation review", meet_date: "2020-01-01" });
    const project = await api.createProject("Meeting source programme"), module = await api.createModule(project.id, "Fixed evidence");
    const root = await api.createCockpitNode({ code: "01", name: "Evidence programme", project_id: project.id });
    const group = await api.createCockpitNode({ code: "01.01", name: "Evidence module", module_id: module.id, parent_id: root.id });
    const leaf = await api.createCockpitNode({ code: "01.01.01", name: "Prepare the fixed meeting input", parent_id: group.id });
    const source = await api.createIssue("Produce meeting input", { project_id: project.id, module_id: module.id, status: "backlog", assignee_type: "member", assignee_id: auth.user.id });
    const artifact = await api.createOwnedPendingTextArtifact(leaf.id, source.id, auth.user.id); const fixedVersion = artifact.current_version;
    if (!fixedVersion) throw new Error("Owned fixed material fixture has no version");
    let header = await api.getOwnedMeetingLifecycle(meeting.id);
    expect(header).toMatchObject({ workflow_enabled: false, occurrence: { state: "unconfirmed", ended_at: null, actual_started_at: null, actual_ended_at: null }, materials: null });
    const bodyMarker = "TOPIC_BODY_MUST_NOT_APPEAR_IN_METADATA_";
    const agendaIds: string[] = [];
    for (let i = 1; i <= 31; i++) {
      const result = await api.ownedMeetingLifecycleCommand(meeting.id, "/agenda", { command_key: crypto.randomUUID(), expected_revision: header.agenda_revision,
        title: `Boundary topic ${String(i).padStart(2, "0")}`, purposes: ["boundary_confirmation"], desired_outcome: "Agree the practical handover boundary", notes: `${bodyMarker}${i}\n${"Evidence remains editable until explicitly fixed.\n".repeat(750)}` });
      expect(result.receipt.agenda_id).toBeTruthy(); agendaIds.push(result.receipt.agenda_id!); header = result.current;
    }
    await authenticate(page, api);
    const bodyReads: string[] = [];
    page.on("request", (request) => { const pathname = new URL(request.url()).pathname; if (request.method() === "GET" && new RegExp(`/meetings/${meeting.id}/agenda/[0-9a-f-]{36}$`).test(pathname)) bodyReads.push(pathname); });
    const base = `/${workspace.slug}/cockpit?meeting=${meeting.id}&meeting_view=agenda`;
    const firstPage = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/cockpit/meetings/${meeting.id}/agenda` && response.request().method() === "GET");
    await page.goto(base, { waitUntil: "domcontentloaded" }); const first = await firstPage;
    expect(first.status()).toBe(200); const metadata = await first.json(); expect(metadata.items).toHaveLength(25); expect(metadata.total).toBe(31); expect(JSON.stringify(metadata)).not.toContain(bodyMarker);
    expect(JSON.stringify(metadata)).not.toContain('"notes"'); expect(JSON.stringify(metadata)).not.toContain('"desired_outcome"'); expect(bodyReads).toEqual([]);
    await expect(page.getByRole("link", { name: "Open agenda: Boundary topic 25", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(page.getByText("This note does not confirm that the meeting started or ended.", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Record meeting occurrence", exact: true }).click();
    expect((await api.getOwnedMeetingLifecycle(meeting.id)).occurrence.state).toBe("unconfirmed");
    await page.getByRole("button", { name: "Next page", exact: true }).click(); await expect(page.getByRole("link", { name: "Open agenda: Boundary topic 31", exact: true })).toBeVisible(); expect(bodyReads).toEqual([]);
    await page.getByRole("textbox", { name: "Search agenda", exact: true }).fill("Boundary topic 01"); await expect(page.getByRole("link", { name: "Open agenda: Boundary topic 01", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Open agenda: Boundary topic 01", exact: true }).click();
    const notes = page.getByRole("textbox", { name: "Discussion notes", exact: true }); await expect(notes).toHaveValue(new RegExp(bodyMarker)); expect([...new Set(bodyReads)]).toEqual([`/api/cockpit/meetings/${meeting.id}/agenda/${agendaIds[0]}`]);
    const notesBox = await notes.boundingBox(); expect(notesBox).not.toBeNull(); expect(notesBox!.height).toBeLessThanOrEqual(page.viewportSize()!.height * 0.46);
    const mine = "  My unsaved observations\n"; await notes.fill(mine);
    await api.ownedMeetingLifecycleCommand(meeting.id, `/agenda/${agendaIds[0]}`, { command_key: crypto.randomUUID(), expected_revision: 1, notes: "Another participant clarified the handover boundary" }, "PATCH");
    await expect(page.getByText("The record changed while you were editing. Review the latest record before applying your draft.", { exact: true })).toBeVisible(); await expect(notes).toHaveValue(mine);
    await page.getByText("Reload latest record", { exact: true }).first().click(); await expect(page.getByText("Another participant clarified the handover boundary", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Use latest revision, keep my draft", exact: true }).click();
    const saved = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/cockpit/meetings/${meeting.id}/agenda/${agendaIds[0]}`);
    await page.getByRole("button", { name: "Save agenda item", exact: true }).click(); expect((await saved).status()).toBe(200); await expect(notes).toHaveValue(mine);

    let preparationIssueId = "", preparationWrites = 0;
    const prepPath = `/api/cockpit/meetings/${meeting.id}/agenda/${agendaIds[0]}/preparation-issues`;
    await page.route(`**${prepPath}`, async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      preparationWrites += 1;
      const response = await route.fetch(); expect(response.status()).toBeGreaterThanOrEqual(200); expect(response.status()).toBeLessThan(300);
      const confirmed = await response.json(); preparationIssueId = confirmed.receipt.issue_id; expect(preparationIssueId).toBeTruthy();
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "Create preparation issue", exact: true }).click(); const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Issue title", exact: true }).fill("Collect boundary source evidence");
    await dialog.getByRole("textbox", { name: "Issue details", exact: true }).fill("Source links and the handover checklist must remain available.");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click(); await page.getByRole("button", { name: "Create preparation issue", exact: true }).click();
    await expect(dialog.getByRole("textbox", { name: "Issue details", exact: true })).toHaveValue("Source links and the handover checklist must remain available.");
    await dialog.getByRole("button", { name: "Create preparation issue", exact: true }).click(); await expect(dialog.getByRole("button", { name: "Check the previous request", exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: "Check the previous request", exact: true }).click(); await expect(dialog).toBeHidden(); expect(preparationWrites).toBe(1);
    const prepared = await api.getIssue(preparationIssueId); expect(prepared).toMatchObject({ status: "backlog", assignee_type: null, assignee_id: null, project_id: null, module_id: null });
    expect((await api.getOwnedMeetingLifecycle(meeting.id)).materials).toBeNull();
    const issueLink = page.getByRole("region", { name: "Preparation & materials", exact: true }).getByRole("link", { name: /Collect boundary source evidence/ });
    const popupPromise = page.waitForEvent("popup"); await issueLink.click(); const popup = await popupPromise;
    const agendaLink = popup.getByRole("link", { name: "Open agenda & preparation", exact: true }); await expect(agendaLink).toBeVisible();
    await expect(agendaLink).toHaveAttribute("href", new RegExp(`meeting=${meeting.id}.*agenda=${agendaIds[0]}`)); expect(await popup.getByRole("button", { name: /Remove direct meeting link|Unlink.*Boundary and preparation/ }).count()).toBe(0); await popup.close();

    await page.getByRole("link", { name: "Open links & materials", exact: true }).click();
    await page.getByRole("button", { name: "Fixed artifact versions", exact: true }).click();
    await page.getByRole("button", { name: "Add a fixed artifact", exact: true }).click();
    await page.getByRole("button", { name: artifact.title, exact: true }).click();
    await page.getByRole("button", { name: "Reference a version from a meeting", exact: true }).click();
    await expect(dialog.getByText(meeting.title, { exact: true })).toBeVisible(); await expect(dialog.getByRole("button", { name: "Choose source meeting", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Choose fixed version", exact: true }).click(); await dialog.getByRole("button", { name: "Version 1", exact: true }).click();
    await dialog.getByRole("checkbox", { name: "I confirm the selected fixed version and destination.", exact: true }).check();
    const referenced = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/cockpit/artifacts/${artifact.id}/meeting-references`);
    await dialog.getByRole("button", { name: "Create reference", exact: true }).click(); const referenceResponse = await referenced; expect(referenceResponse.status()).toBeGreaterThanOrEqual(200); expect(referenceResponse.status()).toBeLessThan(300);
    const reference = (await referenceResponse.json()).reference; expect(reference).toMatchObject({ meeting_id: meeting.id, version_id: fixedVersion.id }); await expect(dialog).toBeHidden();
    await page.getByRole("tab", { name: "Agenda & preparation", exact: true }).click(); await expect(notes).toHaveValue(mine);
    await page.getByRole("button", { name: "Link a fixed meeting artifact", exact: true }).click();
    await expect(dialog.getByRole("radio", { name: "Preparation", exact: true })).toHaveCount(0); await expect(dialog.getByRole("radio", { name: "Material", exact: true })).toBeChecked();
    await dialog.getByRole("button", { name: `${artifact.title} · Version 1 Pending review`, exact: true }).click();
    const attached = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/cockpit/meetings/${meeting.id}/agenda/${agendaIds[0]}/references`);
    await dialog.getByRole("button", { name: "Link to agenda", exact: true }).click(); const attachedResponse = await attached; expect(attachedResponse.status()).toBeGreaterThanOrEqual(200); expect(attachedResponse.status()).toBeLessThan(300);
    expect(attachedResponse.request().postDataJSON()).toMatchObject({ kind: "artifact_reference", target_id: reference.id, purpose: "material" }); await expect(dialog).toBeHidden();
    await expect(page.getByRole("region", { name: "Preparation & materials", exact: true }).getByRole("link", { name: new RegExp(artifact.title) })).toHaveAttribute("href", new RegExp(`version=${fixedVersion.id}`));
    const fixedRow = page.getByRole("region", { name: "Preparation & materials", exact: true }).getByRole("listitem").filter({ has: page.getByRole("link", { name: new RegExp(artifact.title) }) });
    await expect(fixedRow.getByText("Pending review", { exact: true })).toBeVisible(); expect((await api.getCockpitArtifactVersion(artifact.id, fixedVersion.id)).version.decision).toBe("pending");

    await page.getByRole("button", { name: "Confirm meeting ended", exact: true }).click(); await expect(dialog.getByLabel("Actual start (optional)", { exact: true })).toHaveValue(""); await expect(dialog.getByLabel("Actual end (optional)", { exact: true })).toHaveValue("");
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click(); await expect(dialog).toBeHidden();
    await expect.poll(async () => (await api.getOwnedMeetingLifecycle(meeting.id)).occurrence.state).toBe("ended"); header = await api.getOwnedMeetingLifecycle(meeting.id);
    expect(header.occurrence.actual_started_at).toBeNull(); expect(header.occurrence.actual_ended_at).toBeNull(); expect((await api.getMeetingWorkflow(meeting.id)).enabled).toBe(false);
    await page.getByText("Actual times & confirmation history", { exact: true }).click(); await page.getByRole("button", { name: "Correct actual times", exact: true }).click();
    await dialog.getByLabel("Actual start (optional)", { exact: true }).fill("2020-01-01T09:00"); await dialog.getByLabel("Actual end (optional)", { exact: true }).fill("2020-01-01T10:00"); await dialog.getByRole("textbox", { name: "Reason", exact: true }).fill("Confirmed with the participants' original calendar.");
    await dialog.getByRole("button", { name: "Confirm", exact: true }).click(); await expect(dialog).toBeHidden();
    await expect.poll(async () => (await api.getOwnedMeetingLifecycle(meeting.id)).occurrence.actual_started_at).toBe("2020-01-01T01:00:00Z");
    await page.getByRole("button", { name: "Confirmation history", exact: true }).click();
    const correctedRecord = page.getByRole("listitem").filter({ has: page.getByRole("button", { name: "Correct actual times", exact: true }) });
    await correctedRecord.getByRole("button", { name: "Correct actual times", exact: true }).click();
    await expect(dialog.getByText("Confirmed with the participants' original calendar.", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("textbox")).toHaveCount(0); await expect(dialog.getByRole("button", { name: "Confirm", exact: true })).toHaveCount(0); await page.keyboard.press("Escape");
    expect(await api.getWorkspaceAgentRunCount()).toBe(0); await page.setViewportSize({ width: 390, height: 844 }); await notes.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath("meeting-agenda-notes-390.png"), animations: "disabled" });
    await page.getByRole("region", { name: "Meeting occurrence", exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("meeting-agenda-occurrence-390.png"), animations: "disabled" });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.evaluate(() => { localStorage.setItem("e2e-meeting-locale", "zh-Hans"); document.cookie = "multica-locale=zh-Hans; path=/"; });
    await page.reload({ waitUntil: "domcontentloaded" }); await expect(page.locator("html")).toHaveClass(/dark/);
    const chineseNotes = page.getByRole("textbox", { name: "讨论记录", exact: true }); await expect(chineseNotes).toHaveValue(mine);
    await page.getByRole("region", { name: "会议发生事实", exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath("meeting-agenda-top-390-zh-dark.png"), animations: "disabled" });
    await chineseNotes.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath("meeting-agenda-notes-390-zh-dark.png"), animations: "disabled" });
  } finally { if (owned) await api.cleanupCreatedWorkspace(); }
});
