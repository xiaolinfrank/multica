import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type Response } from "@playwright/test";
import { TestApiClient, type TestMinutesMetadata, type TestWorkflowHistoryPage, type TestWorkflowSummary } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1100 }, locale: "en-US", timezoneId: "Asia/Shanghai",
  contextOptions: { reducedMotion: "reduce" }, screenshot: "only-on-failure", trace: "retain-on-failure" });

function versionContent(number: number) {
  return `# Minutes version ${number}\n\nHISTORY_BODY_${String(number).padStart(4, "0")}\n\n`
    + "This fixed record captures the agreed scope, evidence, responsible people and next review.\n".repeat(380).trimEnd();
}

function versionFeedback(number: number) {
  return `HISTORY_FEEDBACK_${String(number).padStart(4, "0")}\n` + "The fixed evidence and scope were checked. ".repeat(200);
}

function assertMetadataOnly(value: unknown) {
  const text = JSON.stringify(value);
  expect(text).not.toContain("HISTORY_BODY_");
  expect(text).not.toContain("HISTORY_FEEDBACK_");
  const visit = (entry: unknown) => {
    if (entry === null || typeof entry !== "object") return;
    expect(entry).not.toHaveProperty("content");
    expect(entry).not.toHaveProperty("feedback");
    for (const child of Object.values(entry)) visit(child);
  };
  visit(value);
}

function workflowRead(page: Page, meetingId: string, suffix: string, predicate: (query: URLSearchParams) => boolean = () => true) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "GET" && url.pathname === `/api/cockpit/meetings/${meetingId}/workflow${suffix}` && predicate(url.searchParams);
  });
}

async function historyResponse(response: Response) {
  expect(response.status()).toBe(200);
  const text = await response.text();
  const data = JSON.parse(text) as TestWorkflowHistoryPage<TestMinutesMetadata>;
  assertMetadataOnly(data);
  expect(Buffer.byteLength(text, "utf8")).toBeLessThan(80 * 1024);
  return data;
}

