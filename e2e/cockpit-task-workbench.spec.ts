import { expect, test, type Page, type Response } from "@playwright/test";
import { TestApiClient, type TestCockpitTaskPage } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1050 }, locale: "en-US", timezoneId: "Asia/Shanghai",
  contextOptions: { reducedMotion: "reduce" }, screenshot: "only-on-failure", trace: "retain-on-failure" });

function taskResponse(page: Page, nodeId: string, matches: (query: URLSearchParams) => boolean = () => true) {
  return page.waitForResponse((response: Response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/cockpit/nodes/${nodeId}/tasks` && response.request().method() === "GET" && matches(url.searchParams);
  });
}

test("pages and searches 125 L3 issues while keeping primary and reference counts distinct", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  const api = new TestApiClient();
  const run = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const auth = await api.login(`e2e-l3-scale-${run}@multica.ai`, "L3 Scale Owner");
  let ownsWorkspace = false;
  try {
    const workspace = await api.createWorkspace(`L3 Scale ${run}`, `e2e-l3-${run}`);
    ownsWorkspace = true;
    await api.markUserOnboarded();
    const project = await api.createProject("Large execution project");
    const module = await api.createModule(project.id, "Acceptance evidence");
    const day = new Date().toISOString().slice(0, 10);
    const dates = { start_date: day, end_date: day };
    const l1 = await api.createCockpitNode({ code: "L1-SCALE", name: "Delivery programme", project_id: project.id, ...dates });
    const l2 = await api.createCockpitNode({ code: "L2-SCALE", name: "Evidence stream", parent_id: l1.id, project_id: project.id, module_id: module.id, ...dates });
    const l3 = await api.createCockpitNode({ code: "L3-SCALE", name: "Validate the complete delivery scope", parent_id: l2.id, ...dates });
    const other = await api.createCockpitNode({ code: "L3-NEXT", name: "Continue accepted work", parent_id: l2.id, ...dates });
    const seeded = await api.seedTableIssues(Array.from({ length: 125 }, (_, index) => ({
      title: index === 124
        ? "Scale issue 124 — A long evidence title with owners, acceptance boundaries, dependencies and follow-up questions for review across project teams"
        : `Scale issue ${String(index).padStart(3, "0")}`,
      status: index < 20 ? "done" : index < 25 ? "cancelled" : index === 124 ? "future_execution_state" : "backlog",
      projectId: project.id, moduleId: module.id, assigneeId: auth.user.id,
    })));
    for (const issue of seeded) await api.setCockpitPrimaryNode(issue.id, l3.id);
    expect((await api.getCockpitBoard()).issue_links).toHaveLength(0);
    const initial = await api.getCockpitTasks(l3.id);
    expect(initial).toMatchObject({ total: 125, filtered_total: 125, summary: { total: 125, done: 20, closed: 5, unknown: 1 }, eligibility: { eligible: true, project_id: project.id, module_id: module.id } });
    expect((await api.getCockpitTasks(l3.id, { category: "active", q: seeded[124]!.title })).items[0])
      .toMatchObject({ id: seeded[124]!.id, status: "future_execution_state", status_category: "unknown" });
    expect(initial.items).toHaveLength(25);
    const token = api.getToken();
    if (!token) throw new Error("L3 fixture login returned no token");
    await page.addInitScript((value) => {
      localStorage.setItem("multica_token", value);
      localStorage.setItem("multica:chat:isOpen", "false");
      document.cookie = "multica-locale=en; path=/";
    }, token);
    const region = page.getByRole("region", { name: "L3 issues", exact: true });
    const initialRead = taskResponse(page, l3.id, (query) => !query.get("cursor"));
    await page.goto(`/${workspace.slug}/cockpit?node=${l3.id}`, { waitUntil: "domcontentloaded" });
    let current = await (await initialRead).json() as TestCockpitTaskPage;
    await expect(region).toBeVisible();
    await expect(page.getByRole("tab", { name: "Tasks", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(region.getByRole("button", { name: "All (125)", exact: true })).toBeVisible();
    await expect(region.getByRole("button", { name: "Open (100)", exact: true })).toBeVisible();
    expect(current.filtered_total).toBe(100);
    await expect(region.getByRole("button", { name: "Completed (20)", exact: true })).toBeVisible();
    await expect(region.getByRole("button", { name: "Closed (5)", exact: true })).toBeVisible();
    await expect(region.getByRole("button", { name: "Unknown (1)", exact: true })).toBeVisible();
    const allRead = taskResponse(page, l3.id, (query) => !query.get("category") && !query.get("cursor"));
    await region.getByRole("button", { name: "All (125)", exact: true }).click();
    current = await (await allRead).json() as TestCockpitTaskPage;
    await page.screenshot({ path: testInfo.outputPath("l3-full-scope-summary.png"), animations: "disabled" });

    await test.step("read all five bounded pages without repeated or missing identities", async () => {
      const seen = new Set<string>();
      let pages = 0;
      for (;;) {
        expect(current.items.length).toBeLessThanOrEqual(25);
        expect(current.total).toBe(125);
        for (const issue of current.items) {
          expect(seen.has(issue.id)).toBe(false);
          seen.add(issue.id);
        }
        pages += 1;
        await expect(region.getByRole("link", { name: new RegExp(`${current.items[0]!.title}$`) })).toBeVisible();
        if (!current.next_cursor) break;
        const cursor = current.next_cursor;
        const nextRead = taskResponse(page, l3.id, (query) => query.get("cursor") === cursor);
        await region.getByRole("button", { name: "Next page", exact: true }).click();
        current = await (await nextRead).json() as TestCockpitTaskPage;
      }
      expect(pages).toBe(5);
      expect([...seen].sort()).toEqual(seeded.map((issue) => issue.id).sort());
      await expect(region.getByRole("button", { name: "Next page", exact: true })).toBeDisabled();
    });

    await test.step("search and filter on the server and reset the page cursor", async () => {
      const title = current.items[0]!.title;
      const searched = taskResponse(page, l3.id, (query) => query.get("q") === title && !query.get("cursor"));
      await region.getByRole("textbox", { name: "Search L3 issues", exact: true }).fill(title);
      const result = await (await searched).json() as TestCockpitTaskPage;
      expect(result).toMatchObject({ total: 125, filtered_total: 1, next_cursor: null, summary: { done: 20, closed: 5 } });
      expect(result.items.map((issue) => issue.title)).toEqual([title]);
      await expect(region.getByRole("link", { name: new RegExp(`${title}$`) })).toBeVisible();
      await region.getByRole("textbox", { name: "Search L3 issues", exact: true }).fill("");
      // Returning to an already-read filter may use the legitimate Query cache.
      await expect(region.getByRole("link", { name: new RegExp(`${initial.items[0]!.title}$`) })).toBeVisible();
      const filtered = taskResponse(page, l3.id, (query) => query.get("category") === "done" && !query.get("cursor") && !query.get("q"));
      await region.getByRole("button", { name: "Completed (20)", exact: true }).click();
      const completed = await (await filtered).json() as TestCockpitTaskPage;
      expect(completed).toMatchObject({ total: 125, filtered_total: 20, next_cursor: null });
      expect(completed.items.every((issue) => issue.status === "done")).toBe(true);
    });

    await test.step("move primary ownership and retain the previous link as reference", async () => {
      const moved = seeded[124]!;
      const ownership = await api.setCockpitPrimaryNode(moved.id, other.id, 1);
      expect(ownership.node_id).toBe(other.id);
      expect((await api.getCockpitTasks(l3.id)).total).toBe(124);
      expect((await api.getCockpitTasks(other.id)).total).toBe(1);
      const references = await api.getCockpitTasks(l3.id, { relation: "reference" });
      expect(references.total).toBe(1);
      expect(references.items[0]).toMatchObject({ id: moved.id, primary_node_id: other.id });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(region.getByRole("button", { name: "All (124)", exact: true })).toBeVisible();
      await region.getByRole("button", { name: "All (124)", exact: true }).click();
      await region.getByLabel("Issue relationship", { exact: true }).click();
      await page.getByRole("option", { name: "Reference issues", exact: true }).click();
      await expect(region.getByRole("link", { name: new RegExp(`${moved.title}$`) })).toBeVisible();
      await expect(region.getByRole("button", { name: "All (1)", exact: true })).toBeVisible();
      await page.setViewportSize({ width: 1100, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("l3-reference-narrow.png"), animations: "disabled" });
    });
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } finally {
    if (ownsWorkspace) await api.cleanupCreatedWorkspace();
  }
});
