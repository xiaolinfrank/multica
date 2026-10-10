import { expect, test, type Page } from "@playwright/test";
import { TestApiClient } from "./fixtures";
import { switchToIssueView } from "./helpers";

test.use({ viewport: { width: 1600, height: 1050 }, locale: "en-US", timezoneId: "Asia/Shanghai", contextOptions: { reducedMotion: "reduce" }, trace: "retain-on-failure" });

async function authenticate(page: Page, api: TestApiClient) {
  const token = api.getToken(); if (!token) throw new Error("Fixture token missing");
  await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = "multica-locale=en; path=/"; }, token);
}

test("repairs primary scope and keeps formal review actions in their workbench, with a focused narrow L3 return", async ({ page }, testInfo) => {
  test.setTimeout(150_000); page.setDefaultTimeout(15_000);
  const api = new TestApiClient(), run = `${Date.now().toString(36)}-${process.pid}`;
  const auth = await api.login(`e2e-operation-${run}@multica.ai`, "Operation review owner"); let owned = false;
  try {
    const workspace = await api.createWorkspace(`Operation recovery ${run}`, `e2e-operation-${run}`); owned = true; await api.markUserOnboarded();
    const project = await api.createProject("Original delivery"), module = await api.createModule(project.id, "Original module");
    const otherProject = await api.createProject("Next delivery"), otherModule = await api.createModule(otherProject.id, "Next module");
    const root = await api.createCockpitNode({ code: "01", name: "Delivery programme", project_id: project.id });
    const group = await api.createCockpitNode({ code: "01.01", name: "Evidence module", module_id: module.id, parent_id: root.id });
    const leaf = await api.createCockpitNode({ code: "01.01.01", name: "Verify acceptance boundary", parent_id: group.id });
    const ordinary = await api.createIssue("Move ordinary preparation work", { project_id: project.id, module_id: module.id, status: "backlog", assignee_type: "member", assignee_id: auth.user.id });
    await api.setCockpitPrimaryNode(ordinary.id, leaf.id);
    const source = await api.createIssue("Produce formal evidence", { project_id: project.id, module_id: module.id, status: "backlog", assignee_type: "member", assignee_id: auth.user.id });
    const artifact = await api.createOwnedPendingTextArtifact(leaf.id, source.id, auth.user.id);
    const version = artifact.current_version; if (!version?.review_issue || version.decision !== "pending") throw new Error("Owned formal review fixture was not created");
    await authenticate(page, api);
    await page.goto(`/${workspace.slug}/issues/${ordinary.id}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: project.title, exact: true }).click();
    await expect(page.getByText("Manage the primary work-item relationship before changing this scope.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear primary work item", exact: true }).last().click();
    const clearing = page.getByRole("alertdialog", { name: "Clear primary work item", exact: true });
    const cleared = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/cockpit/issues/${ordinary.id}/primary-node` && response.request().method() === "PUT");
    await clearing.getByRole("button", { name: "Confirm clearing", exact: true }).click();
    expect((await cleared).status()).toBe(200); await expect(clearing).not.toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: project.title, exact: true }).click();
    await page.getByRole("button", { name: otherProject.title, exact: true }).click();
    await expect.poll(async () => (await api.getIssue(ordinary.id)).project_id).toBe(otherProject.id);
    await page.getByRole("button", { name: "No module", exact: true }).click();
    await page.getByRole("button", { name: otherModule.title, exact: true }).click();
    await expect.poll(async () => (await api.getIssue(ordinary.id)).module_id).toBe(otherModule.id);
    expect((await api.getIssue(ordinary.id)).status).toBe("backlog");

    await page.goto(`/${workspace.slug}/issues/${version.review_issue.id}`, { waitUntil: "domcontentloaded" });
    const work = await api.getIssue(version.review_issue.id);
    const statusLabels: Record<string, string> = { backlog: "Backlog", todo: "Todo", in_progress: "In Progress" };
    if (!statusLabels[work.status]) throw new Error(`Unexpected formal review working status: ${work.status}`);
    await page.getByRole("button", { name: statusLabels[work.status], exact: true }).click();
    await expect(page.getByRole("button", { name: "Done", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Cancelled", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Mark as duplicate", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Issue actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Status", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Done", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Issue actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Relations", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Mark as duplicate", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Issue actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Assignee", exact: true }).click();
    await expect(page.getByText("Transfer formal review responsibility from its workbench.", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("Assign to...")).toHaveCount(0);
    await page.keyboard.press("Escape");
    const formalEntry = page.getByRole("link", { name: /^Open formal review/ }).first();
    await expect(formalEntry).toHaveAttribute("href", new RegExp(`artifact_version=${version.id}`));
    const opened = page.waitForEvent("popup"); await formalEntry.click(); const formalPage = await opened;
    await expect(formalPage.getByRole("region", { name: "Fixed version content", exact: true })).toBeVisible(); await formalPage.close();
    expect((await api.getCockpitArtifact(artifact.id)).current_version?.decision).toBe("pending");
    expect((await api.getIssue(version.review_issue.id)).status).toBe(work.status);

    await page.goto(`/${workspace.slug}/cockpit?tab=plan&project=${project.id}&module=${module.id}`, { waitUntil: "domcontentloaded" });
    const search = page.getByRole("textbox", { name: "Search the board", exact: true }); await search.fill(leaf.name);
    const showControls = page.getByRole("button", { name: "Show timeline controls", exact: true });
    if (await showControls.isVisible()) await showControls.click();
    await page.getByRole("combobox", { name: "Timeline density", exact: true }).click(); await page.getByRole("option", { name: "Week", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open 01.01.01", exact: true }).click();
    await expect(page.getByRole("region", { name: "L3 issues", exact: true })).toBeVisible(); await expect(search).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Close panel", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("operation-l3-narrow-focus.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Close panel", exact: true }).click();
    await expect(search).toBeVisible(); await expect(search).toHaveValue(leaf.name);
    await expect(page.getByRole("combobox", { name: "Timeline density", exact: true })).toHaveText("Week");
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } finally { if (owned) await api.cleanupCreatedWorkspace(); }
});

test("reports a real per-item revision conflict without clearing the remaining selection", async ({ page }, testInfo) => {
  test.setTimeout(100_000); page.setDefaultTimeout(15_000);
  const api = new TestApiClient(), run = `${Date.now().toString(36)}-${process.pid}`;
  const auth = await api.login(`e2e-batch-${run}@multica.ai`, "Batch recovery owner"); let owned = false;
  try {
    const workspace = await api.createWorkspace(`Batch recovery ${run}`, `e2e-batch-${run}`); owned = true; await api.markUserOnboarded();
    const issues = [];
    for (let i = 0; i < 3; i++) issues.push(await api.createIssue(`Batch delivery ${i + 1}`, { status: "todo", assignee_type: "member", assignee_id: auth.user.id }));
    const ownedIds = new Set(issues.map((issue) => issue.id));
    await authenticate(page, api); await page.goto(`/${workspace.slug}/issues`, { waitUntil: "domcontentloaded" }); await switchToIssueView(page, "Table");
    for (const issue of issues) await expect(page.getByRole("checkbox", { name: `Select ${issue.identifier}`, exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Select all visible issues", exact: true }).check();
    const toolbar = page.getByRole("region", { name: "Selected issue actions", exact: true }); await expect(toolbar).toContainText("3 selected");
    let submittedIds: string[] = [];
    await page.route("**/api/issues/batch-update", async (route) => {
      const body = route.request().postDataJSON();
      if (route.request().method() !== "POST" || body.updates?.status !== "done" || submittedIds.length) { await route.continue(); return; }
      expect(Array.isArray(body.issue_ids)).toBe(true); expect(body.issue_ids).toHaveLength(3);
      expect(body.issue_ids.every((id: string) => ownedIds.has(id))).toBe(true);
      submittedIds = [...body.issue_ids];
      expect(submittedIds.every((id) => Number.isInteger(body.expected_revisions?.[id]))).toBe(true);
      await api.updateIssue(submittedIds[1]!, { title: "Peer corrected the second delivery" });
      await route.continue();
    });
    const response = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/issues/batch-update" && result.request().method() === "POST");
    await toolbar.getByRole("button", { name: "Status", exact: true }).click(); await page.getByRole("button", { name: "Done", exact: true }).click();
    const written = await response; expect(written.status()).toBe(409);
    const receipt = await written.json(); expect(receipt.requested_ids).toEqual(submittedIds); expect(receipt.updated).toBe(1);
    expect(receipt.results.map((item: { outcome: string }) => item.outcome)).toEqual(["applied", "rejected", "not_attempted"]);
    const result = page.getByRole("region", { name: "Operation results", exact: true });
    await expect(result).toContainText("1 applied · 2 not applied · 0 unconfirmed");
    await expect(result).toContainText("The issue or comment changed.");
    await expect(page.getByRole("dialog", { name: "Operation results", exact: true })).toContainText("Status · Done");
    expect((await api.getIssue(submittedIds[0]!)).status).toBe("done"); expect((await api.getIssue(submittedIds[1]!)).status).toBe("todo"); expect((await api.getIssue(submittedIds[2]!)).status).toBe("todo");
    await page.screenshot({ path: testInfo.outputPath("issue-batch-real-conflict.png"), animations: "disabled" });
    await page.getByRole("dialog", { name: "Operation results", exact: true }).getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(toolbar).toContainText("2 selected");
    for (const id of submittedIds.slice(1)) { const issue = issues.find((item) => item.id === id)!; await expect(page.getByRole("checkbox", { name: `Select ${issue.identifier}`, exact: true })).toBeChecked(); }
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } finally { await page.unroute("**/api/issues/batch-update"); if (owned) await api.cleanupCreatedWorkspace(); }
});
