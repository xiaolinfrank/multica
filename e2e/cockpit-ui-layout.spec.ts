import { expect, test } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({ locale: "en-US", timezoneId: "Asia/Shanghai", reducedMotion: "reduce", trace: "retain-on-failure" });

test("keeps cockpit navigation, timelines and workbenches usable across themes and available widths", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const api = new TestApiClient();
  const run = `${Date.now().toString(36)}-${process.pid}`;
  const auth = await api.login(`e2e-cockpit-ui-${run}@multica.ai`, "Cockpit UI fixture");
  let ownsWorkspace = false;
  try {
    const workspace = await api.createWorkspace(`Cockpit UI ${run}`, `e2e-cockpit-ui-${run}`);
    ownsWorkspace = true;
    await api.markUserOnboarded();
    const title = "Programme evidence and delivery — 多项目跨团队执行与会议协作驾驶舱";
    await api.updateCockpitBoard({ title });
    const project = await api.createProject("Programme with a deliberately long context label");
    const module = await api.createModule(project.id, "Evidence preparation and formal acceptance");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const future = `${Number(today.slice(0, 4)) + 1}-12-31`;
    const root = await api.createCockpitNode({ code: "UI", name: project.title, project_id: project.id, start_date: today, end_date: future });
    const group = await api.createCockpitNode({ code: "UI.01", name: module.title, parent_id: root.id, module_id: module.id, start_date: today, end_date: future });
    const leaf = await api.createCockpitNode({ code: "UI.01.01", name: "Prepare traceable evidence with a long execution-task title", parent_id: group.id, start_date: today, end_date: future });
    await api.patchOwnedCockpitNode(leaf.id, { budget_amount: 50.068608, exec_status: "paid", owner: "Delivery coordinator", collaborators: "Evidence author, Quality reviewer" });
    await api.createOwnedCockpitMilestone(leaf.id, "Evidence baseline recorded", today, today);
    await api.createOwnedCockpitMilestone(leaf.id, "Formal release checkpoint", future);
    const meeting = await api.createCockpitMeeting({ title: "Evidence review and delivery coordination", meet_date: today });
    await api.appendCockpitMeetingNode(meeting.id, leaf.id);
    const source = await api.createIssue("Prepare independently reviewable evidence", { project_id: project.id, module_id: module.id, status: "backlog", assignee_type: "member", assignee_id: auth.user.id });
    await api.linkCockpitNodeIssue(leaf.id, source.id);
    const artifact = await api.createOwnedPendingTextArtifact(leaf.id, source.id, auth.user.id);
    const secondArtifact = await api.createOwnedPendingTextArtifact(leaf.id, source.id, auth.user.id);
    await api.renameOwnedArtifactForLayout(secondArtifact.id, "Delivery checklist — 交付材料与验收依据");
    await api.seedCockpitProposals([
      { node: leaf.id, field: "progress", new_value: "60", reason: "Review evidence before updating the execution plan" },
      { node: leaf.id, field: "owner", new_value: "Accountable coordinator", reason: "Confirm accountable ownership" },
    ]);
    const token = api.getToken();
    if (!token) throw new Error("Cockpit UI fixture token missing");
    await page.addInitScript((value) => {
      localStorage.setItem("multica_token", value);
      localStorage.setItem("multica:chat:isOpen", "false");
      document.cookie = "multica-locale=en; path=/";
    }, token);
    const cockpit = `/${workspace.slug}/cockpit`;
    const scope = `project=${project.id}&module=${module.id}`;
    const sections = page.getByRole("navigation", { name: "Cockpit sections", exact: true });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const width of [1440, 768, 320]) {
        await page.setViewportSize({ width, height: 960 });
        for (const tab of ["chat", "work", "plan", "meetings", "artifacts", "governance"]) {
          await page.goto(`${cockpit}?tab=${tab}&${scope}`, { waitUntil: "domcontentloaded" });
          await expect(sections).toBeVisible();
          await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: title })).toBeVisible();
          if (tab === "artifacts" && await sections.getByRole("link", { name: "Artifacts", exact: true }).count() === 0) {
            await expect(page.getByText("This feature is not available yet. Materials remain available in tasks and meetings.", { exact: true })).toBeVisible();
            await expect(sections.locator('a[aria-current="page"]')).toHaveCount(0);
          } else {
            await expect(sections.locator('a[aria-current="page"]')).toHaveCount(1);
          }
          if (width === 1440) {
            expect(await sections.evaluate((element) => element.closest("header")!.getBoundingClientRect().height)).toBeLessThan(136);
            expect(await sections.evaluate((element) => {
              const nav = element.getBoundingClientRect();
              return [...element.querySelectorAll("a")].every((link) => {
                const box = link.getBoundingClientRect();
                return box.left >= nav.left && box.right <= nav.right;
              });
            })).toBe(true);
          }
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
          if (tab === "artifacts") {
            const cards = page.locator(".cockpit-artifact-gallery > li");
            await expect(cards).toHaveCount(2);
            await expect(page.getByRole("link", { name: "Formal interface evidence", exact: true })).toHaveAttribute("href", new RegExp(artifact.id));
          }
          if (tab === "governance") {
            await expect(page.locator(".cockpit-review-card")).toHaveCount(2);
            if (width === 320) {
              const card = page.locator(".cockpit-review-card").first();
              const titleBox = await card.getByRole("heading", { level: 3 }).boundingBox();
              const cardBox = await card.boundingBox();
              expect(titleBox!.width).toBeGreaterThan(cardBox!.width * 0.55);
              expect(titleBox!.height).toBeLessThan(120);
            }
          }
          if (tab === "work") {
            await expect(page.locator(".cockpit-briefing-instrument")).toBeVisible();
            await expect(page.locator(".cockpit-orbit-segment")).not.toHaveCount(0);
          }
          if (tab === "plan") {
            const gantt = page.locator("[data-cockpit-gantt]");
            await expect(gantt).toBeVisible();
            const scroll = gantt.locator("[data-cockpit-scroll]");
            const row = scroll.locator("[data-cockpit-node]").first();
            await expect(row).toBeVisible();
            const viewport = await scroll.boundingBox();
            const tree = await row.boundingBox();
            expect(viewport).not.toBeNull();
            expect(tree).not.toBeNull();
            expect(viewport!.width - tree!.width).toBeGreaterThan(60);
            await expect(page.getByRole("navigation", { name: "Execution plan views", exact: true })).toBeVisible();
          }
          if (tab === "meetings") {
            await expect(page.getByRole("button", { name: "New meeting", exact: true })).toHaveCount(1);
            await expect(page.getByRole("button", { name: "Versions", exact: true })).toBeVisible();
            await expect(page.locator(".cockpit-agenda-card").first()).toBeVisible();
          }
          if (tab === "plan" && width === 320) {
            const gantt = page.locator("[data-cockpit-gantt]");
            const expand = gantt.getByRole("button", { name: /Expand.*Evidence preparation/ });
            if (await expand.count()) await expand.click();
            const row = gantt.locator(`[data-cockpit-node="${leaf.id}"]`).first();
            await row.getByRole("button", { name: "Name", exact: true }).click();
            const editor = row.getByRole("textbox", { name: "Name", exact: true });
            await expect(editor).toBeVisible();
            const rowBounds = await row.boundingBox();
            const editorBounds = await editor.boundingBox();
            expect(editorBounds!.y).toBeGreaterThanOrEqual(rowBounds!.y);
            expect(editorBounds!.y + editorBounds!.height).toBeLessThanOrEqual(rowBounds!.y + rowBounds!.height);
            await page.keyboard.press("Escape");
          }
          await page.screenshot({ path: testInfo.outputPath(`${tab}-${theme}-${width}.png`), animations: "disabled" });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
    await page.goto(`${cockpit}?tab=work&${scope}`, { waitUntil: "domcontentloaded" });
    await sections.getByRole("link", { name: "Execution plan", exact: true }).click();
    await expect(sections.locator('a[aria-current="page"]')).toHaveText(/Execution plan/);
    await expect(sections.locator(".cockpit-nav-active")).toHaveCount(1);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      for (const width of [1440, 320]) {
        await page.setViewportSize({ width, height: 960 });
        for (const view of ["table", "responsibility", "milestones", "finance", "operations"]) {
          await page.goto(`${cockpit}?tab=plan&plan_view=${view}&${scope}`, { waitUntil: "domcontentloaded" });
          await expect(page.getByRole("navigation", { name: "Execution plan views", exact: true }).locator('a[aria-current="page"]')).toHaveCount(1);
          if (view === "finance") {
            await expect(page.locator(".cockpit-ledger-totals")).toContainText("50.068608");
            for (const value of await page.locator(".cockpit-finance-value").all()) {
              expect(await value.evaluate((element) => element.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(element).lineHeight) + 1)).toBe(true);
            }
          }
          if (view === "milestones") await expect(page.getByRole("progressbar", { name: "Milestones", exact: true })).toHaveAttribute("value", "1");
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`plan-${view}-${theme}-${width}.png`), animations: "disabled" });
        }
        await page.goto(`${cockpit}?artifact=${artifact.id}&artifact_version=${artifact.current_version!.id}&${scope}`, { waitUntil: "domcontentloaded" });
        const reader = page.getByRole("region", { name: "Fixed version content", exact: true });
        await expect(reader.getByRole("heading", { name: "Formal interface evidence", exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`artifact-reader-${theme}-${width}.png`), animations: "disabled" });
        await reader.scrollIntoViewIfNeeded();
        await expect(reader.getByRole("button", { name: "Submit review", exact: true })).toBeEnabled();
        await page.goto(`${cockpit}?report=1&${scope}`, { waitUntil: "domcontentloaded" });
        await expect(page.locator(".cockpit-report-scorecard")).toBeVisible();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`report-${theme}-${width}.png`), animations: "disabled" });
        if (theme === "dark" && width === 1440) {
          await page.emulateMedia({ media: "print" });
          await expect(page.locator(".cockpit-report-meetings li").first()).toHaveCSS("background-color", "rgb(241, 243, 244)");
          await page.screenshot({ path: testInfo.outputPath("report-print-dark-source.png"), animations: "disabled" });
          await page.emulateMedia({ media: "screen" });
        }
      }
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.goto(`${cockpit}?${scope}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Work overview", exact: true })).toBeVisible();
    await expect(sections.getByRole("link").first()).toHaveAttribute("href", `${cockpit}?tab=chat&${scope}`);
    await page.goto(`${cockpit}?tab=meetings&${scope}`, { waitUntil: "domcontentloaded" });
    const views = page.getByRole("group", { name: "View", exact: true });
    for (const view of ["Month", "Week"]) {
      await views.getByRole("button", { name: view, exact: true }).click();
      await expect(page.locator(".cockpit-calendar")).toBeVisible();
      await page.getByRole("button", { name: "Today", exact: true }).click();
      await expect(page.locator(".cockpit-agenda-card")).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath(`meetings-${view.toLowerCase()}-light-1440.png`), animations: "disabled" });
    }
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`${cockpit}?tab=plan&${scope}`, { waitUntil: "domcontentloaded" });
    const chatLink = sections.getByRole("link", { name: "Chat", exact: true });
    await chatLink.focus();
    await page.keyboard.press("Tab");
    await expect(sections.getByRole("link", { name: "Overview", exact: true })).toBeFocused();
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(`${cockpit}?node=${leaf.id}&node_view=details&${scope}`, { waitUntil: "domcontentloaded" });
      const detailsTab = page.getByRole("tab", { name: "Plan details", exact: true });
      await expect(detailsTab).toHaveAttribute("aria-selected", "true");
      const tabs = page.getByRole("tablist").filter({ has: detailsTab }).getByRole("tab");
      const panel = await page.getByRole("tabpanel").first().boundingBox();
      expect(panel).not.toBeNull();
      for (const item of await tabs.all()) {
        await expect(item).toBeVisible();
        const bounds = await item.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(panel!.y + 1);
      }
      await expect(page.locator("[data-cockpit-gantt]")).toBeHidden();
      await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: title })).toBeHidden();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`node-workbench-${width}.png`), animations: "disabled" });
      await page.getByRole("button", { name: "Close panel", exact: true }).click();
      await expect.poll(() => new URL(page.url()).searchParams.get("node")).toBeNull();
      await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: title })).toBeVisible();
      expect(new URL(page.url()).searchParams.get("project")).toBe(project.id);
      expect(new URL(page.url()).searchParams.get("module")).toBe(module.id);
      await page.goto(`${cockpit}?meeting=${meeting.id}&${scope}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("tab", { name: "Preparation", exact: true })).toBeVisible();
      if (width === 1440) {
        const stage = await page.locator(".cockpit-meeting-stage-workspace").boundingBox();
        const facts = await page.locator(".cockpit-meeting-facts").boundingBox();
        expect(facts!.x).toBeGreaterThan(stage!.x + stage!.width);
        expect(await page.locator(".cockpit-meeting-fact-fields").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
      }
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`meeting-workbench-${width}.png`), animations: "disabled" });
      if (width !== 768) {
        for (const [stage, label] of [["preparation", "Preparation"], ["recording", "Meeting record"], ["minutes", "Minutes confirmation"]]) {
          const tab = page.getByRole("tab", { name: label, exact: true });
          await tab.click();
          await expect(tab).toHaveAttribute("aria-selected", "true");
          await expect(page.getByRole("tabpanel")).toBeVisible();
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
          await page.screenshot({ path: testInfo.outputPath(`meeting-${stage}-${width}.png`), animations: "disabled" });
        }
      }
    }
    const longTitle = "多团队协作与正式验收的长标题".repeat(30);
    const longNode = await api.createCockpitNode({ code: "UI.01.02", name: longTitle, parent_id: group.id, start_date: today, end_date: future });
    const longMeeting = await api.createCockpitMeeting({ title: longTitle, meet_date: today });
    await api.appendCockpitMeetingNode(longMeeting.id, longNode.id);
    await page.setViewportSize({ width: 320, height: 520 });
    for (const target of [`node=${longNode.id}&node_view=details`, `meeting=${longMeeting.id}`]) {
      await page.goto(`${cockpit}?${target}&${scope}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("tab", { name: target.startsWith("node=") ? "Plan details" : "Preparation", exact: true })).toBeVisible();
      const body = page.getByRole("tabpanel").first();
      await expect(body).toBeVisible();
      expect(await body.evaluate((element) => {
        let viewport: HTMLElement | null = element;
        while (viewport && getComputedStyle(viewport).overflowY !== "auto") viewport = viewport.parentElement;
        return viewport?.clientHeight ?? 0;
      })).toBeGreaterThan(100);
      const header = page.locator("aside > header").filter({ has: page.getByRole("button", { name: "Close panel", exact: true }) });
      expect(await header.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await header.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await expect(page.getByRole("button", { name: "Close panel", exact: true })).toBeInViewport();
      await page.screenshot({ path: testInfo.outputPath(target.startsWith("node=") ? "long-node-title.png" : "long-meeting-title.png"), animations: "disabled" });
    }
    await api.updateCockpitBoard({ title: longTitle });
    await page.goto(`${cockpit}?tab=work&${scope}`, { waitUntil: "domcontentloaded" });
    const longBoardTitle = page.getByRole("heading", { level: 1 }).filter({ hasText: longTitle });
    await expect(longBoardTitle).toBeVisible();
    expect((await longBoardTitle.boundingBox())!.height).toBeLessThanOrEqual(80);
    await expect(page.getByRole("heading", { name: "Work overview", exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("long-board-title.png"), animations: "disabled" });
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
    expect(pageErrors).toEqual([]);
  } finally {
    if (ownsWorkspace) await api.cleanupCreatedWorkspace();
  }
});
