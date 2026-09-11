import { expect, type Page } from "@playwright/test";
import { TestApiClient } from "./fixtures";

const DEFAULT_E2E_NAME = "E2E User";
const E2E_WORKER = process.env.TEST_PARALLEL_INDEX ?? process.env.TEST_WORKER_INDEX ?? "0";
const E2E_RUN_ID = process.env.E2E_RUN_ID ?? `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const DEFAULT_E2E_EMAIL = `e2e-${E2E_WORKER}-${E2E_RUN_ID}@multica.ai`;
const DEFAULT_E2E_WORKSPACE = `e2e-workspace-${E2E_WORKER}-${E2E_RUN_ID}`;

async function waitForIssuesPage(page: Page) {
  await waitForPageText(page, "New Issue");
  await expect(page.getByRole("button", { name: "New Issue" })).toBeVisible({
    timeout: 15000,
  });
}

export async function waitForPageText(page: Page, text: string, timeout = 30000) {
  await page.waitForFunction(
    (expected) => document.body?.innerText.includes(expected),
    text,
    { timeout },
  );
}

export async function reloadAppPage(page: Page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForPageText(page, "Issues");
}

/**
 * Log in as the default E2E user and ensure the workspace exists first.
 * Authenticates via API (send-code → DB read → verify-code), then injects
 * the token into localStorage so the browser session is authenticated.
 *
 * Returns the E2E workspace slug so callers can build workspace-scoped URLs.
 */
export async function loginAsDefault(page: Page): Promise<string> {
  const api = new TestApiClient();
  await api.login(DEFAULT_E2E_EMAIL, DEFAULT_E2E_NAME);
  const workspace = await api.ensureWorkspace(
    `E2E Workspace ${E2E_WORKER}`,
    DEFAULT_E2E_WORKSPACE,
  );
  await api.markUserOnboarded();

  const token = api.getToken();
  if (!token) {
    throw new Error("E2E login did not return an auth token");
  }

  await page.addInitScript((t) => {
    localStorage.setItem("multica_token", t);
    localStorage.setItem("multica:chat:isOpen", "false");
  }, token);
  await page.goto(`/${workspace.slug}/issues`, { waitUntil: "domcontentloaded" });
  await waitForIssuesPage(page);
  return workspace.slug;
}

/**
 * Create a TestApiClient logged in as the default E2E user.
 * Call api.cleanup() in afterEach to remove test data created during the test.
 */
export async function createTestApi(): Promise<TestApiClient> {
  const api = new TestApiClient();
  await api.login(DEFAULT_E2E_EMAIL, DEFAULT_E2E_NAME);
  await api.ensureWorkspace(`E2E Workspace ${E2E_WORKER}`, DEFAULT_E2E_WORKSPACE);
  await api.markUserOnboarded();
  return api;
}

export async function preferManualCreateMode(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem(
      "multica_create_mode",
      JSON.stringify({ state: { lastMode: "manual" }, version: 0 }),
    );
  });
  await reloadAppPage(page);
  await waitForIssuesPage(page);
}

/**
 * Issue-surface view labels, in the order the toggle can be showing one.
 * The toggle button is named after the ACTIVE view, so a locator pinned to a
 * single label breaks whenever the default view changes.
 */
const ISSUE_VIEW_LABELS = ["Table", "Board", "List", "Swimlane", "Gantt"] as const;

export type IssueViewLabel = (typeof ISSUE_VIEW_LABELS)[number];

async function activeIssueView(page: Page) {
  for (const label of ISSUE_VIEW_LABELS) {
    // `.first()` keeps a same-named control elsewhere on the page from turning
    // a probe into a strict-mode failure.
    const trigger = page.getByRole("button", { name: label, exact: true }).first();
    if (await trigger.isVisible().catch(() => false)) return { trigger, label };
  }
  return null;
}

/** Put the issue surface on `label`, whatever view it currently shows. */
export async function switchToIssueView(page: Page, label: IssueViewLabel) {
  // `activeIssueView` probes without waiting, and `reloadAppPage` only waits
  // for the sidebar text — which paints before the surface header exists.
  // Poll until the toggle is actually there instead of throwing on a page
  // that is simply still rendering.
  await expect
    .poll(async () => (await activeIssueView(page))?.label ?? null, {
      timeout: 15000,
    })
    .not.toBeNull();
  const active = await activeIssueView(page);
  if (!active) throw new Error("issue view toggle not found");
  if (active.label === label) return;
  await active.trigger.click();
  const option = page.getByRole("menuitemradio", { name: label, exact: true });
  await option.click();
  await expect(
    page.getByRole("button", { name: label, exact: true }).first(),
  ).toBeVisible();
  await expect(option).toBeHidden();
}

export async function openWorkspaceMenu(page: Page) {
  // Click the workspace switcher button (has ChevronDown icon)
  const workspaceButton = page.getByRole("button", { name: /E2E Workspace/ }).first();
  await expect(workspaceButton).toBeVisible({ timeout: 15000 });
  await workspaceButton.click();
  // Wait for dropdown to appear
  await expect(page.locator('[class*="popover"]')).toBeVisible();
}
