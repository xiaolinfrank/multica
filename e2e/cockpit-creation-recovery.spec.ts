import { expect, test } from "@playwright/test";
import { TestApiClient } from "./fixtures";

test.use({ viewport: { width: 1600, height: 1100 }, locale: "en-US", timezoneId: "Asia/Shanghai", trace: "retain-on-failure" });

test("retries a committed meeting creation with the same key after its response is lost", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const api = new TestApiClient(); const run = `${Date.now().toString(36)}-${process.pid}`;
  await api.login(`e2e-create-retry-${run}@multica.ai`, "Creation recovery owner");
  let ownsWorkspace = false;
  try {
    const workspace = await api.createWorkspace(`Creation recovery ${run}`, `e2e-create-retry-${run}`); ownsWorkspace = true;
    await api.markUserOnboarded(); await api.updateCockpitBoard({ title: "Reliable meeting preparation" });
    const token = api.getToken(); if (!token) throw new Error("Fixture token missing");
    await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = "multica-locale=en; path=/"; }, token);
    const bodies: Record<string, unknown>[] = []; let savedId = "";
    await page.route("**/api/cockpit/meetings", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      bodies.push(route.request().postDataJSON());
      if (bodies.length === 1) {
        const response = await route.fetch(); expect(response.ok()).toBe(true);
        const result = await response.json(); savedId = result.id; expect(result.creation_key).toBe(bodies[0]!.creation_key);
        await route.abort("failed");
      } else await route.continue();
    });
    await page.goto(`/${workspace.slug}/cockpit?tab=meetings`, { waitUntil: "domcontentloaded" });
    const register = page.getByRole("region", { name: "Meetings", exact: true });
    await register.getByRole("button", { name: "New meeting", exact: true }).first().click();
    let dialog = page.getByRole("dialog", { name: "New meeting", exact: true });
    await dialog.getByRole("textbox", { name: "Subject", exact: true }).fill("Recovery decision meeting");
    await dialog.getByRole("button", { name: "Create meeting", exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    expect(bodies).toHaveLength(1); expect(String(bodies[0]!.creation_key)).toMatch(/^[0-9a-f-]{36}$/);
    expect((await api.getOwnedCockpitMeetingRegister()).total).toBe(1);
    await expect(dialog.getByRole("textbox", { name: "Subject", exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("meeting-creation-response-lost.png") });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await register.getByRole("button", { name: "New meeting", exact: true }).first().click();
    dialog = page.getByRole("dialog", { name: "New meeting", exact: true });
    await expect(dialog.getByRole("textbox", { name: "Subject", exact: true })).toHaveValue("Recovery decision meeting");
    const replay = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/cockpit/meetings");
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    const response = await replay; expect(response.ok()).toBe(true); expect(await response.json()).toMatchObject({ id: savedId, creation_key: bodies[0]!.creation_key, replayed: true });
    expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
    await expect(page).toHaveURL(new RegExp(`meeting=${savedId}`));
    expect((await api.getOwnedCockpitMeetingRegister()).total).toBe(1);
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } finally { if (ownsWorkspace) await api.cleanupCreatedWorkspace(); }
});

test("does not navigate back to a meeting when creation completes after returning to the overview", async ({ page }) => {
  test.setTimeout(120_000);
  const api = new TestApiClient(); const run = `${Date.now().toString(36)}-${process.pid}`;
  await api.login(`e2e-create-late-${run}@multica.ai`, "Late receipt owner");
  let ownsWorkspace = false; let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  try {
    const workspace = await api.createWorkspace(`Late receipt ${run}`, `e2e-create-late-${run}`); ownsWorkspace = true;
    await api.markUserOnboarded(); await api.updateCockpitBoard({ title: "Stable navigation during creation" });
    const token = api.getToken(); if (!token) throw new Error("Fixture token missing");
    await page.addInitScript((value) => { localStorage.setItem("multica_token", value); localStorage.setItem("multica:chat:isOpen", "false"); document.cookie = "multica-locale=en; path=/"; }, token);
    let committedId = ""; let delivered!: () => void;
    const acknowledged = new Promise<void>((resolve) => { delivered = resolve; });
    await page.route("**/api/cockpit/meetings", async (route) => {
      if (route.request().method() !== "POST") { await route.continue(); return; }
      const response = await route.fetch(); expect(response.ok()).toBe(true); committedId = (await response.json()).id;
      await held; await route.fulfill({ response }); delivered();
    });
    const home = `/${workspace.slug}/cockpit`;
    await page.goto(home, { waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "Cockpit sections", exact: true }).getByRole("link", { name: "Meetings", exact: true }).click();
    await page.getByRole("region", { name: "Meetings", exact: true }).getByRole("button", { name: "New meeting", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "New meeting", exact: true });
    await dialog.getByRole("textbox", { name: "Subject", exact: true }).fill("Completed after navigation");
    await dialog.getByRole("button", { name: "Create meeting", exact: true }).click();
    await expect.poll(() => committedId).not.toBe("");
    await page.goBack(); await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/cockpit$`));
    await expect(page.getByRole("region", { name: "Next actions", exact: true })).toBeVisible();
    const settledRead = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/cockpit/context");
    release(); await acknowledged;
    expect((await settledRead).ok()).toBe(true);
    await expect(page).toHaveURL(new RegExp(`/${workspace.slug}/cockpit$`));
    await expect(page.getByRole("dialog", { name: "New meeting", exact: true })).toHaveCount(0);
    expect((await api.getOwnedCockpitMeetingRegister()).total).toBe(1);
    expect(await api.getWorkspaceAgentRunCount()).toBe(0);
  } finally { release(); if (ownsWorkspace) await api.cleanupCreatedWorkspace(); }
});
