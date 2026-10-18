import { expect, test } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1100 }, locale: "en-US", timezoneId: "Asia/Shanghai", trace: "retain-on-failure" });

test("compares stable plan identities in bounded pages and refreshes after a real concurrent edit", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const api = new TestApiClient(); const run = `${Date.now().toString(36)}-${process.pid}`;
  await api.login(`e2e-snapshot-diff-${run}@multica.ai`, "Snapshot comparison owner");
  let ownsWorkspace = false;
  try {
    const workspace = await api.createWorkspace(`Snapshot comparison ${run}`, `e2e-snapshot-${run}`); ownsWorkspace = true;
    await api.markUserOnboarded(); await api.updateCockpitBoard({ title: "Stable plan evidence" });
    const project = await api.createProject("Snapshot programme"), module = await api.createModule(project.id, "Evidence delivery");
    const root = await api.createCockpitNode({ code: "DIFF-P", name: project.title, project_id: project.id });
    const branch = await api.createCockpitNode({ code: "DIFF-M", name: module.title, parent_id: root.id, module_id: module.id });
    const nodes = [];
    for (let index = 0; index < 31; index++) nodes.push(await api.createCockpitNode({ code: `DIFF-${String(index).padStart(2, "0")}`, name: `Original execution ${String(index).padStart(2, "0")}`, parent_id: branch.id }));
    const snapshot = await api.saveOwnedCockpitSnapshot("Before reviewed plan edits"); expect(snapshot.node_count).toBe(33);
    for (let index = 0; index < 30; index++) await api.patchOwnedCockpitNode(nodes[index]!.id, { name: `Changed execution ${String(index).padStart(2, "0")}`, ...(index === 0 ? { code: "DIFF-RENAMED" } : {}) });
    await api.deleteOwnedCockpitNode(nodes[30]!.id);
    const added = [];
    for (let index = 0; index < 2; index++) added.push(await api.createCockpitNode({ code: `DIFF-NEW-${index}`, name: `New execution ${index}`, parent_id: branch.id }));

    const token = api.getToken(); if (!token) throw new Error("Fixture token missing");
    await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = "multica-locale=en; path=/"; }, token);
    const browserWrites: string[] = [], legacyReads: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/api/cockpit") && request.method() !== "GET") browserWrites.push(`${request.method()} ${path}`);
      if (request.method() === "GET" && (path === "/api/cockpit" || path === "/api/cockpit/snapshots")) legacyReads.push(path);
    });
    await page.goto(`/${workspace.slug}/cockpit?tab=governance&project=${project.id}&module=${module.id}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Versions", exact: true }).click();
    const snapshotRow = page.getByRole("listitem").filter({ hasText: snapshot.label });
    await expect(snapshotRow).toHaveCount(1);
    await expect(snapshotRow.getByRole("button", { name: "Restore", exact: true })).toBeDisabled();
    const endpoint = `/api/cockpit/snapshots/${snapshot.id}/diff`;
    const firstRead = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && !new URL(response.url()).searchParams.get("cursor"));
    await snapshotRow.getByRole("button", { name: "Compare with current plan", exact: true }).click();
    const firstResponse = await firstRead; expect(firstResponse.ok()).toBe(true);
    const first = await firstResponse.json();
    expect(first).toMatchObject({ workspace_id: workspace.id, snapshot_id: snapshot.id, scope: "workspace", comparable: true, snapshot_complete: true, current_complete: true, total: 33, page_size: 25, counts: { added: 2, removed: 1, modified: 30, unchanged: 3 } });
    expect(first.items).toHaveLength(25); expect(first.next_cursor).toEqual(expect.any(String));
    const dialog = page.getByRole("dialog", { name: "Compare plan snapshot", exact: true });
    await expect(dialog.getByText("Whole workspace, regardless of the current project filter. This view does not restore or approve a plan.", { exact: true })).toBeVisible();
    const secondRead = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && new URL(response.url()).searchParams.get("cursor") === first.next_cursor);
    await dialog.getByRole("button", { name: "Next page", exact: true }).click();
    const secondResponse = await secondRead; expect(secondResponse.ok()).toBe(true);
    const second = await secondResponse.json(); expect(second.items).toHaveLength(8); expect(second.next_cursor).toBeNull(); expect(second.comparison_token).toBe(first.comparison_token);
    const all = [...first.items, ...second.items]; expect(new Set(all.map((item: { id: string }) => item.id)).size).toBe(33);
    expect(all.find((item: { id: string }) => item.id === nodes[0]!.id)).toMatchObject({ change: "modified", code: "DIFF-RENAMED", name: "Changed execution 00", field_changes: expect.arrayContaining([{ field: "code", before: expect.objectContaining({ value: "DIFF-00" }), after: expect.objectContaining({ value: "DIFF-RENAMED" }) }, { field: "name", before: expect.objectContaining({ value: "Original execution 00" }), after: expect.objectContaining({ value: "Changed execution 00" }) }]) });
    expect(all.find((item: { id: string }) => item.id === nodes[30]!.id)).toMatchObject({ change: "removed", name: "Original execution 30", field_changes: [] });
    for (const node of added) expect(all.find((item: { id: string }) => item.id === node.id)).toMatchObject({ change: "added", field_changes: [] });
    await page.screenshot({ path: testInfo.outputPath("snapshot-comparison-second-page.png") });

    // Refresh page one after a first edit so the next cursor has not been cached.
    await dialog.getByRole("button", { name: "Previous page", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Compare again", exact: true })).toBeEnabled();
    await api.patchOwnedCockpitNode(nodes[0]!.id, { owner: "Peer update before comparison" });
    const refreshedFirst = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && !new URL(response.url()).searchParams.get("cursor") && response.ok());
    await dialog.getByRole("button", { name: "Compare again", exact: true }).click();
    const fresh = await (await refreshedFirst).json(); expect(fresh.comparison_token).not.toBe(first.comparison_token);
    await expect(dialog.getByRole("button", { name: "Next page", exact: true })).toBeEnabled();
    let changedDuringRead = false;
    await page.route((url) => url.pathname === endpoint, async (route) => {
      if (!changedDuringRead && new URL(route.request().url()).searchParams.get("cursor") === fresh.next_cursor) {
        changedDuringRead = true;
        await api.patchOwnedCockpitNode(nodes[0]!.id, { owner: "Peer update during continuation" });
      }
      await route.continue();
    });
    const staleRead = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && new URL(response.url()).searchParams.get("cursor") === fresh.next_cursor && response.status() === 409);
    await dialog.getByRole("button", { name: "Next page", exact: true }).click();
    expect((await staleRead).status()).toBe(409); expect(changedDuringRead).toBe(true);
    await expect(dialog.getByRole("alert")).toContainText("The comparison could not be loaded or the plan changed. Compare again to read the current plan.");
    await page.screenshot({ path: testInfo.outputPath("snapshot-comparison-stale-cursor.png") });
    const recoveredRead = page.waitForResponse((response) => new URL(response.url()).pathname === endpoint && !new URL(response.url()).searchParams.get("cursor") && response.ok());
    await dialog.getByRole("button", { name: "Compare again", exact: true }).click();
    const recovered = await (await recoveredRead).json(); expect(recovered.comparison_token).not.toBe(fresh.comparison_token); expect(recovered.total).toBe(33); expect(recovered.items).toHaveLength(25);
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Previous page", exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("snapshot-comparison-refreshed.png") });
    expect(await api.getOwnedCockpitNode(nodes[0]!.id)).toMatchObject({ id: nodes[0]!.id, code: "DIFF-RENAMED", name: "Changed execution 00", owner: "Peer update during continuation" });
    expect(browserWrites).toEqual([]); expect(legacyReads).toEqual([]); expect(await api.getWorkspaceAgentRunCount()).toBe(0);
    await testInfo.attach("snapshot-comparison-evidence", { body: JSON.stringify({ snapshot_id: snapshot.id, first_count: first.items.length, second_count: second.items.length, counts: first.counts, before_token: first.comparison_token, changed_token: fresh.comparison_token, recovered_token: recovered.comparison_token, browser_writes: browserWrites, legacy_reads: legacyReads }, null, 2), contentType: "application/json" });
  } finally { if (ownsWorkspace) await api.cleanupCreatedWorkspace(); }
});
