import { expect, test, type Locator, type Page } from "@playwright/test";
import { TestApiClient, type TestMeetingActionPage, type TestMeetingAction } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1200 }, locale: "en-US", timezoneId: "Asia/Shanghai",
  contextOptions: { reducedMotion: "reduce" }, screenshot: "only-on-failure", trace: "retain-on-failure" });

async function chooseNode(page: Page, dialog: Locator, name: string) {
  await dialog.getByRole("button", { name: "Primary work item", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`${name}$`) }).click();
}

test("pages meeting suggestions and reusable issues, then confirms each action only once", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  const api = new TestApiClient();
  const run = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const auth = await api.login(`e2e-actions-${run}@multica.ai`, "Meeting Actions Owner");
  let ownsWorkspace = false;
  try {
    const workspace = await api.createWorkspace(`Meeting Actions ${run}`, `e2e-actions-${run}`);
    ownsWorkspace = true;
    await api.markUserOnboarded();
    const project = await api.createProject("Action execution project");
    const module = await api.createModule(project.id, "Evidence delivery");
    const day = new Date().toISOString().slice(0, 10);
    const dates = { start_date: day, end_date: day };
    const l1 = await api.createCockpitNode({ code: "A-L1", name: "Acceptance programme", project_id: project.id, ...dates });
    const l2 = await api.createCockpitNode({ code: "A-L2", name: "Delivery stream", parent_id: l1.id, project_id: project.id, module_id: module.id, ...dates });
    const l3 = await api.createCockpitNode({ code: "A-L3", name: "Complete the approved evidence", parent_id: l2.id, ...dates });
    const candidates = await api.seedTableIssues(Array.from({ length: 125 }, (_, index) => ({
      title: `Reusable candidate ${String(index).padStart(3, "0")}`,
      status: "in_progress" as const, priority: "high" as const,
      projectId: project.id, moduleId: module.id, assigneeId: auth.user.id, dueDate: "2030-06-15T00:00:00.000Z",
    })));
    const firstCandidates = await api.searchIssues("Reusable candidate", { includeClosed: true, limit: 25 });
    const selected = candidates.find((issue) => !firstCandidates.issues.some((first) => first.id === issue.id));
    if (!selected) throw new Error("Reusable fixture did not extend beyond one page");
    const beforeReuse = await api.getIssue(selected.id);
    const meeting = await api.createCockpitMeeting({ title: "Published action evidence review", meet_date: day });
    const quote = "Validate the acceptance evidence before delivery.";
    await api.seedPendingMeetingReview(meeting.id, auth.user.id, `# Confirmed minutes\n\n${quote}\n\nA human decides which suggestions become execution issues.`);
    await api.approveMeetingMinutes(meeting.id);
    const published = await api.publishMeetingMinutes(meeting.id);
    const versionId = published.published_version_id!;
    const suggestions: TestMeetingAction[] = [];
    for (let index = 0; index < 55; index += 1) {
      suggestions.push(await api.createMeetingAction(meeting.id, versionId, {
        title: `Candidate action ${String(index).padStart(3, "0")}`,
        description: "A proposal awaiting an explicit human decision.", source_quote: quote,
      }));
    }
    const token = api.getToken();
    if (!token) throw new Error("Action fixture login returned no token");
    await page.addInitScript((value) => {
      localStorage.setItem("multica_token", value);
      localStorage.setItem("multica:chat:isOpen", "false");
      document.cookie = "multica-locale=en; path=/";
    }, token);
    const actionPath = `/api/cockpit/meetings/${meeting.id}/workflow/actions`;
    const actionRead = (matches: (query: URLSearchParams) => boolean) => page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === actionPath && response.request().method() === "GET" && matches(url.searchParams);
    });
    await page.goto(`/${workspace.slug}/cockpit?meeting=${meeting.id}`, { waitUntil: "domcontentloaded" });
    const actions = page.getByRole("region", { name: "Meeting actions", exact: true });
    await expect(actions).toBeVisible();
    await actions.getByLabel("Action status", { exact: true }).click();
    await page.getByRole("option", { name: "All actions", exact: true }).click();
    const createdTitle = "Action from browser approval — confirm the acceptance boundary and retain evidence for delivery, stakeholder review and the next planning meeting";
    await test.step("add a suggestion from the fixed version without creating an issue", async () => {
      await actions.getByRole("button", { name: "Add action suggestion", exact: true }).click();
      const add = page.getByRole("dialog", { name: "Add action suggestion", exact: true });
      await add.getByLabel("Action title", { exact: true }).fill(createdTitle);
      await add.getByLabel("Action details", { exact: true }).fill("Prepare a separately accountable evidence check.");
      await add.getByLabel("Source excerpt", { exact: true }).fill(quote);
      await add.getByRole("button", { name: "Save suggestion", exact: true }).click();
      await expect(add).toBeHidden();
      expect((await api.getMeetingActions(meeting.id)).total).toBe(56);
      expect(await api.getWorkspaceIssueIdsByTitle(createdTitle)).toHaveLength(0);
      expect((await api.getCockpitTasks(l3.id)).total).toBe(0);
    });

    await test.step("page all suggestions and search outside the first page on the server", async () => {
      let current = await api.getMeetingActions(meeting.id);
      const firstIDs = new Set(current.items.map((action) => action.id));
      const seen = new Set<string>();
      let pages = 0;
      for (;;) {
        expect(current.items.length).toBeLessThanOrEqual(25);
        expect(current.total).toBe(56);
        for (const item of current.items) { expect(seen.has(item.id)).toBe(false); seen.add(item.id); }
        pages += 1;
        await expect(actions.getByText(current.items[0]!.title, { exact: true })).toBeVisible();
        if (!current.next_cursor) break;
        const cursor = current.next_cursor;
        const next = actionRead((query) => query.get("cursor") === cursor);
        await actions.getByRole("button", { name: "Next page", exact: true }).click();
        current = await (await next).json() as TestMeetingActionPage;
      }
      expect(pages).toBe(3);
      expect(seen.size).toBe(56);
      const target = suggestions.find((action) => !firstIDs.has(action.id))!;
      const searched = actionRead((query) => query.get("q") === target.title && !query.get("cursor"));
      await actions.getByRole("textbox", { name: "Search meeting actions", exact: true }).fill(target.title);
      const result = await (await searched).json() as TestMeetingActionPage;
      expect(result).toMatchObject({ total: 56, filtered_total: 1, next_cursor: null });
      expect(result.items[0]!.id).toBe(target.id);
    });

    const openAction = async (title: string) => {
      await actions.getByRole("textbox", { name: "Search meeting actions", exact: true }).fill(title);
      const link = actions.getByRole("link", { name: `Review action ${title}`, exact: true });
      const href = await link.getAttribute("href");
      if (!href) throw new Error("Action review has no destination");
      await link.click();
      await expect(page).toHaveURL(href);
      const dialog = page.getByRole("dialog", { name: "Confirm action", exact: true });
      await expect(dialog).toBeVisible();
      return dialog;
    };
    await test.step("cancel a confirmation without creating or dispatching work", async () => {
      const pending = suggestions[0]!;
      const dialog = await openAction(pending.title);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      expect((await api.getMeetingActions(meeting.id, { q: pending.title })).items[0]).toMatchObject({ status: "draft", issue: null });
      expect(await api.getWorkspaceIssueIdsByTitle(pending.title)).toHaveLength(0);
      expect(await api.getWorkspaceAgentRunCount()).toBe(0);
    });

    await test.step("confirm a new backlog issue once and safely replay the same decision", async () => {
      const dialog = await openAction(createdTitle);
      await chooseNode(page, dialog, l3.name);
      const request = page.waitForRequest((req) => req.method() === "POST" && new URL(req.url()).pathname.startsWith(actionPath) && new URL(req.url()).pathname.endsWith("/resolve"));
      await dialog.getByRole("button", { name: "Confirm action", exact: true }).click();
      const submitted = await request;
      await expect(dialog).toBeHidden();
      const resolved = (await api.getMeetingActions(meeting.id, { q: createdTitle })).items[0]!;
      expect(resolved).toMatchObject({ status: "accepted", resolution: "create", node_id: l3.id,
        issue: { status: "backlog", assignee_type: "member", assignee_id: auth.user.id, project_id: project.id, module_id: module.id, primary_node_id: l3.id } });
      const repeated = await api.resolveMeetingAction(meeting.id, resolved.id, submitted.postDataJSON());
      expect(repeated.issue?.id).toBe(resolved.issue?.id);
      expect(repeated.decision_key).toBe(resolved.decision_key);
      expect(await api.getWorkspaceIssueIdsByTitle(createdTitle)).toEqual([resolved.issue!.id]);
      expect((await api.getCockpitTasks(l3.id)).total).toBe(1);
      expect(await api.getWorkspaceAgentRunCount()).toBe(0);
    });

    await test.step("page the issue's action sources and return to the exact meeting decision", async () => {
      const origin = (await api.getMeetingActions(meeting.id, { q: createdTitle })).items[0]!;
      for (let index = 0; index < 26; index += 1) {
        const proposal = await api.createMeetingAction(meeting.id, versionId, { title: `Additional evidence source ${String(index).padStart(3, "0")}`, source_quote: quote });
        await api.resolveMeetingAction(meeting.id, proposal.id, {
          expected_revision: proposal.revision, decision_key: crypto.randomUUID(), outcome: "reuse", node_id: l3.id, issue_id: origin.issue!.id,
        });
      }
      expect((await api.getCockpitTasks(l3.id)).total).toBe(1);
      const sourcePath = `/api/cockpit/issues/${origin.issue!.id}/actions`;
      const first = page.waitForResponse((response) => new URL(response.url()).pathname === sourcePath && !new URL(response.url()).searchParams.get("cursor"));
      await actions.getByRole("link", { name: `${origin.issue!.identifier} ${createdTitle}`, exact: true }).click();
      const firstResponse = await first;
      const initialSources = await firstResponse.json() as { total: number; items: Array<{ id: string }>; next_cursor: string };
      expect(new URL(firstResponse.url()).searchParams.get("page_size")).toBe("25");
      expect(initialSources.total).toBe(27);
      expect(initialSources.items).toHaveLength(25);
      const sources = page.getByRole("region", { name: "Meeting action sources", exact: true });
      const next = page.waitForResponse((response) => new URL(response.url()).pathname === sourcePath && new URL(response.url()).searchParams.get("cursor") === initialSources.next_cursor);
      await sources.getByRole("button", { name: "Next page", exact: true }).click();
      const finalSources = await (await next).json() as { total: number; items: Array<{ id: string }>; next_cursor: null };
      expect(finalSources).toMatchObject({ total: 27, next_cursor: null });
      expect(finalSources.items).toHaveLength(2);
      expect(finalSources.items.some((source) => initialSources.items.some((firstSource) => firstSource.id === source.id))).toBe(false);
      const destination = `/${workspace.slug}/cockpit?meeting=${meeting.id}&action=${origin.id}`;
      const exactSource = sources.locator(`a[href="${destination}"]`);
      await expect(exactSource).toHaveCount(1);
      await exactSource.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("issue-action-sources-page-two.png"), animations: "disabled" });
      await exactSource.click();
      await expect(page).toHaveURL(destination);
      const detail = page.getByRole("dialog", { name: "Confirm action", exact: true });
      await expect(detail.getByText(createdTitle, { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(detail).toBeHidden();
      await expect(actions.getByRole("textbox", { name: "Search meeting actions", exact: true })).toHaveValue(createdTitle);
    });

    await test.step("search reusable issues with bounded pages and preserve the chosen issue's facts", async () => {
      const pending = suggestions[1]!;
      const searchRequests: URL[] = [];
      const capture = (request: import("@playwright/test").Request) => {
        const url = new URL(request.url());
        if (url.pathname === "/api/issues/search") searchRequests.push(url);
      };
      page.on("request", capture);
      const dialog = await openAction(pending.title);
      await dialog.getByLabel("Action outcome", { exact: true }).click();
      await page.getByRole("option", { name: "Reuse issue", exact: true }).click();
      await chooseNode(page, dialog, l3.name);
      const picker = dialog.getByRole("region", { name: "Search existing issues", exact: true });
      await expect(picker.getByRole("textbox", { name: "Search existing issues", exact: true })).toHaveValue("");
      expect(searchRequests).toHaveLength(0);
      const searchRead = (q: string, offset: number) => page.waitForResponse((res) => {
        const url = new URL(res.url());
        return url.pathname === "/api/issues/search" && url.searchParams.get("q") === q && Number(url.searchParams.get("offset") ?? 0) === offset;
      });
      const first = searchRead("Reusable candidate", 0);
      await picker.getByRole("textbox", { name: "Search existing issues", exact: true }).fill("Reusable candidate");
      const firstResponse = await first;
      expect(new URL(firstResponse.url()).searchParams.get("limit")).toBe("25");
      const firstPage = await firstResponse.json() as { issues: Array<{ id: string }> };
      expect(firstPage.issues).toHaveLength(25);
      const second = searchRead("Reusable candidate", 25);
      await picker.getByRole("button", { name: "Next page", exact: true }).click();
      const secondPage = await (await second).json() as { issues: Array<{ id: string }> };
      expect(secondPage.issues).toHaveLength(25);
      expect(secondPage.issues.some((issue) => firstPage.issues.some((firstIssue) => firstIssue.id === issue.id))).toBe(false);
      const exact = searchRead(selected.title, 0);
      await picker.getByRole("textbox", { name: "Search existing issues", exact: true }).fill(selected.title);
      expect((await (await exact).json()).issues.map((issue: { id: string }) => issue.id)).toContain(selected.id);
      expect(searchRequests.every((url) => Boolean(url.searchParams.get("q")) && url.searchParams.get("limit") === "25")).toBe(true);
      page.off("request", capture);
      await picker.getByRole("button").filter({ hasText: selected.title }).click();
      await expect(dialog.getByText(new RegExp(`Selected issue:.*${selected.title}`))).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Confirm action", exact: true })).toBeEnabled();
      const configure = dialog.getByRole("link", { name: "Configure selected work item (new tab)", exact: true });
      const repairPath = `/${workspace.slug}/cockpit?node=${l3.id}&node_view=details`;
      await expect(configure).toHaveAttribute("href", repairPath);
      const popupReady = page.waitForEvent("popup");
      await configure.click();
      const repairPage = await popupReady;
      await expect(repairPage).toHaveURL(repairPath);
      await expect(repairPage.getByRole("tab", { name: "Plan details", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(repairPage.getByRole("region", { name: "Project and module binding", exact: true })).toContainText(module.title);
      await repairPage.close();
      await expect(dialog.getByText(new RegExp(`Selected issue:.*${selected.title}`))).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL((url) => url.searchParams.get("meeting") === meeting.id && !url.searchParams.has("action"));
      await page.reload({ waitUntil: "domcontentloaded" });
      const restored = await openAction(pending.title);
      await expect(restored.getByLabel("Action outcome", { exact: true })).toContainText("Reuse issue");
      await expect(restored.getByRole("button", { name: "Primary work item", exact: true })).toContainText(l3.name);
      await expect(restored.getByText(new RegExp(`Selected issue:.*${selected.title}`))).toBeVisible();
      await expect(restored.getByRole("button", { name: "Confirm action", exact: true })).toBeEnabled();
      expect((await api.getMeetingActions(meeting.id, { q: pending.title })).items[0]).toMatchObject({ status: "draft", issue: null });
      expect((await api.getCockpitTasks(l3.id)).total).toBe(1);
      expect(await api.getWorkspaceAgentRunCount()).toBe(0);
      await page.screenshot({ path: testInfo.outputPath("meeting-action-reuse-confirmation.png"), animations: "disabled" });
      await restored.getByRole("button", { name: "Confirm action", exact: true }).click();
      await expect(restored).toBeHidden();
      const reused = (await api.getMeetingActions(meeting.id, { q: pending.title })).items[0]!;
      expect(reused).toMatchObject({ status: "accepted", resolution: "reuse", node_id: l3.id, issue: { id: selected.id, primary_node_id: l3.id } });
      const afterReuse = await api.getIssue(selected.id);
      for (const field of ["title", "status", "priority", "assignee_type", "assignee_id", "due_date", "project_id", "module_id"]) expect(afterReuse[field]).toEqual(beforeReuse[field]);
      expect((await api.getCockpitTasks(l3.id)).total).toBe(2);
    });

    await test.step("record a deliberate decision not to proceed without creating a task", async () => {
      const pending = suggestions[2]!;
      const dialog = await openAction(pending.title);
      await dialog.getByLabel("Action outcome", { exact: true }).click();
      await page.getByRole("option", { name: "Do not proceed", exact: true }).click();
      await dialog.getByLabel("Reason", { exact: true }).fill("The proposal is outside the agreed delivery scope.");
      await dialog.getByRole("button", { name: "Confirm action", exact: true }).click();
      await expect(dialog).toBeHidden();
      expect((await api.getMeetingActions(meeting.id, { q: pending.title })).items[0]).toMatchObject({ status: "dismissed", resolution: "dismiss", issue: null });
      expect(await api.getWorkspaceIssueIdsByTitle(pending.title)).toHaveLength(0);
      expect((await api.getCockpitTasks(l3.id)).total).toBe(2);
      expect(await api.getWorkspaceAgentRunCount()).toBe(0);
      await page.setViewportSize({ width: 1100, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await actions.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("meeting-actions-narrow.png"), animations: "disabled" });
    });
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath("failure-before-cleanup.png"), animations: "disabled" }).catch(() => {});
    await testInfo.attach("failure-before-cleanup", { body: await page.locator("body").innerText(), contentType: "text/plain" }).catch(() => {});
    throw error;
  } finally {
    if (ownsWorkspace) await api.cleanupCreatedWorkspace();
  }
});
