import { expect, test } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1000 }, locale: "en-US", timezoneId: "Asia/Shanghai" });

test("keeps preparation, recording and minutes confirmation as one timeline over linked tasks and facts", async ({ page }, info) => {
  test.setTimeout(120_000);
  const api = new TestApiClient();
  const run = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const auth = await api.login(`e2e-simple-meeting-${run}@multica.ai`, "Meeting Simplification Reviewer");
  let ownsWorkspace = false;
  try {
    const workspace = await api.createWorkspace(`Simple meetings ${run}`, `e2e-simple-meetings-${run}`); ownsWorkspace = true;
    await api.markUserOnboarded(); await api.updateCockpitBoard({ title: "Simple meeting workflow" });
    const project = await api.createProject("Meeting project"); const module = await api.createModule(project.id, "Meeting materials");
    // The meeting's default placement seeds the platform create dialog, so
    // the stage buttons stay one click.
    await api.updateCockpitBoard({ meeting_project_id: project.id, meeting_module_id: module.id });
    // This fixture records a directory identity; it never provisions or writes
    // a production/NAS folder. Directory creation is covered by its own suite.
    const meeting = await api.createCockpitMeeting({ title: "Simple meeting", meet_date: "2026-10-10", nas_dir: "/Volumes/e2e/meeting-materials" });
    const token = api.getToken(); if (!token) throw new Error("Missing fixture token");
    await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = "multica-locale=en; path=/"; }, token);
    const base = `/${workspace.slug}/cockpit?meeting=${meeting.id}`;
    await page.goto(`${base}&meeting_view=preparation`);

    // One timeline carries the three stages; the linked tasks and the fact
    // region sit below it in the same window.
    await expect(page.getByRole("tab", { name: "Preparation", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Meeting record", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Minutes confirmation", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Linked tasks", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Details", exact: true })).toBeVisible();
    await expect(page.getByText("/Volumes/e2e/meeting-materials", { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Action follow-up", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add agenda item", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Use a preparation template", exact: true })).toHaveCount(0);

    // Preparation is a single action that hands the create to the platform
    // create-issue dialog; the created task appears in the linked list.
    const preparation = page.getByRole("tabpanel", { name: "Preparation", exact: true });
    await preparation.getByRole("button", { name: "New material-preparation issue", exact: true }).click();
    const prepareDialog = page.getByRole("dialog", { name: "New Issue", exact: true });
    await prepareDialog.getByRole("textbox", { name: "Issue title", exact: true }).fill("Collect meeting evidence");
    const created = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/issues");
    await prepareDialog.getByRole("button", { name: "Create Issue", exact: true }).click();
    expect((await created).status()).toBe(201); await expect(prepareDialog).toBeHidden();
    const linked = page.getByRole("region", { name: "Linked tasks", exact: true });
    await expect(linked.getByText("Collect meeting evidence", { exact: false })).toBeVisible();
    expect((await api.getMeetingWorkflow(meeting.id)).enabled).toBe(false);

    // Recording is a single action too; the created issue becomes the
    // meeting's minutes task with the opener as reviewer.
    await page.getByRole("tab", { name: "Meeting record", exact: true }).click();
    const record = page.getByRole("tabpanel", { name: "Meeting record", exact: true });
    await expect(record.getByRole("button", { name: "Create minutes issue", exact: true })).toBeVisible();
    await expect(record.getByRole("button", { name: "New material-preparation issue", exact: true })).toHaveCount(0);
    await record.getByRole("button", { name: "Create minutes issue", exact: true }).click();
    const minutesDialog = page.getByRole("dialog", { name: "New Issue", exact: true });
    await minutesDialog.getByRole("textbox", { name: "Issue title", exact: true }).fill("Write the minutes");
    const minutesCreated = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/issues");
    await minutesDialog.getByRole("button", { name: "Create Issue", exact: true }).click();
    expect((await minutesCreated).status()).toBe(201); await expect(minutesDialog).toBeHidden();
    await expect.poll(async () => (await api.getMeetingWorkflow(meeting.id)).minutes_issue?.assignee_id).toBe(auth.user.id);
    await expect.poll(async () => (await api.getMeetingWorkflow(meeting.id)).enabled).toBe(true);

    // Minutes confirmation reads the task; no setup machinery returns here.
    await page.getByRole("tab", { name: "Minutes confirmation", exact: true }).click();
    const confirmation = page.getByRole("tabpanel", { name: "Minutes confirmation", exact: true });
    await expect(confirmation.getByRole("heading", { name: "Minutes task", exact: true })).toBeVisible();
    await expect(confirmation.getByRole("button", { name: "Start minutes issue", exact: true })).toHaveCount(0);
    await expect(confirmation.getByRole("button", { name: "Create minutes issue", exact: true })).toHaveCount(0);

    // The meeting directory opens from the header as a real local-path
    // action (Finder hand-off / copy), not a second in-app tab.
    await expect(page.getByRole("button", { name: "Open the meeting directory", exact: true })).toBeVisible();

    for (const width of [1100, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("tab", { name: "Minutes confirmation", exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.screenshot({ path: info.outputPath("simple-meeting-confirmation.png"), animations: "disabled" });
  } finally { if (ownsWorkspace) await api.cleanupCreatedWorkspace(); }
});
