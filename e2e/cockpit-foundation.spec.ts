import { expect, test } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({
  viewport: { width: 1440, height: 1000 },
  locale: "en-US",
  timezoneId: "Asia/Shanghai",
  screenshot: "only-on-failure",
  trace: "retain-on-failure",
});

test("keeps cockpit bindings, meeting purposes and issue destinations connected", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const api = new TestApiClient();
  const run = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const auth = await api.login(`e2e-cockpit-${run}@multica.ai`, "Cockpit E2E Owner");
  let ownsWorkspace = false;

  try {
    const workspace = await api.createWorkspace(`Cockpit E2E ${run}`, `e2e-cockpit-${run}`);
    ownsWorkspace = true;
    await api.markUserOnboarded();
    const project = await api.createProject("Cockpit foundation project");
    const module = await api.createModule(project.id, "Verification module");
    const today = new Date().toISOString().slice(0, 10);
    const dates = { start_date: today, end_date: today };
    const projectRow = await api.createCockpitNode({ code: "L1-01", name: "Project plan", ...dates });
    const moduleRow = await api.createCockpitNode({
      code: "01.01", name: "Module plan", parent_id: projectRow.id, ...dates,
    });
    const executionRow = await api.createCockpitNode({
      code: "L3-01-01", name: "Deliver verification outcome", parent_id: moduleRow.id, ...dates,
    });
    const meeting = await api.createCockpitMeeting({ title: "Foundation review", meet_date: today });
    // Neither fixture creation nor the UI portion is allowed to dispatch work.
    const issue = await api.createIssue("Prepare foundation evidence", {
      project_id: project.id,
      module_id: module.id,
      status: "backlog",
      assignee_type: "member",
      assignee_id: auth.user.id,
    });
    await api.linkCockpitNodeIssue(executionRow.id, issue.id);
    await api.linkCockpitMeetingIssue(meeting.id, issue.id);

    const token = api.getToken();
    if (!token) throw new Error("Cockpit E2E login returned no token");
    await page.addInitScript((value) => {
      localStorage.setItem("multica_token", value);
      localStorage.setItem("multica:chat:isOpen", "false");
      document.cookie = "multica-locale=en; path=/";
    }, token);

    const cockpit = `/${workspace.slug}/cockpit`;
    const issuePath = `/${workspace.slug}/issues/${encodeURIComponent(issue.identifier)}`;
    const binding = page.getByRole("region", { name: "Project and module binding" });

    await test.step("bind structural rows to the real project and module through the UI", async () => {
      await page.goto(`${cockpit}?node=${projectRow.id}`, { waitUntil: "domcontentloaded" });
      await binding.getByRole("button", { name: "Configure binding", exact: true }).click();
      await binding.getByLabel("Project", { exact: true }).click();
      await page.getByRole("option", { name: project.title, exact: true }).click();
      await binding.getByRole("button", { name: "Save binding", exact: true }).click();
      await expect(binding.getByText("Mapped project row", { exact: true })).toBeVisible();

      await page.goto(`${cockpit}?node=${moduleRow.id}`, { waitUntil: "domcontentloaded" });
      await binding.getByRole("button", { name: "Configure binding", exact: true }).click();
      await expect(binding.getByLabel("Project", { exact: true })).toContainText(project.title);
      await binding.getByLabel("Module", { exact: true }).click();
      await page.getByRole("option", { name: module.title, exact: true }).click();
      await binding.getByRole("button", { name: "Save binding", exact: true }).click();
      await expect(binding.getByText("Mapped module row", { exact: true })).toBeVisible();
      const board = await api.getCockpitBoard();
      expect(board.nodes.find((node) => node.id === projectRow.id)?.project_id).toBe(project.id);
      expect(board.nodes.find((node) => node.id === moduleRow.id)).toMatchObject({
        project_id: project.id, module_id: module.id,
      });
    });

    await test.step("inherit the UUID binding when creating a backlog issue from L3", async () => {
      await page.goto(`${cockpit}?node=${executionRow.id}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("tab", { name: "Plan details", exact: true }).click();
      await expect(binding).toContainText(`${project.title} / ${module.title}`);
      await expect(page.locator(`[data-cockpit-node="${executionRow.id}"]`).first()).toBeVisible();
      await page.getByRole("tab", { name: "Tasks", exact: true }).click();
      await page.getByRole("button", { name: "Create issue", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Create issue", exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Issue title", { exact: true }).fill("Follow up on foundation evidence");
      await page.screenshot({ path: testInfo.outputPath("issue-prefilled-binding.png") });
      const created = page.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/cockpit/nodes/${executionRow.id}/tasks`);
      await dialog.getByRole("button", { name: "Create issue", exact: true }).click();
      const result = await created;
      expect(result.ok()).toBe(true);
      expect(await result.json()).toMatchObject({ project_id: project.id, module_id: module.id,
        primary_node_id: executionRow.id, status: "backlog", assignee_type: "member", assignee_id: auth.user.id });
      await expect(dialog).toBeHidden();
      expect(await api.getWorkspaceAgentRunCount()).toBe(0);
    });

    await test.step("save multiple meeting purposes and read them back after a reload", async () => {
      await page.goto(`${cockpit}?meeting=${meeting.id}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("tab", { name: "Links & materials", exact: true }).click();
      await page.getByRole("button", { name: `Edit purposes for ${issue.identifier}` }).click();
      await page.getByRole("checkbox", { name: "Preparation", exact: true }).check();
      await page.getByRole("checkbox", { name: "Review", exact: true }).check();
      await page.getByRole("button", { name: "Save purposes", exact: true }).click();
      await expect(page.getByRole("button", { name: "Save purposes", exact: true })).toBeHidden();
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("tab", { name: "Links & materials", exact: true }).click();

      const meetingPanel = page.getByRole("complementary").filter({
        has: page.getByRole("button", { name: `Edit purposes for ${issue.identifier}` }),
      });
      await expect(meetingPanel.getByText("Preparation", { exact: true })).toBeVisible();
      await expect(meetingPanel.getByText("Review", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("meeting-purposes-persisted.png") });
      const board = await api.getCockpitBoard();
      expect(board.meeting_issues.find((link) => link.meeting_id === meeting.id && link.issue_id === issue.id)?.roles)
        .toEqual(["preparation", "review"]);
      const issueLink = meetingPanel.getByRole("link", { name: new RegExp(issue.identifier) });
      await expect(issueLink).toHaveAttribute("href", issuePath);
      await issueLink.click();
      await expect(page).toHaveURL(issuePath);
      await expect(page.getByText(issue.title, { exact: true }).first()).toBeVisible();
    });

    await test.step("navigate from the single issue context to its exact meeting and L3", async () => {
      const meetingLink = page.getByRole("link", { name: new RegExp(meeting.title) });
      await expect(meetingLink).toHaveCount(1);
      await expect(meetingLink).toHaveAttribute("href", `${cockpit}?meeting=${meeting.id}`);
      await meetingLink.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("issue-cockpit-context.png") });
      await meetingLink.click();
      await expect(page).toHaveURL(`${cockpit}?meeting=${meeting.id}`);
      await page.getByRole("tab", { name: "Links & materials", exact: true }).click();
      await expect(page.getByRole("button", { name: `Edit purposes for ${issue.identifier}` })).toBeVisible();

      await page.goBack({ waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(issuePath);
      const executionLink = page.getByRole("link", { name: new RegExp(executionRow.name) });
      await expect(executionLink).toHaveAttribute("href", `${cockpit}?node=${executionRow.id}`);
      await executionLink.click();
      await expect(page).toHaveURL(`${cockpit}?node=${executionRow.id}`);
      await expect(page.locator(`[data-cockpit-node="${executionRow.id}"]`).first()).toBeVisible();
      await page.getByRole("tab", { name: "Plan details", exact: true }).click();
      await expect(binding).toContainText(`${project.title} / ${module.title}`);
      await page.screenshot({ path: testInfo.outputPath("execution-deep-link.png") });
    });
  } finally {
    if (ownsWorkspace) await api.cleanupCreatedWorkspace();
  }
});
