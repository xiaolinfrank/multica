import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1100 }, locale: "en-US", timezoneId: "Asia/Shanghai", trace: "retain-on-failure" });

type BoardNode = { id: string; code: string; name: string; module_id?: string | null; directory_name?: string | null };

test("creates a work item and issue, renames its folder, and keeps hidden entries out of issue detail", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bayclaw-e2e-unification-"));
  const projectDir = path.join(root, "programme");
  fs.mkdirSync(projectDir, { recursive: true });
  const api = new TestApiClient();
  const run = `${Date.now().toString(36)}-${process.pid}`;
  await api.login(`e2e-unification-${run}@multica.ai`, "Unification fixture owner");
  let ownsWorkspace = false;
  try {
    const workspace = await api.createWorkspace(`Unified programme ${run}`, `e2e-unification-${run}`);
    ownsWorkspace = true;
    await api.markUserOnboarded();
    await api.updateCockpitBoard({ title: "Unified delivery cockpit" });
    await api.applyCockpitPlanReconcile();
    const project = await api.createProject("Unified programme", { collab_path: projectDir });
    const module = await api.createModule(project.id, "Unified module");

    const before = (await api.getCockpitBoard()) as unknown as { nodes: BoardNode[] };
    const moduleRow = before.nodes.find((node) => node.module_id === module.id);
    expect(moduleRow?.directory_name, "module row must carry its delivery folder").toBeTruthy();
    const moduleDirectory = moduleRow!.directory_name!;

    const token = api.getToken();
    if (!token) throw new Error("Fixture token missing");
    await page.addInitScript((value) => {
      localStorage.setItem("multica_token", value);
      localStorage.setItem("multica:chat:isOpen", "false");
      document.cookie = "multica-locale=en; path=/";
    }, token);

    const cockpit = `/${workspace.slug}/cockpit`;
    await page.goto(`${cockpit}?tab=plan`, { waitUntil: "domcontentloaded" });
    const navigation = page.getByRole("navigation", { name: "Cockpit sections", exact: true });
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole("link")).toHaveCount(4);
    await expect(navigation.getByRole("link", { name: "Artifacts", exact: true })).toHaveCount(0);
    await expect(navigation.getByRole("link", { name: "Governance", exact: true })).toHaveCount(0);
    const more = navigation.getByRole("button", { name: /^More/ });
    await expect(more).toBeVisible();
    await more.click();
    await expect(page.getByRole("menuitem", { name: /Governance/ })).toBeVisible();
    await page.keyboard.press("Escape");

    const moduleRowLocator = page.locator(`[data-cockpit-node="${moduleRow!.id}"]`).first();
    await expect(moduleRowLocator).toBeVisible();
    await moduleRowLocator.hover();
    await moduleRowLocator.getByRole("button", { name: "Add a row below", exact: true }).click();
    const newWorkItemName = "Unified traceable work item";
    const createdWorkItem = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/cockpit/work-items");
    await page.getByPlaceholder("Work item name", { exact: true }).fill(newWorkItemName);
    await page.getByPlaceholder("Work item name", { exact: true }).press("Enter");
    const workItemResponse = await createdWorkItem;
    expect(workItemResponse.ok()).toBe(true);
    const workItem = (await workItemResponse.json()) as { id: string; code: string; directory_name?: string | null };
    expect(workItem.directory_name).toBeTruthy();
    const workItemFolder = path.join(projectDir, moduleDirectory, workItem.directory_name!);
    await expect.poll(() => fs.existsSync(workItemFolder)).toBe(true);
    const ganttWorkItemRow = page.locator(`[data-cockpit-node="${workItem.id}"]`).first();
    await expect(ganttWorkItemRow).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("work-item-created.png") });

    await ganttWorkItemRow.hover();
    await ganttWorkItemRow.getByRole("button", { name: "New issue", exact: true }).click();
    const issueDialog = page.getByRole("dialog", { name: "New Issue", exact: true });
    await expect(issueDialog).toBeVisible();
    const issueTitle = "Trace the unified work item end to end";
    await issueDialog.getByRole("textbox", { name: "Issue title", exact: true }).fill(issueTitle);
    const createdIssue = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/issues");
    await issueDialog.getByRole("button", { name: "Create Issue", exact: true }).click();
    const issueResponse = await createdIssue;
    expect(issueResponse.status()).toBe(201);
    const issue = (await issueResponse.json()) as { id: string; work_item_id?: string | null };
    expect(issue.work_item_id).toBe(workItem.id);
    await expect(issueDialog).toBeHidden();

    await page.goto(`/${workspace.slug}/projects/${project.id}`, { waitUntil: "domcontentloaded" });
    const detailRow = page.locator(`[data-node-id="${workItem.id}"]`).first();
    await expect(detailRow).toBeVisible();
    await detailRow.getByRole("button", { name: newWorkItemName, exact: true }).click();
    await expect(page.getByText(issueTitle, { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("project-detail-work-item.png") });

    const renamed = "Unified traceable work item renamed";
    await detailRow.getByRole("button", { name: newWorkItemName, exact: true }).dblclick();
    const renameField = detailRow.getByRole("textbox");
    await expect(renameField).toBeVisible();
    const renameResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname === `/api/cockpit/nodes/${workItem.id}`);
    await renameField.fill(renamed);
    await renameField.press("Enter");
    const renamedResponse = await renameResponse;
    expect(renamedResponse.ok()).toBe(true);
    const renamedBody = (await renamedResponse.json()) as { name: string; directory_name?: string | null };
    expect(renamedBody.name).toBe(renamed);
    await expect(detailRow.getByRole("button", { name: renamed, exact: true })).toBeVisible();
    expect(renamedBody.directory_name).toBeTruthy();
    const renamedFolder = path.join(projectDir, moduleDirectory, renamedBody.directory_name!);
    await expect.poll(() => fs.existsSync(renamedFolder)).toBe(true);
    expect(fs.existsSync(workItemFolder)).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("work-item-renamed.png") });

    await page.goto(`/${workspace.slug}/issues/${issue.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Ownership", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Delivery folder", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Related work items", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(renamed, { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Artifacts & acceptance", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Issue inputs", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("issue-detail-hidden-entries.png") });

    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } finally {
    if (ownsWorkspace) await api.cleanupCreatedWorkspace();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
