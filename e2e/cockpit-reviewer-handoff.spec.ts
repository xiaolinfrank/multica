import { expect, test } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1050 }, locale: "en-US", timezoneId: "Asia/Shanghai", contextOptions: { reducedMotion: "reduce" },
  screenshot: "only-on-failure", trace: "retain-on-failure" });

test("transfers a departed reviewer's pending responsibility without replacing the minutes", async ({ page, browser }, testInfo) => {
  test.setTimeout(150_000);
  const run = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const owner = new TestApiClient();
  const former = new TestApiClient();
  const next = new TestApiClient();
  const ownerAuth = await owner.login(`e2e-handoff-owner-${run}@multica.ai`, "Handover Manager");
  const formerEmail = `e2e-handoff-former-${run}@multica.ai`;
  const nextEmail = `e2e-handoff-next-${run}@multica.ai`;
  const formerAuth = await former.login(formerEmail, "Former Reviewer");
  const nextAuth = await next.login(nextEmail, "New Reviewer");
  let ownsWorkspace = false;
  let reviewerContextClosed = false;
  const reviewerContext = await browser.newContext({ viewport: { width: 1280, height: 960 }, locale: "en-US", reducedMotion: "reduce" });
  try {
    const workspace = await owner.createWorkspace(`Reviewer Handover ${run}`, `e2e-handoff-${run}`);
    ownsWorkspace = true;
    await owner.markUserOnboarded();
    await next.markUserOnboarded();
    const formerMemberId = await owner.addMemberByEmail(formerEmail);
    await owner.addMemberByEmail(nextEmail);
    next.setWorkspaceId(workspace.id);
    next.setWorkspaceSlug(workspace.slug);
    const meeting = await owner.createCockpitMeeting({ title: "Handover evidence review", meet_date: new Date().toISOString().slice(0, 10) });
    const content = "# Fixed acceptance evidence\n\nThe scope excludes historical backfill.\n\n- Preserve the original content.\n- Record reviewer responsibility separately.";
    const initial = await owner.seedPendingMeetingReview(meeting.id, formerAuth.user.id, content);
    const original = initial.versions[0]!;
    await owner.removeMember(formerMemberId);
    const token = owner.getToken();
    const reviewerToken = next.getToken();
    if (!token || !reviewerToken) throw new Error("Handover fixture login returned no token");
    const setSession = (value: string) => {
      localStorage.setItem("multica_token", value);
      localStorage.setItem("multica:chat:isOpen", "false");
      document.cookie = "multica-locale=en; path=/";
    };
    await page.addInitScript(setSession, token);
    const destination = `/${workspace.slug}/cockpit?meeting=${meeting.id}`;
    const initialRead = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/cockpit/meetings/${meeting.id}/workflow/summary` && response.request().method() === "GET");
    await page.goto(destination, { waitUntil: "domcontentloaded" });
    const initialResponse = await initialRead;
    expect(initialResponse.status()).toBe(200);
    expect(await initialResponse.json()).toMatchObject({ meeting_id: meeting.id, can_reassign_reviewer: true });
    await expect(page.getByRole("button", { name: "Transfer review responsibility", exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Transfer review responsibility", exact: true }).first().click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("New reviewer", { exact: true }).click();
    await page.getByRole("option", { name: "New Reviewer", exact: true }).click();
    const reason = "The original reviewer left; the quality reviewer now owns acceptance.";
    await dialog.getByLabel("Reason for transfer", { exact: true }).fill(reason);
    await page.screenshot({ path: testInfo.outputPath("reviewer-transfer-confirmation.png"), animations: "disabled" });
    const transferred = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith(`/meetings/${meeting.id}/workflow/reviewer`) && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Confirm transfer", exact: true }).click();
    expect((await transferred).status()).toBe(200);
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: "Version history (1)", exact: true }).click();
    const history = page.getByRole("region", { name: "Minutes history", exact: true });
    const historyRead = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/cockpit/meetings/${meeting.id}/workflow/reviewer-handoffs` && response.request().method() === "GET");
    await history.getByRole("tab", { name: "Reviewer changes", exact: true }).click();
    expect((await historyRead).status()).toBe(200);
    await expect(history.getByText(reason, { exact: true }).first()).toBeVisible();
    const handed = await owner.getMeetingWorkflow(meeting.id);
    expect(handed.versions).toHaveLength(1);
    expect(handed.reviewer_handoffs).toHaveLength(1);
    expect(handed.versions[0]).toMatchObject({ id: original.id, version_number: original.version_number, content, content_hash: original.content_hash,
      submission_key: original.submission_key, decision: "pending", reviewer_id: nextAuth.user.id });
    expect(handed.reviewer_handoffs[0]).toMatchObject({ version_id: original.id, from_reviewer_id: formerAuth.user.id,
      to_reviewer_id: nextAuth.user.id, created_by: ownerAuth.user.id, reason,
      from_reviewer_name: "Former Reviewer", to_reviewer_name: "New Reviewer", created_by_name: "Handover Manager",
      from_review_issue: { id: original.review_issue.id, status: "cancelled" }, to_review_issue: { id: handed.versions[0]!.review_issue.id, assignee_id: nextAuth.user.id } });
    expect(handed.versions[0]!.review_issue.id).not.toBe(original.review_issue.id);
    await history.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("reviewer-transfer-history.png"), animations: "disabled" });

    await reviewerContext.addInitScript(setSession, reviewerToken);
    const reviewerPage = await reviewerContext.newPage();
    const reviewRead = reviewerPage.waitForResponse((response) => new URL(response.url()).pathname === `/api/cockpit/meetings/${meeting.id}/workflow/summary` && response.request().method() === "GET");
    await reviewerPage.goto(new URL(destination, page.url()).href, { waitUntil: "domcontentloaded" });
    expect((await reviewRead).status()).toBe(200);
    await reviewerPage.getByRole("button", { name: "Read current minutes", exact: true }).click();
    await expect(reviewerPage.getByLabel("Review decision", { exact: true })).toBeVisible();
    await expect(reviewerPage.getByRole("button", { name: "Transfer review responsibility", exact: true })).toHaveCount(0);
    await reviewerPage.getByLabel("Review feedback", { exact: true }).fill("I reviewed the fixed evidence after handover.");
    await reviewerPage.getByRole("button", { name: "Submit review", exact: true }).click();
    await expect(reviewerPage.getByText("Approved", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish version", exact: true })).toBeEnabled();
    await reviewerContext.close();
    reviewerContextClosed = true;
    await page.getByRole("button", { name: "Publish version", exact: true }).click();
    await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
    const loaded = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame())
      .then(() => page.waitForResponse((response) => new URL(response.url()).pathname === `/api/cockpit/meetings/${meeting.id}/workflow/summary` && response.request().method() === "GET"));
    await page.reload({ waitUntil: "domcontentloaded" });
    expect((await loaded).status()).toBe(200);
    await expect(page.getByText("Published", { exact: true }).first()).toBeVisible();
    const published = await owner.getMeetingWorkflow(meeting.id);
    expect(published.published_version_id).toBe(original.id);
    expect(published.versions[0]).toMatchObject({ content_hash: original.content_hash, reviewed_by: nextAuth.user.id, decision: "approved" });
    await page.setViewportSize({ width: 1100, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("reviewer-transfer-published.png"), animations: "disabled" });
  } finally {
    if (!reviewerContextClosed) await reviewerContext.close();
    if (ownsWorkspace) await owner.cleanupCreatedWorkspace();
  }
});
