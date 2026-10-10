import { expect, test } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1100 }, locale: "en-US", timezoneId: "Asia/Shanghai", trace: "retain-on-failure" });

test("carries project and module scope across the cockpit and bounds meeting pages", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  const api = new TestApiClient(); const run = `${Date.now().toString(36)}-${process.pid}`;
  await api.login(`e2e-scope-${run}@multica.ai`, "Scope fixture owner");
  let ownsWorkspace = false;
  try {
    const workspace = await api.createWorkspace(`Scoped programme ${run}`, `e2e-scope-${run}`); ownsWorkspace = true;
    await api.markUserOnboarded(); await api.updateCockpitBoard({ title: "Programme delivery cockpit" });
    const today = new Date().toISOString().slice(0, 10);
    const projectA = await api.createProject("Scope A programme"), projectB = await api.createProject("Scope B programme");
    const moduleA = await api.createModule(projectA.id, "Scope A module"), moduleB = await api.createModule(projectB.id, "Scope B module");
    const rootA = await api.createCockpitNode({ code: "PA", name: "Scope A plan", project_id: projectA.id });
    const rootB = await api.createCockpitNode({ code: "PB", name: "Scope B plan", project_id: projectB.id });
    const groupA = await api.createCockpitNode({ code: "MA", name: "Scope A module plan", parent_id: rootA.id, module_id: moduleA.id });
    const groupB = await api.createCockpitNode({ code: "MB", name: "Scope B module plan", parent_id: rootB.id, module_id: moduleB.id });
    const leafA = await api.createCockpitNode({ code: "LA", name: "Scope A execution", parent_id: groupA.id, start_date: today, end_date: today });
    const leafB = await api.createCockpitNode({ code: "LB", name: "Scope B execution", parent_id: groupB.id, start_date: today, end_date: today });
    for (let index = 1; index <= 31; index++) {
      const meeting = await api.createCockpitMeeting({ title: `Scope A review ${String(index).padStart(2, "0")}`, meet_date: today, note: `PRIVATE_BODY_${index}\n${"Meeting context. ".repeat(2048)}` });
      await api.appendCockpitMeetingNode(meeting.id, leafA.id);
    }
    const outside = await api.createCockpitMeeting({ title: "Scope B private review", meet_date: today });
    await api.appendCockpitMeetingNode(outside.id, leafB.id);
    const token = api.getToken(); if (!token) throw new Error("Fixture token missing");
    await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = "multica-locale=en; path=/"; }, token);
    const cockpit = `/${workspace.slug}/cockpit`;
    const reads: string[] = [];
    page.on("request", (request) => { if (request.method() === "GET") reads.push(new URL(request.url()).pathname); });
    await page.goto(`/${workspace.slug}`, { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/cockpit$`));
    const navigation = page.getByRole("navigation", { name: "Cockpit sections" });
    await expect(navigation).toBeVisible();
    await page.getByRole("button", { name: "Project scope", exact: true }).click();
    await page.getByRole("button", { name: projectA.title, exact: true }).click();
    await page.getByRole("button", { name: "Module scope", exact: true }).click();
    await page.getByRole("button", { name: moduleA.title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`project=${projectA.id}.*module=${moduleA.id}`));
    for (const name of ["Overview", "Execution plan", "Meetings", "Governance"]) {
      const href = await navigation.getByRole("link", { name, exact: true }).getAttribute("href");
      const query = new URL(href!, "http://fixture.invalid").searchParams;
      expect(query.get("project")).toBe(projectA.id); expect(query.get("module")).toBe(moduleA.id);
    }
    await navigation.getByRole("link", { name: "Execution plan", exact: true }).click();
    await page.getByRole("link", { name: "Plan table", exact: true }).click();
    await expect(page.getByText(leafA.name, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(leafB.name, { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("scoped-plan-table.png") });

    const firstPage = page.waitForResponse((response) => { const url = new URL(response.url()); return response.request().method() === "GET"
      && url.pathname === "/api/cockpit/meetings" && url.searchParams.get("project_id") === projectA.id && url.searchParams.get("module_id") === moduleA.id && url.searchParams.get("page_size") === "25" && !url.searchParams.get("cursor"); });
    await navigation.getByRole("link", { name: "Meetings", exact: true }).click();
    const meetings = page.getByRole("region", { name: "Meetings", exact: true });
    await meetings.getByRole("button", { name: "List", exact: true }).click();
    const firstResponse = await firstPage; expect(firstResponse.ok()).toBe(true);
    const first = await firstResponse.json(); expect(first.total).toBe(31); expect(first.items).toHaveLength(25);
    expect(first.items.every((item: Record<string, unknown>) => !Object.hasOwn(item, "note") && !Object.hasOwn(item, "minutes"))).toBe(true);
    await expect(meetings.getByText(outside.title, { exact: true })).toHaveCount(0);
    const secondPage = page.waitForResponse((response) => { const url = new URL(response.url()); return url.pathname === "/api/cockpit/meetings" && url.searchParams.get("cursor") === first.next_cursor; });
    await meetings.getByRole("button", { name: "Next page", exact: true }).click();
    const secondResponse = await secondPage; expect(secondResponse.ok()).toBe(true);
    const second = await secondResponse.json(); expect(second.items).toHaveLength(6); expect(second.total).toBe(31);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(31);
    await page.screenshot({ path: testInfo.outputPath("scoped-meeting-second-page.png") });
    expect(reads.filter((path) => path === "/api/cockpit")).toEqual([]);

    await page.goto(`${cockpit}?node=${leafB.id}&node_view=details&project=${projectA.id}&module=${moduleA.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("This object is outside the selected scope. Its own context is shown without changing your filter.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Project scope", exact: true })).toContainText(projectA.title);
    const ownScope = page.getByRole("link", { name: "Show this object’s scope", exact: true });
    await expect(ownScope).toHaveAttribute("href", expect.stringContaining(`project=${projectB.id}&module=${moduleB.id}`));
    await page.screenshot({ path: testInfo.outputPath("outside-scope-object.png") });
    await ownScope.click();
    await expect(page).toHaveURL(new RegExp(`node=${leafB.id}.*project=${projectB.id}.*module=${moduleB.id}`));
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("tab", { name: "Plan details", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("button", { name: "Project scope", exact: true }).click();
    await page.getByRole("button", { name: projectA.title, exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get("module")).toBeNull();
    await expect(navigation.getByRole("link", { name: "Artifacts", exact: true })).toHaveCount(0);
    await page.goto(`${cockpit}?tab=artifacts&project=${projectA.id}&module=${moduleA.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("This feature is not available yet. Materials remain available in tasks and meetings.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Execution plan", exact: true }).last()).toHaveAttribute("href", expect.stringContaining(`project=${projectA.id}&module=${moduleA.id}`));
    await page.goto(`${cockpit}?node=${leafA.id}&node_view=acceptance&project=${projectA.id}&module=${moduleA.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("This feature is not available yet. Materials remain available in tasks and meetings.", { exact: true })).toBeVisible();
    expect(reads.filter((path) => /\/api\/cockpit\/artifacts|\/acceptance(?:\/|$)/.test(path))).toEqual([]);
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } finally { if (ownsWorkspace) await api.cleanupCreatedWorkspace(); }
});

test("pages workspace contacts and explicitly clears a saved position from the meeting", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const api = new TestApiClient(); const run = `${Date.now().toString(36)}-${process.pid}`;
  await api.login(`e2e-directory-${run}@multica.ai`, "Directory fixture owner");
  let ownsWorkspace = false;
  try {
    const workspace = await api.createWorkspace(`Meeting contacts ${run}`, `e2e-directory-${run}`); ownsWorkspace = true;
    await api.markUserOnboarded(); await api.updateCockpitBoard({ title: "Programme contact workbench" });
    await api.seedCockpitDirectory(Array.from({ length: 31 }, (_, i) => ({ party: "Research team", name: `Contact ${String(i).padStart(2, "0")}`, position: i === 0 ? "Programme lead" : "Researcher" })));
    const meeting = await api.createCockpitMeeting({ title: "Evidence preparation meeting", meet_date: new Date().toISOString().slice(0, 10), parties: "Research team" });
    const token = api.getToken(); if (!token) throw new Error("Fixture token missing");
    await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = "multica-locale=en; path=/"; }, token);
    const directoryReads: string[] = [];
    page.on("request", (request) => { if (request.method() === "GET" && new URL(request.url()).pathname.startsWith("/api/cockpit/directory")) directoryReads.push(request.url()); });
    await page.goto(`/${workspace.slug}/cockpit?meeting=${meeting.id}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: "Details", exact: true }).click();
    await expect(page.getByRole("button", { name: "Attendees", exact: true })).toBeVisible();
    expect(directoryReads).toEqual([]);
    const firstResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/cockpit/directory/page");
    await page.getByRole("button", { name: "Attendees", exact: true }).click();
    const first = await (await firstResponse).json(); expect(first.items).toHaveLength(25); expect(first.total).toBe(31);
    const picker = page.getByRole("dialog", { name: "Attendees", exact: true });
    await expect(picker.getByRole("option", { name: /Contact 00/ })).toBeVisible();
    await picker.getByRole("option", { name: /Contact 00/ }).click();
    await picker.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(picker.getByRole("option", { name: /Contact 30/ })).toBeVisible();
    await expect(picker.getByRole("option")).toHaveCount(6);
    await expect(picker.getByRole("button", { name: "Remove Contact 00", exact: true })).toBeVisible();
    await picker.getByRole("textbox", { name: "Attendees", exact: true }).fill("Contact 03");
    await expect(picker.getByRole("option", { name: /Contact 03/ })).toBeVisible();
    await picker.getByRole("textbox", { name: "Attendees", exact: true }).fill("");
    await expect(picker.getByRole("option", { name: /Contact 00/ })).toBeVisible();
    await expect(picker.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
    await picker.getByRole("button", { name: "Edit the position for Contact 00", exact: true }).click();
    await picker.getByRole("button", { name: "Clear position", exact: true }).click();
    const saved = page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/cockpit/directory");
    await picker.getByRole("button", { name: "Save", exact: true }).click();
    const receipt = await (await saved).json(); expect(receipt.entries).toHaveLength(1); expect(receipt.entries[0]).toMatchObject({ party: "Research team", name: "Contact 00", position: "" });
    await expect(picker.getByRole("textbox", { name: "Position", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("meeting-contact-directory.png") });
    expect(directoryReads.every((url) => new URL(url).pathname === "/api/cockpit/directory/page")).toBe(true);
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } finally { if (ownsWorkspace) await api.cleanupCreatedWorkspace(); }
});