test("bounds long minutes history and keeps historical reading separate from current review and publication", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  const api = new TestApiClient();
  const run = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const auth = await api.login(`e2e-minutes-history-${run}@multica.ai`, "Minutes History Reviewer");
  let ownsWorkspace = false;
  try {
    const workspace = await api.createWorkspace(`Minutes History ${run}`, `e2e-history-${run}`);
    ownsWorkspace = true;
    await api.markUserOnboarded();
    const project = await api.createProject("Long-running programme evidence");
    const module = await api.createModule(project.id, "Minutes versions and decisions");
    await api.updateCockpitBoard({ title: "Programme delivery cockpit" });
    const meeting = await api.createCockpitMeeting({ title: "Long-running programme review", meet_date: "2026-10-10" });
    const bodies = new Map<number, string>();
    const keys = new Map<number, string>();
    const versions = new Map<number, string>();
    const payloads: Array<{ operation: string; version_number: number | null; response_bytes: number; history_count: number }> = [];
    const write = async (suffix: string, body: Record<string, unknown>, method: "POST" | "PATCH" = "POST") => {
      const response = await api.compactMeetingWorkflowCommand(meeting.id, suffix, body, method);
      expect(response.data).toMatchObject({ representation: "compact", workspace_id: workspace.id, meeting_id: meeting.id });
      expect(response.data.workflow.representation).toBe("summary");
      assertMetadataOnly(response.data.workflow);
      expect(response.data.workflow).not.toHaveProperty("versions");
      expect(response.data.workflow).not.toHaveProperty("reviewer_handoffs");
      expect(response.data.workflow).not.toHaveProperty("nas_exports");
      expect(response.bytes).toBeLessThan(80 * 1024);
      expect((response.text.match(/HISTORY_BODY_/g) ?? []).length).toBeLessThanOrEqual(1);
      expect((response.text.match(/HISTORY_FEEDBACK_/g) ?? []).length).toBeLessThanOrEqual(1);
      payloads.push({ operation: response.data.receipt.action, version_number: response.data.receipt.version?.version_number ?? null,
        response_bytes: response.bytes, history_count: response.data.workflow.history_counts.versions });
      return response.data;
    };
    const setupStarted = Date.now();
    let result = await write("", { reviewer_id: auth.user.id, project_id: project.id, module_id: module.id,
      assignee_type: "member", assignee_id: auth.user.id });
    result = await write("", { expected_revision: result.workflow.revision, ended: true, materials_ready: true }, "PATCH");
    result = await write("/release", { expected_revision: result.workflow.revision });
    for (let number = 1; number <= 35; number += 1) {
      const content = versionContent(number);
      expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(32 * 1024);
      bodies.set(number, content);
      keys.set(number, crypto.randomUUID());
      result = await write("/versions", { expected_revision: result.workflow.revision, submission_key: keys.get(number), content });
      expect(result.receipt.version).toMatchObject({ version_number: number, content, decision: "pending" });
      const id = result.receipt.version!.id;
      versions.set(number, id);
      if (number === 35) break;
      result = await write(`/versions/${id}/review`, { expected_revision: result.workflow.revision, decision: "approved", feedback: versionFeedback(number) });
      expect(result.receipt.version).toMatchObject({ id, decision: "approved" });
      result = await write(`/versions/${id}/publish`, { expected_revision: result.workflow.revision });
      expect(result.receipt.version?.id).toBe(id);
      expect(result.workflow.published_version_id).toBe(id);
    }
    const setupMilliseconds = Date.now() - setupStarted;
    expect(result.workflow).toMatchObject({ current_version_id: versions.get(35), published_version_id: versions.get(34),
      history_counts: { versions: 35 }, current_version: { decision: "pending", version_number: 35 }, published_version: { decision: "approved", version_number: 34 } });
    const firstPage = await api.getMeetingMinutesHistory(meeting.id);
    expect(firstPage.total).toBe(35);
    expect(firstPage.items.map((version) => version.version_number)).toEqual(Array.from({ length: 25 }, (_, index) => 35 - index));
    assertMetadataOnly(firstPage);
    const lastPage = await api.getMeetingMinutesHistory(meeting.id, { cursor: firstPage.next_cursor!, page_size: 25 });
    expect(lastPage.total).toBe(35);
    expect(lastPage.items.map((version) => version.version_number)).toEqual(Array.from({ length: 10 }, (_, index) => 10 - index));
    expect(lastPage.next_cursor).toBeNull();
    assertMetadataOnly(lastPage);
    const oldest = await api.getMeetingMinutesDetail(meeting.id, versions.get(1)!);
    expect(oldest.version.content).toBe(bodies.get(1));
    expect(oldest).toMatchObject({ can_review: false, can_publish: false, can_export_nas: true });
    const firstReplay = await write("/versions", { expected_revision: 1, submission_key: keys.get(1), content: bodies.get(1) });
    expect(firstReplay.receipt.version).toMatchObject({ id: versions.get(1), version_number: 1, content: bodies.get(1) });
    expect(firstReplay.workflow.revision).toBe(result.workflow.revision);
    expect(firstReplay.workflow).toMatchObject({ current_version_id: versions.get(35), published_version_id: versions.get(34), history_counts: { versions: 35 } });

    let cliNewlineReplay = false;
    if (process.env.MULTICA_E2E_CLI_BINARY) {
      const receipt = await api.replayMinutesWithCompactCLI(meeting.id, keys.get(1)!, bodies.get(1)!);
      expect(receipt).toMatchObject({ representation: "compact", receipt: { action: "submitted", version: { id: versions.get(1), content: bodies.get(1), content_hash: oldest.version.content_hash } },
        workflow: { current_version_id: versions.get(35), published_version_id: versions.get(34), history_counts: { versions: 35 } } });
      expect(receipt.workflow.revision).toBe(firstReplay.workflow.revision);
      cliNewlineReplay = true;
    }

    const token = api.getToken();
    if (!token) throw new Error("History fixture login returned no token");
    await page.addInitScript((value) => {
      localStorage.setItem("multica_token", value);
      localStorage.setItem("multica:chat:isOpen", "false");
      document.cookie = "multica-locale=en; path=/";
    }, token);
    const writes: string[] = [];
    const unboundedReads: string[] = [];
    const detailReads = new Set<string>();
    const listReads: string[] = [];
    const responseAudits: Array<Promise<{ path: string; bytes: number; has_body: boolean }>> = [];
    const cancelledReads: Array<{ path: string; error: string }> = [];
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname.startsWith(`/api/cockpit/meetings/${meeting.id}/workflow`)) {
        cancelledReads.push({ path: url.pathname, error: request.failure()?.errorText ?? "unknown" });
      }
    });
    page.on("requestfinished", (request) => {
      const url = new URL(request.url());
      const base = `/api/cockpit/meetings/${meeting.id}/workflow`;
      if (request.method() !== "GET" || !url.pathname.startsWith(base)) return;
      const tail = url.pathname.slice(base.length);
      if (!["/summary", "/versions", "/reviewer-handoffs", "/exports"].includes(tail) && !/^\/versions\/[a-f0-9-]+$/.test(tail)) return;
      const audit = (async () => {
        const response = await request.response();
        if (!response) throw new Error("Completed workflow request has no response");
        expect(response.status()).toBe(200);
        const text = await response.text();
        const body = JSON.parse(text) as unknown;
        const hasBody = /^\/versions\/[a-f0-9-]+$/.test(tail);
        if (!hasBody) assertMetadataOnly(body);
        const bytes = Buffer.byteLength(text, "utf8");
        expect(bytes).toBeLessThan(tail === "/summary" ? 16 * 1024 : 80 * 1024);
        return { path: url.pathname, bytes, has_body: hasBody };
      })();
      responseAudits.push(audit);
      // The joined audit below reports failures without an unhandled event callback rejection.
      void audit.catch(() => {});
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith(`/api/cockpit/meetings/${meeting.id}/workflow`)) return;
      if (!["GET", "HEAD"].includes(request.method())) writes.push(`${request.method()} ${url.pathname}`);
      if (request.method() === "GET" && url.pathname === `/api/cockpit/meetings/${meeting.id}/workflow`) unboundedReads.push(url.pathname);
      if (request.method() === "GET" && url.pathname.endsWith("/workflow/versions")) listReads.push(url.pathname);
      const detail = url.pathname.match(/\/versions\/([a-f0-9-]+)$/);
      if (request.method() === "GET" && detail) detailReads.add(detail[1]!);
    });
    const summaryRead = workflowRead(page, meeting.id, "/summary");
    await page.goto(`/${workspace.slug}/cockpit?meeting=${meeting.id}`, { waitUntil: "domcontentloaded" });
    const summary = await (await summaryRead).json() as TestWorkflowSummary;
    assertMetadataOnly(summary);
    expect(summary.history_counts.versions).toBe(35);

    await expect(page.getByRole("button", { name: "Read current minutes", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Read published minutes", exact: true })).toBeVisible();
    expect(detailReads.size).toBe(0);
    expect(listReads).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("minutes-current-and-published.png"), animations: "disabled" });
    const reviewDraft = "Compare the scope with the earlier evidence before confirming this review.";
    await test.step("load only a requested current or official document", async () => {
      const currentRead = workflowRead(page, meeting.id, `/versions/${versions.get(35)}`);
      await page.getByRole("button", { name: "Read current minutes", exact: true }).click();
      expect((await currentRead).status()).toBe(200);
      const current = page.getByRole("dialog", { name: "Minutes version 35", exact: true });
      await expect(current.getByText("HISTORY_BODY_0035", { exact: true })).toBeVisible();
      await current.getByLabel("Review feedback", { exact: true }).fill(reviewDraft);
      await page.keyboard.press("Escape");
      await expect(current).not.toBeVisible();
      const officialRead = workflowRead(page, meeting.id, `/versions/${versions.get(34)}`);
      await page.getByRole("button", { name: "Read published minutes", exact: true }).click();
      expect((await officialRead).status()).toBe(200);
      const official = page.getByRole("dialog", { name: "Minutes version 34", exact: true });
      await expect(official.getByText("HISTORY_BODY_0034", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(official).not.toBeVisible();
      expect([...detailReads].sort()).toEqual([versions.get(34), versions.get(35)].sort());
    });
    const history = page.getByRole("region", { name: "Minutes history", exact: true });
    await test.step("page metadata without retrieving the other thirty-three bodies", async () => {
      const read = workflowRead(page, meeting.id, "/versions", (query) => !query.get("cursor"));
      await page.getByRole("button", { name: "Version history (35)", exact: true }).click();
      const first = await historyResponse(await read);
      expect(first.items).toHaveLength(25);
      expect(first.total).toBe(35);
      await expect(history.getByRole("button", { name: /^Read version / })).toHaveCount(25);
      const next = workflowRead(page, meeting.id, "/versions", (query) => query.get("cursor") === first.next_cursor);
      await history.getByRole("button", { name: "Next page", exact: true }).click();
      const second = await historyResponse(await next);
      expect(second.items).toHaveLength(10);
      expect(second.total).toBe(35);
      await expect(history.getByRole("button", { name: /^Read version / })).toHaveCount(10);
      expect(detailReads.size).toBe(2);
      await page.screenshot({ path: testInfo.outputPath("minutes-history-page-two.png"), animations: "disabled" });
    });
    await test.step("keep the old document fixed while the live current version advances", async () => {
      const oldRead = workflowRead(page, meeting.id, `/versions/${versions.get(1)}`);
      await history.getByRole("button", { name: "Read version 1", exact: true }).click();
      expect((await oldRead).status()).toBe(200);
      const reader = page.getByRole("dialog", { name: "Minutes version 1", exact: true });
      await expect(reader.getByText("HISTORY_BODY_0001", { exact: true })).toBeVisible();
      await expect(reader.getByRole("button", { name: "Publish version", exact: true })).toHaveCount(0);
      await expect(reader.getByRole("button", { name: "Submit review", exact: true })).toHaveCount(0);
      await expect(reader.getByLabel("Review decision", { exact: true })).toHaveCount(0);
      expect(writes).toEqual([]);
      const live = await api.getMeetingWorkflowSummary(meeting.id);
      result = await write(`/versions/${versions.get(35)}/review`, { expected_revision: live.revision, decision: "approved", feedback: versionFeedback(35) });
      const content = versionContent(36);
      result = await write("/versions", { expected_revision: result.workflow.revision, submission_key: crypto.randomUUID(), content });
      versions.set(36, result.receipt.version!.id);
      expect(result.workflow).toMatchObject({ current_version_id: versions.get(36), published_version_id: versions.get(34), history_counts: { versions: 36 } });
      await expect(reader).toBeVisible();
      await expect(reader.getByText("HISTORY_BODY_0001", { exact: true })).toBeVisible();
      await expect(reader.getByText("HISTORY_BODY_0036", { exact: true })).toHaveCount(0);
      await expect(reader.getByText("You are reading an earlier version. The current working version is v36.", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("minutes-historical-reader.png"), animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(reader).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Version history (36)", exact: true })).toBeVisible();
      await expect(history.getByRole("button", { name: "Read version 1", exact: true })).toBeVisible();
      expect(detailReads.has(versions.get(36)!)).toBe(false);
      const newRead = workflowRead(page, meeting.id, `/versions/${versions.get(36)}`);
      await page.getByRole("button", { name: "Read current minutes", exact: true }).click();
      expect((await newRead).status()).toBe(200);
      const current = page.getByRole("dialog", { name: "Minutes version 36", exact: true });
      await expect(current.getByText("HISTORY_BODY_0036", { exact: true })).toBeVisible();
      await expect(current.getByLabel("Review feedback", { exact: true })).toHaveValue("");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Read published minutes", exact: true }).click();
      const official = page.getByRole("dialog", { name: "Minutes version 34", exact: true });
      await expect(official.getByText("HISTORY_BODY_0034", { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await history.getByRole("button", { name: "Previous page", exact: true }).click();
      await expect(history.getByRole("button", { name: "Read version 36", exact: true })).toBeVisible();
      await history.getByRole("button", { name: "Read version 35", exact: true }).click();
      const retiredReader = page.getByRole("dialog", { name: "Minutes version 35", exact: true });
      const recoveredDraft = retiredReader.getByRole("textbox", { name: "Review draft (read-only)", exact: true });
      await expect(recoveredDraft).toHaveValue(reviewDraft);
      await expect(recoveredDraft).toHaveJSProperty("readOnly", true);
      await expect(retiredReader.getByRole("button", { name: "Submit review", exact: true })).toHaveCount(0);
      await recoveredDraft.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath("minutes-review-draft-preserved.png"), animations: "disabled" });
      await page.keyboard.press("Escape");
      expect(detailReads.size).toBe(4);
    });
    const readAudit = await Promise.all(responseAudits);
    expect((await api.getMeetingMinutesDetail(meeting.id, versions.get(1)!)).version).toMatchObject({
      content: oldest.version.content, content_hash: oldest.version.content_hash, decision: oldest.version.decision,
    });
    expect(writes).toEqual([]);
    expect(unboundedReads).toEqual([]);
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
    await writeFile(testInfo.outputPath("minutes-history-validation.json"), JSON.stringify({ setup_milliseconds: setupMilliseconds,
      workspace_id: workspace.id, meeting_id: meeting.id, initial_versions: 35, cli_newline_replay: cliNewlineReplay, current_version: versions.get(35), published_version: versions.get(34),
      body_bytes: Buffer.byteLength(bodies.get(1)!, "utf8"), compact_responses: payloads, unique_bodies_requested_by_browser: [...detailReads], final_versions: 36, response_audit: readAudit, cancelled_reads: cancelledReads }, null, 2));
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath("failure-before-cleanup.png"), animations: "disabled" }).catch(() => {});
    await writeFile(testInfo.outputPath("failure-before-cleanup.txt"), await page.locator("body").innerText()).catch(() => {});
    throw error;
  } finally {
    if (ownsWorkspace) await api.cleanupCreatedWorkspace();
  }
});
