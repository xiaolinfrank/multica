import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page, type Response } from "@playwright/test";
import { TestApiClient, type TestCockpitAttentionItem, type TestCockpitAttentionPage, type TestCockpitWorkOverview } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1150 }, locale: "en-US", timezoneId: "Asia/Shanghai",
  contextOptions: { reducedMotion: "reduce" }, screenshot: "only-on-failure", trace: "retain-on-failure" });

function localDay() {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function overviewRead(page: Page, predicate: (query: URLSearchParams) => boolean = () => true) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname === "/api/cockpit/overview" && predicate(url.searchParams);
  });
}

function attentionRead(page: Page, predicate: (query: URLSearchParams) => boolean) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname === "/api/cockpit/overview/attention" && predicate(url.searchParams);
  });
}

async function attentionBody(response: Response) {
  expect(response.status()).toBe(200);
  return await response.json() as TestCockpitAttentionPage;
}

test("drives the cockpit from scoped live work while retaining historical duties and business views", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  const api = new TestApiClient();
  const colleague = new TestApiClient();
  const run = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const owner = await api.login(`e2e-work-overview-${run}@multica.ai`, "PMO Reviewer");
  const colleagueEmail = `e2e-work-overview-peer-${run}@multica.ai`;
  const peer = await colleague.login(colleagueEmail, "Delivery Lead");
  let ownsWorkspace = false;
  try {
    const workspace = await api.createWorkspace(`Delivery review ${run}`, `e2e-overview-${run}`);
    ownsWorkspace = true;
    await api.markUserOnboarded();
    await api.addMemberByEmail(colleagueEmail);
    colleague.setWorkspaceId(workspace.id);
    colleague.setWorkspaceSlug(workspace.slug);
    const asOf = localDay();
    const future = `${Number(asOf.slice(0, 4)) + 1}-12-31`;
    const goal = "Turn decisions into traceable delivery";
    await api.updateCockpitBoard({ title: "Programme delivery cockpit", goal_title: goal, goal_date: future });
    const alpha = await api.createProject("Dashboard review — Atlas delivery");
    const beta = await api.createProject("Dashboard review — Beacon research");
    const emptyProjects = [];
    for (let i = 0; i < 25; i += 1) emptyProjects.push(await api.createProject(`Dashboard review sample ${String(i).padStart(2, "0")}`));
    const makePlan = async (project: { id: string; title: string }, prefix: string) => {
      const module = await api.createModule(project.id, `${prefix} delivery stream`);
      const dates = { start_date: asOf, end_date: future };
      const l1 = await api.createCockpitNode({ code: `${prefix}-L1`, name: project.title, project_id: project.id, ...dates });
      const l2 = await api.createCockpitNode({ code: `${prefix}-L2`, name: module.title, parent_id: l1.id, project_id: project.id, module_id: module.id, ...dates });
      const l3 = await api.createCockpitNode({ code: `${prefix}-L3`, name: `${prefix} evidence and acceptance`, parent_id: l2.id, ...dates });
      return { project_id: project.id, module_id: module.id, l3 };
    };
    const alphaPlan = await makePlan(alpha, "Atlas");
    const betaPlan = await makePlan(beta, "Beacon");
    const alphaScope = { project_id: alpha.id, module_id: alphaPlan.module_id };
    const betaScope = { project_id: beta.id, module_id: betaPlan.module_id };
    const oldTimestamp = "2024-01-15T09:00:00.000Z";
    const oldDate = "2024-01-15";
    const alphaIssues = await api.seedTableIssues(Array.from({ length: 80 }, (_, i) => ({
      title: `Atlas historical delivery ${String(i).padStart(3, "0")}`,
      status: i < 60 ? "backlog" : i < 70 ? "blocked" : i < 75 ? "done" : "cancelled",
      assigneeId: i < 60 || (i >= 70 && i < 75) ? owner.user.id : peer.user.id,
      projectId: alpha.id, moduleId: alphaPlan.module_id, dueDate: oldTimestamp,
    })));
    const betaIssues = await api.seedTableIssues(Array.from({ length: 46 }, (_, i) => ({
      title: `Beacon historical delivery ${String(i).padStart(3, "0")}`,
      status: i < 30 ? "backlog" : i < 45 ? "blocked" : "future_execution_state",
      assigneeId: i < 30 || i === 45 ? owner.user.id : peer.user.id,
      projectId: beta.id, moduleId: betaPlan.module_id, dueDate: oldTimestamp,
    })));
    for (const issue of alphaIssues) await api.setCockpitPrimaryNode(issue.id, alphaPlan.l3.id);
    for (const issue of betaIssues) await api.setCockpitPrimaryNode(issue.id, betaPlan.l3.id);
    await api.backdateFixtureIssues([...alphaIssues, ...betaIssues].map((issue) => issue.id), oldTimestamp);

    const ownerMeeting = await api.createCockpitMeeting({ title: "Historical owner sign-off", meet_date: oldDate });
    const ownPending = await api.seedPendingMeetingReview(ownerMeeting.id, owner.user.id, "# Historical evidence\n\nFormal review is still required.", alphaScope);
    const ownReview = ownPending.versions[0]!;
    await api.updateIssue(ownReview.review_issue.id, { status: "done", assignee_type: "member", assignee_id: peer.user.id, suppress_run: true });
    await api.backdateFixtureMeetingWorkflow(ownerMeeting.id, oldTimestamp);
    const peerMeeting = await api.createCockpitMeeting({ title: "Historical colleague sign-off", meet_date: oldDate });
    await api.seedPendingMeetingReview(peerMeeting.id, peer.user.id, "# Historical research\n\nThe designated colleague must review this version.", betaScope);
    await api.backdateFixtureMeetingWorkflow(peerMeeting.id, oldTimestamp);
    const actionMeeting = await api.createCockpitMeeting({ title: "Historical decision follow-up", meet_date: oldDate });
    const quote = "Keep unresolved proposals visible until a human disposes of them.";
    await api.seedPendingMeetingReview(actionMeeting.id, owner.user.id, `# First official version\n\n${quote}`, alphaScope);
    await api.approveMeetingMinutes(actionMeeting.id);
    const oldPublished = await api.publishMeetingMinutes(actionMeeting.id);
    const oldAction = await api.createMeetingAction(actionMeeting.id, oldPublished.published_version_id!, { title: "Resolve the superseded evidence proposal", source_quote: quote });
    await api.submitMeetingMinutesVersion(actionMeeting.id, "# Updated official version\n\nThe current scope has changed.");
    await api.approveMeetingMinutes(actionMeeting.id);
    await api.publishMeetingMinutes(actionMeeting.id);
    await api.backdateFixtureMeetingWorkflow(actionMeeting.id, oldTimestamp);
    const readiness = await api.createCockpitMeeting({ title: "Historical materials still outstanding", meet_date: oldDate });
    await api.enableMeetingWorkflow(readiness.id, { reviewer_id: owner.user.id, project_id: beta.id, module_id: betaPlan.module_id,
      assignee_type: "member", assignee_id: peer.user.id });
    await api.backdateFixtureMeetingWorkflow(readiness.id, oldTimestamp);
    const recent = await api.createCockpitMeeting({ title: "Next research coordination", meet_date: asOf });
    await api.linkCockpitMeetingIssue(recent.id, betaIssues[0]!.id);

    const snapshot = await api.getCockpitWorkOverview({ as_of: asOf });
    expect(snapshot.summary).toMatchObject({ primary_issues: { total: 126, active: 116, done: 5, closed: 5, unknown: 1, overdue: 116, blocked: 25 },
      my_primary_issues: { total: 96, active: 91, done: 5, closed: 0, unknown: 1 }, execution_nodes: { total: 2, with_active_issues: 2 },
      attention: { team_total: 120, mine_total: 92, team_by_kind: { workflow: 3, action: 1, nas: 0, issue: 116 }, mine_by_kind: { workflow: 1, action: 0, nas: 0, issue: 91 } } });
    expect(snapshot.recent_meetings.total).toBe(1);
    expect(snapshot.recent_meetings.items[0]!.id).toBe(recent.id);
    const peerSnapshot = await colleague.getCockpitWorkOverview({ as_of: asOf });
    expect(peerSnapshot.summary.attention.mine_total).toBe(26);
    expect((await api.getMeetingWorkflow(ownerMeeting.id)).versions[0]).toMatchObject({ decision: "pending", reviewer_id: owner.user.id, review_issue: { status: "done", assignee_id: peer.user.id } });

    if (process.env.MULTICA_E2E_OVERVIEW_SQL_PATH) {
      const plan = await api.explainCockpitAttention(await readFile(process.env.MULTICA_E2E_OVERVIEW_SQL_PATH, "utf8"), asOf);
      await writeFile(testInfo.outputPath("attention-explain.json"), JSON.stringify(plan, null, 2));
    }
    const token = api.getToken();
    if (!token) throw new Error("Dashboard fixture login returned no token");
    await page.addInitScript((value) => {
      localStorage.setItem("multica_token", value);
      localStorage.setItem("multica:chat:isOpen", "false");
      document.cookie = "multica-locale=en; path=/";
    }, token);
    const boardReads: string[] = [];
    let enforceLazyBoard = true;
    page.on("request", (request) => {
      if (enforceLazyBoard && request.method() === "GET" && new URL(request.url()).pathname === "/api/cockpit") boardReads.push(request.url());
    });
    const firstRead = overviewRead(page);
    await page.goto(`/${workspace.slug}/cockpit`, { waitUntil: "domcontentloaded" });
    const firstOverview = await (await firstRead).json() as TestCockpitWorkOverview;
    expect(firstOverview.attention).toMatchObject({ view: "mine", total: 92 });
    expect(firstOverview.attention.items).toHaveLength(8);
    const nextActions = page.getByRole("region", { name: "Next actions", exact: true });
    await expect(nextActions).toBeVisible();
    await expect(page.getByRole("region", { name: "Execution snapshot", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Recent meetings", exact: true })).toBeVisible();
    expect(boardReads).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath("work-overview-live-home.png"), animations: "disabled" });

    await test.step("continue the eight-row preview without mixing its cursor into a full page", async () => {
      const continued = attentionRead(page, (query) => query.get("cursor") === firstOverview.attention.next_cursor && query.get("page_size") === "8");
      await nextActions.getByRole("button", { name: "Next page", exact: true }).click();
      const second = await attentionBody(await continued);
      expect(second.items).toHaveLength(8);
      expect(second.total).toBe(92);
      expect(second.items.some((item) => firstOverview.attention.items.some((first) => first.id === item.id && first.kind === item.kind))).toBe(false);
    });

    const fullMine = attentionRead(page, (query) => query.get("page_size") === "25" && !query.get("cursor") && query.get("view") === "mine");
    await page.getByRole("button", { name: "View all next actions", exact: true }).click();
    expect((await attentionBody(await fullMine)).items).toHaveLength(25);
    const teamRead = attentionRead(page, (query) => query.get("view") === "team" && query.get("page_size") === "25" && !query.get("cursor"));
    await page.getByRole("button", { name: "Team queue", exact: true }).click();
    let current = await attentionBody(await teamRead);
    const seen = new Map<string, TestCockpitAttentionItem>();
    await test.step("read all 120 current duties, including old pending reviews and superseded proposals", async () => {
      let pages = 0;
      for (;;) {
        expect(current.total).toBe(120);
        expect(current.items.length).toBeLessThanOrEqual(25);
        for (const item of current.items) {
          const key = `${item.kind}:${item.id}`;
          expect(seen.has(key)).toBe(false);
          seen.set(key, item);
        }
        pages += 1;
        if (!current.next_cursor) break;
        const cursor = current.next_cursor;
        const next = attentionRead(page, (query) => query.get("cursor") === cursor && query.get("page_size") === "25");
        await nextActions.getByRole("button", { name: "Next page", exact: true }).click();
        current = await attentionBody(await next);
      }
      expect(pages).toBe(5);
      expect(seen.size).toBe(120);
      const items = [...seen.values()];
      expect(items.filter((item) => item.kind === "issue")).toHaveLength(116);
      expect(items.find((item) => item.kind === "workflow" && item.target.meeting_id === ownerMeeting.id))
        .toMatchObject({ reason: "review_pending", responsibility: "formal_reviewer", assignee_id: owner.user.id });
      expect(items.find((item) => item.target.action_id === oldAction.id))
        .toMatchObject({ reason: "action_superseded", responsibility: "team_management", flags: ["source_superseded"] });
      expect(items.filter((item) => item.flags.includes("blocked") && item.flags.includes("overdue"))).toHaveLength(25);
      expect(items.filter((item) => item.created_at.startsWith("2024-")).length).toBe(120);
      expect(boardReads).toHaveLength(0);
    });

    const projectScope = page.getByRole("region", { name: "Project scope", exact: true });
    const projectRead = (q: string, cursor = "") => page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/cockpit/scopes/projects" && url.searchParams.get("q") === q && (url.searchParams.get("cursor") ?? "") === cursor;
    });
    const chooseProject = async (project: { id: string; title: string }, expected: number, audience: string) => {
      await page.getByRole("button", { name: "Project scope", exact: true }).click();
      const search = projectRead(project.title);
      await projectScope.getByRole("textbox", { name: "Search projects", exact: true }).fill(project.title);
      expect((await search).status()).toBe(200);
      const initial = overviewRead(page, (query) => query.get("project_id") === project.id && query.get("attention_view") === "mine");
      await projectScope.getByRole("button", { name: project.title, exact: true }).click();
      const preview = await (await initial).json() as TestCockpitWorkOverview;
      expect(preview.attention.view).toBe("mine"); expect(preview.attention.items.length).toBeLessThanOrEqual(8);
      if (audience === "team") await page.getByRole("button", { name: "Team queue", exact: true }).click();
      const read = attentionRead(page, (query) => query.get("project_id") === project.id && query.get("view") === audience && query.get("page_size") === "25" && !query.get("cursor"));
      await page.getByRole("button", { name: "View all next actions", exact: true }).click();
      expect((await attentionBody(await read)).total).toBe(expected);
      await expect(nextActions.getByText(`Page 1 · ${Math.min(25, expected)} shown · ${expected} matching`, { exact: true })).toBeVisible();
    };
    await test.step("search project scope in bounded pages and keep each scope’s queue independent", async () => {
      await page.getByRole("button", { name: "Project scope", exact: true }).click();
      const first = projectRead("Dashboard review");
      await projectScope.getByRole("textbox", { name: "Search projects", exact: true }).fill("Dashboard review");
      const searchFirst = await first;
      const projectsFirst = await searchFirst.json();
      expect(projectsFirst.items).toHaveLength(20);
      expect(projectsFirst.next_cursor).toBeTruthy();
      const second = projectRead("Dashboard review", projectsFirst.next_cursor);
      await projectScope.getByRole("button", { name: "Next page", exact: true }).click();
      expect((await (await second).json()).items).toHaveLength(7);
      await page.keyboard.press("Escape");
      await chooseProject(alpha, 72, "team");
      const mine = attentionRead(page, (query) => query.get("view") === "mine" && query.get("project_id") === alpha.id && !query.get("cursor"));
      await page.getByRole("button", { name: "My queue", exact: true }).click();
      expect((await attentionBody(await mine)).total).toBe(61);
      await chooseProject(beta, 31, "mine");
      const betaTeam = attentionRead(page, (query) => query.get("view") === "team" && query.get("project_id") === beta.id && !query.get("cursor"));
      await page.getByRole("button", { name: "Team queue", exact: true }).click();
      expect((await attentionBody(await betaTeam)).total).toBe(48);
      await chooseProject(emptyProjects[24]!, 0, "team");
      await expect(nextActions.getByText("No pending work in this scope.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Project scope", exact: true }).click();
      await projectScope.getByRole("button", { name: "All projects", exact: true }).click();
      await expect(nextActions.getByText("Page 5 · 20 shown · 120 matching", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Back to work overview", exact: true }).click();
      await page.getByRole("button", { name: "View all next actions", exact: true }).click();
      await expect(nextActions.getByText("Page 1 · 25 shown · 120 matching", { exact: true })).toBeVisible();
      expect(boardReads).toHaveLength(0);
    });
    const chooseKind = async (label: string) => {
      await page.getByRole("combobox", { name: "Work type", exact: true }).click();
      await page.getByRole("option", { name: label, exact: true }).click();
    };
    await test.step("open actual historical sources without granting new work or losing return context", async () => {
      const actionRead = attentionRead(page, (query) => query.get("kind") === "action" && !query.get("cursor"));
      await chooseKind("Action suggestions");
      expect((await attentionBody(await actionRead)).total).toBe(1);
      const oldSuggestion = nextActions.getByRole("article", { name: oldAction.title, exact: true });
      await expect(oldSuggestion.getByText("Source superseded", { exact: true })).toBeVisible();
      const oldLink = oldSuggestion.getByRole("link");
      await expect(oldLink).toHaveAttribute("href", `/${workspace.slug}/cockpit?meeting=${actionMeeting.id}&action=${oldAction.id}`);
      expect(boardReads).toHaveLength(0);
      enforceLazyBoard = false;
      await oldLink.click();
      await expect(page.getByRole("dialog", { name: "Confirm action", exact: true })).toBeVisible();
      await expect(page.getByRole("dialog").getByText("A newer official version exists. This pending suggestion can be marked as not proceeding; new execution must use the current official version.", { exact: true })).toBeVisible();
      await page.goBack();
      await expect(page.getByRole("button", { name: "Back to work overview", exact: true })).toBeVisible();
      await expect(nextActions.getByRole("article", { name: oldAction.title, exact: true })).toBeVisible();
      const workflowRead = attentionRead(page, (query) => query.get("kind") === "workflow" && !query.get("cursor"));
      await chooseKind("Meeting workflows");
      expect((await attentionBody(await workflowRead)).total).toBe(3);
      const ownerItem = [...seen.values()].find((item) => item.kind === "workflow" && item.target.meeting_id === ownerMeeting.id)!;
      const ownerLink = nextActions.getByRole("article", { name: ownerItem.title, exact: true }).getByRole("link");
      await expect(ownerLink).toHaveAttribute("href", `/${workspace.slug}/cockpit?meeting=${ownerMeeting.id}`);
      await ownerLink.click();
      await expect(page).toHaveURL(new RegExp(`meeting=${ownerMeeting.id}`));
      await expect(page.getByRole("button", { name: "Read and review minutes", exact: true })).toBeVisible();
      await expect(page.getByText("Pending review", { exact: true }).first()).toBeVisible();
      await page.goBack();
      await expect(nextActions.getByRole("article")).toHaveCount(3);
      await chooseKind("All work");
      await expect(nextActions.getByText("Page 1 · 25 shown · 120 matching", { exact: true })).toBeVisible();
      await nextActions.getByRole("button", { name: "Next page", exact: true }).click();
      await expect(nextActions.getByText("Page 2 · 25 shown · 120 matching", { exact: true })).toBeVisible();
      const issueLink = nextActions.getByRole("link", { name: "Open issue", exact: true }).first();
      const issueHref = await issueLink.getAttribute("href");
      expect(issueHref).toMatch(new RegExp(`^/${workspace.slug}/issues/[a-f0-9-]+$`));
      await issueLink.click();
      await expect(page).toHaveURL(new RegExp(issueHref!));
      await expect(page.getByRole("region", { name: "Next actions", exact: true })).toHaveCount(0);
      await page.goBack();
      await expect(nextActions.getByText("Page 2 · 25 shown · 120 matching", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("work-overview-team-queue.png"), animations: "disabled" });
    });
    await test.step("retain dashboard scroll on source return and keep the business overview reachable", async () => {
      await page.getByRole("button", { name: "Back to work overview", exact: true }).click();
      await page.setViewportSize({ width: 1600, height: 850 });
      const main = page.getByRole("region", { name: "Work overview", exact: true });
      const scroller = main.locator(":scope > div");
      const recentLink = page.getByRole("region", { name: "Recent meetings", exact: true }).getByRole("link", { name: new RegExp(recent.title) });
      await recentLink.scrollIntoViewIfNeeded();
      const priorScroll = await scroller.evaluate((element) => element.scrollTop);
      expect(priorScroll).toBeGreaterThan(0);
      await recentLink.click();
      await expect(page).toHaveURL(new RegExp(`meeting=${recent.id}`));
      await expect(page.getByRole("button", { name: "Enable work package", exact: true })).toBeVisible();
      await page.goBack();
      await expect(recentLink).toBeVisible();
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(priorScroll - 20);
      await scroller.evaluate((element) => { element.scrollTop = 0; });
      await page.setViewportSize({ width: 1600, height: 1150 });
      await page.getByRole("navigation", { name: "Cockpit sections", exact: true }).getByRole("link", { name: "Execution plan", exact: true }).click();
      await page.getByRole("link", { name: "Business overview", exact: true }).click();
      await expect(page).toHaveURL(new RegExp("plan_view=operations"));
      await expect(page.getByText(goal, { exact: true }).first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("work-overview-business-access.png"), animations: "disabled" });
      await page.getByRole("navigation", { name: "Cockpit sections", exact: true }).getByRole("link", { name: "Overview", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Work overview", exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("work-overview-team-home.png"), animations: "disabled" });
      await page.setViewportSize({ width: 1100, height: 1100 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("work-overview-narrow.png"), animations: "disabled" });
      await page.setViewportSize({ width: 1600, height: 1150 });
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveClass(/dark/);
      await page.screenshot({ path: testInfo.outputPath("work-overview-dark.png"), animations: "disabled" });
      await page.emulateMedia({ colorScheme: "light" });
      await expect(page.locator("html")).not.toHaveClass(/dark/);
      await page.setViewportSize({ width: 320, height: 950 });
      const dimensions = await main.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { viewport: window.innerWidth, outerScrollWidth: document.documentElement.scrollWidth,
          cockpitLeft: rect.left, cockpitWidth: rect.width, cockpitClientWidth: element.clientWidth, cockpitScrollWidth: element.scrollWidth };
      });
      await writeFile(testInfo.outputPath("work-overview-320-layout.json"), JSON.stringify(dimensions, null, 2));
      expect(dimensions.cockpitScrollWidth).toBeLessThanOrEqual(dimensions.cockpitClientWidth + 1);
      for (const control of [page.getByRole("button", { name: "Project scope", exact: true }), page.getByRole("button", { name: "My queue", exact: true }),
        page.getByRole("button", { name: "Team queue", exact: true }), page.getByRole("combobox", { name: "Work type", exact: true })]) {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(321);
      }
      await scroller.evaluate((element) => { element.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath("work-overview-320.png"), animations: "disabled" });
    });
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
    const facts = JSON.stringify({ workspace_id: workspace.id, alpha_id: alpha.id, beta_id: beta.id,
      empty_project_id: emptyProjects[24]!.id, old_review_meeting_id: ownerMeeting.id, old_action_id: oldAction.id, as_of: asOf,
      summary: snapshot.summary, board_reads_before_source_navigation: boardReads.length }, null, 2);
    await writeFile(testInfo.outputPath("work-overview-fixture-facts.json"), facts);
    await testInfo.attach("work-overview-fixture-facts", { body: facts, contentType: "application/json" });
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath("failure-before-cleanup.png"), animations: "disabled" }).catch(() => {});
    await writeFile(testInfo.outputPath("failure-before-cleanup.txt"), await page.locator("body").innerText()).catch(() => {});
    throw error;
  } finally {
    if (ownsWorkspace) await api.cleanupCreatedWorkspace();
  }
});
