import { expect, test } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({
  viewport: { width: 1600, height: 1050 },
  locale: "en-US",
  timezoneId: "Asia/Shanghai",
  contextOptions: { reducedMotion: "reduce" },
  screenshot: "only-on-failure",
  trace: "retain-on-failure",
});

test("requires readiness and a human decision before publishing a fixed minutes version", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const api = new TestApiClient();
  const run = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const ownerName = "Meeting Workflow Reviewer";
  const auth = await api.login(`e2e-meeting-workflow-${run}@multica.ai`, ownerName);
  let ownsWorkspace = false;

  try {
    const workspace = await api.createWorkspace(`Meeting Workflow E2E ${run}`, `e2e-meeting-workflow-${run}`);
    ownsWorkspace = true;
    await api.markUserOnboarded();
    await api.updateCockpitBoard({ title: "Programme delivery cockpit" });
    const project = await api.createProject("Meeting workflow project");
    const module = await api.createModule(project.id, "Minutes and review");
    const meeting = await api.createCockpitMeeting({
      title: "Evidence and acceptance review",
      meet_date: new Date().toISOString().slice(0, 10),
    });
    expect((await api.getMeetingWorkflow(meeting.id)).enabled).toBe(false);

    const token = api.getToken();
    if (!token) throw new Error("Meeting workflow E2E login returned no token");
    await page.addInitScript((value) => {
      localStorage.setItem("multica_token", value);
      localStorage.setItem("multica:chat:isOpen", "false");
      document.cookie = "multica-locale=en; path=/";
    }, token);
    const destination = `/${workspace.slug}/cockpit?meeting=${meeting.id}`;
    const expectMaterialsUnconfirmed = () => expect(page.getByRole("region", { name: "Readiness & execution", exact: true })
      .getByText("Confirm the required input materials are ready. A folder alone does not indicate readiness.", { exact: true })).toBeVisible();
    const publishedBadge = () => page.getByRole("region", { name: "Current minutes version", exact: true })
      .getByText("Published", { exact: true }).first();
    const reloadWithWorkflowRead = async () => {
      // Wait for the new document's workflow read, not merely its HTML.
      // The visual assertions still use their normal timeout after hydration.
      const loaded = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame())
        .then(() => page.waitForResponse((response) =>
          new URL(response.url()).pathname === `/api/cockpit/meetings/${meeting.id}/workflow/summary`
          && response.request().method() === "GET",
        ));
      await page.reload({ waitUntil: "domcontentloaded" });
      const response = await loaded;
      expect(response.status()).toBe(200);
      expect((await response.json()).meeting_id).toBe(meeting.id);
    };
    await page.goto(`${destination}&meeting_view=workflow`, { waitUntil: "domcontentloaded" });

    await test.step("enable one member-owned work package and show its waiting conditions", async () => {
      await page.getByLabel("Project", { exact: true }).click();
      await page.getByRole("button", { name: project.title, exact: true }).click();
      await page.getByLabel("Module", { exact: true }).click();
      await page.getByRole("button", { name: module.title, exact: true }).click();
      await page.getByLabel("Reviewer", { exact: true }).click();
      const reviewerPicker = page.getByRole("dialog").filter({ has: page.getByRole("textbox", { name: "Search workspace members", exact: true }) });
      await reviewerPicker.getByRole("button", { name: ownerName, exact: true }).click();
      await page.getByRole("button", { name: "Enable work package", exact: true }).click();
      await expect(page.getByRole("link", { name: "Agenda & preparation", exact: true })).toBeVisible();
      await expectMaterialsUnconfirmed();
      await expect(page.getByRole("button", { name: `Delete meeting ${meeting.title}`, exact: true })).toBeDisabled();

      const workflow = await api.getMeetingWorkflow(meeting.id);
      expect(workflow).toMatchObject({
        enabled: true,
        ended_at: null,
        materials_ready: false,
        released_at: null,
        release_task_id: null,
        reviewer_id: auth.user.id,
        minutes_issue: { status: "backlog", assignee_type: "member", assignee_id: auth.user.id },
        versions: [],
      });
      await page.screenshot({ path: testInfo.outputPath("work-package-waiting.png"), animations: "disabled" });
    });

    await test.step("prepare materials through their real destinations before confirming readiness", async () => {
      const prepare = page.getByRole("link", { name: "Prepare meeting materials", exact: true });
      const resourcesPath = `${destination}&meeting_view=resources`;
      const workflowPath = `${destination}&meeting_view=workflow`;
      const writes: string[] = [];
      const watchWrites = (request: import("@playwright/test").Request) => {
        const path = new URL(request.url()).pathname;
        if (request.method() !== "GET" && (path.startsWith(`/api/cockpit/meetings/${meeting.id}/workflow`)
          || path.startsWith(`/api/cockpit/meetings/${meeting.id}/lifecycle`))) {
          writes.push(`${request.method()} ${path}`);
        }
      };
      page.on("request", watchWrites);
      await expect(prepare).toHaveAttribute("href", resourcesPath);
      await prepare.click();
      await expect(page).toHaveURL(resourcesPath);
      const materials = page.getByRole("region", { name: "Meeting materials", exact: true });
      const notes = materials.getByRole("textbox", { name: "Meeting notes", exact: true });
      await expect(materials).toBeVisible();
      const note = "Evidence prepared: delivery checklist and boundary questions for the human review.";
      await notes.fill(note);
      await materials.getByRole("link", { name: "Return to workflow", exact: true }).click();
      await expect(page).toHaveURL(workflowPath);
      await expectMaterialsUnconfirmed();
      await prepare.click();
      await expect(notes).toHaveValue(note);

      const workflow = await api.getMeetingWorkflow(meeting.id);
      const issue = workflow.minutes_issue!;
      const issueLink = materials.getByRole("link", { name: "Open minutes issue to add notes or attachments (new tab)", exact: true });
      await expect(issueLink).toHaveAttribute("href", `/${workspace.slug}/issues/${issue.id}`);
      await expect(issueLink).toHaveAttribute("target", "_blank");
      const popupReady = page.waitForEvent("popup");
      await issueLink.click();
      const issuePage = await popupReady;
      await expect(issuePage).toHaveURL(`/${workspace.slug}/issues/${encodeURIComponent(issue.identifier)}`);
      await expect(issuePage.getByText(issue.title, { exact: true }).first()).toBeVisible();
      await expect(issuePage.getByText("Properties", { exact: true })).toBeVisible();
      await issuePage.close();
      await expect(notes).toHaveValue(note);
      expect(writes).toEqual([]);

      const saved = page.waitForResponse((response) => response.request().method() === "PATCH"
        && new URL(response.url()).pathname === `/api/cockpit/meetings/${meeting.id}`
        && response.request().postDataJSON()?.note === note);
      await materials.getByRole("button", { name: "Save meeting notes", exact: true }).click();
      expect((await saved).status()).toBe(200);
      await expect(materials.getByRole("button", { name: "Save meeting notes", exact: true })).toBeDisabled();
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(resourcesPath);
      await expect(notes).toHaveValue(note);
      await page.screenshot({ path: testInfo.outputPath("meeting-materials-prepared.png"), animations: "disabled" });
      await page.setViewportSize({ width: 1100, height: 900 });
      await expect(issueLink).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("meeting-materials-narrow.png"), animations: "disabled" });
      await page.setViewportSize({ width: 1600, height: 1050 });
      await materials.getByRole("link", { name: "Return to workflow", exact: true }).click();
      await expect(page).toHaveURL(workflowPath);
      await expectMaterialsUnconfirmed();
      expect(await api.getMeetingWorkflow(meeting.id)).toMatchObject({ materials_ready: false, released_at: null,
        minutes_issue: { status: "backlog" } });
      expect(writes).toEqual([]);
      expect(await api.getWorkspaceAgentRunCount()).toBe(0);
      page.off("request", watchWrites);
    });

    await test.step("record both facts, then explicitly release the member task", async () => {
      await page.getByRole("link", { name: "Agenda & preparation", exact: true }).click();
      await expect(page).toHaveURL(`${destination}&meeting_view=agenda`);
      await page.getByRole("button", { name: "Confirm meeting ended", exact: true }).click();
      const ending = page.getByRole("dialog", { name: "Confirm meeting ended", exact: true });
      const endSaved = page.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/cockpit/meetings/${meeting.id}/lifecycle/occurrence`
        && response.request().postDataJSON()?.transition === "end");
      await ending.getByRole("button", { name: "Confirm", exact: true }).click();
      expect((await endSaved).status()).toBe(200);
      await expect(ending).not.toBeVisible();
      await expect.poll(async () => Boolean((await api.getMeetingWorkflow(meeting.id)).ended_at)).toBe(true);
      expect((await api.getMeetingWorkflow(meeting.id)).released_at).toBeNull();

      const materials = page.getByRole("checkbox", { name: "I have checked the minutes inputs", exact: true });
      await expect(materials).not.toBeChecked();
      const readinessSaved = page.waitForResponse((response) =>
        new URL(response.url()).pathname === `/api/cockpit/meetings/${meeting.id}/lifecycle/materials`
        && response.request().method() === "POST"
        && response.request().postDataJSON()?.materials_ready === true,
      );
      // Readiness is a server-confirmed fact, so the controlled checkbox
      // deliberately stays unchanged until the request is acknowledged.
      await materials.click();
      expect((await readinessSaved).status()).toBe(200);
      await expect(materials).toBeChecked();
      await page.getByRole("link", { name: "Open minutes workflow", exact: true }).click();
      await expect(page).toHaveURL(`${destination}&meeting_view=workflow`);
      const start = page.getByRole("button", { name: "Start minutes issue", exact: true });
      await expect(start).toBeEnabled();
      const ready = await api.getMeetingWorkflow(meeting.id);
      expect(ready.materials_ready).toBe(true);
      expect(ready.released_at).toBeNull();
      expect(ready.minutes_issue?.status).toBe("backlog");

      await start.click();
      await expect(page.getByLabel("Minutes draft", { exact: true })).toBeVisible();
      const released = await api.getMeetingWorkflow(meeting.id);
      expect(released.released_at).not.toBeNull();
      expect(released.release_task_id).toBeNull();
      expect(released.minutes_issue?.status).toBe("todo");
    });

    const content = "# Meeting minutes\n\nThe team agreed to validate the delivery evidence before accepting the milestone.\n\nOwner: Meeting Workflow Reviewer.";
    await test.step("submit an immutable text version for the named human reviewer", async () => {
      await page.getByLabel("Minutes draft", { exact: true }).fill(content);
      await page.getByRole("button", { name: "Submit for review", exact: true }).click();
      await expect(page.getByText("Pending review", { exact: true }).first()).toBeVisible();

      const submitted = await api.getMeetingWorkflow(meeting.id);
      expect(submitted.versions).toHaveLength(1);
      expect(submitted.versions[0]).toMatchObject({
        version_number: 1,
        content,
        source_issue_id: submitted.minutes_issue?.id,
        reviewer_id: auth.user.id,
        decision: "pending",
        review_issue: { assignee_type: "member", assignee_id: auth.user.id },
      });
      expect(submitted.versions[0]?.review_issue.id).not.toBe(submitted.minutes_issue?.id);
      expect(submitted.published_version_id).toBeNull();
    });

    await test.step("marking the review issue done does not approve or publish its version", async () => {
      const submitted = await api.getMeetingWorkflow(meeting.id);
      const reviewIssue = submitted.versions[0]!.review_issue;
      await api.updateIssue(reviewIssue.id, { status: "done", suppress_run: true });
      await reloadWithWorkflowRead();
      await expect(page.getByText("Pending review", { exact: true }).first()).toBeVisible();

      const pending = await api.getMeetingWorkflow(meeting.id);
      expect(pending.versions).toHaveLength(1);
      expect(pending.versions[0]).toMatchObject({ decision: "pending", reviewed_at: null, review_issue: { status: "done" } });
      expect(pending.published_version_id).toBeNull();
      expect(pending.can_review).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("review-done-still-pending.png"), animations: "disabled" });
    });

    await test.step("approve as the bound reviewer, then explicitly publish and retain the version", async () => {
      await page.getByRole("button", { name: "Read and review minutes", exact: true }).click();
      await page.getByLabel("Review decision", { exact: true }).click();
      await page.getByRole("option", { name: "Approve", exact: true }).click();
      await page.getByLabel("Review feedback", { exact: true }).fill("Checked the recorded decision against the meeting evidence.");
      await page.getByRole("button", { name: "Submit review", exact: true }).click();
      await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

      const approved = await api.getMeetingWorkflow(meeting.id);
      const version = approved.versions[0]!;
      expect(version).toMatchObject({ decision: "approved", reviewed_by: auth.user.id, content });
      expect(approved.published_version_id).toBeNull();

      await page.getByRole("button", { name: "Publish version", exact: true }).click();
      await expect(publishedBadge()).toBeVisible();
      await reloadWithWorkflowRead();
      await expect(publishedBadge()).toBeVisible();
      const published = await api.getMeetingWorkflow(meeting.id);
      expect(published.current_version_id).toBe(version.id);
      expect(published.published_version_id).toBe(version.id);
      expect(published.versions).toHaveLength(1);
      expect(published.versions[0]).toMatchObject({
        id: version.id,
        content,
        content_hash: version.content_hash,
        decision: "approved",
        published_by: auth.user.id,
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("minutes-version-published.png"), animations: "disabled" });
    });

    await test.step("keep the published workbench usable on a narrower window", async () => {
      await page.setViewportSize({ width: 1100, height: 900 });
      await expect(publishedBadge()).toBeVisible();
      await expect(page.getByRole("button", { name: `Delete meeting ${meeting.title}`, exact: true })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("minutes-workbench-narrow.png"), animations: "disabled" });
    });
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath("failure-before-cleanup.png"), animations: "disabled", timeout: 2_000 }).catch(() => {});
    const body = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => null);
    if (body !== null) await testInfo.attach("failure-before-cleanup", { body, contentType: "text/plain" }).catch(() => {});
    throw error;
  } finally {
    if (ownsWorkspace) await api.cleanupCreatedWorkspace();
  }
});
