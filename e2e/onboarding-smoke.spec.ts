import { test, expect } from "@playwright/test";
import { TestApiClient } from "./fixtures";
import { waitForPageText } from "./helpers";

// Smoke test for the onboarding flow: welcome → About you (role +
// use case on ONE screen) → workspace → runtime. The source question
// is intentionally absent — it moved to the workspace source-backfill
// prompt (MUL-5159). Captures screenshots for review. Uses a unique
// email per run so the user is always a fresh, un-onboarded user
// landing on /onboarding.

const EMAIL = `onboarding-v3-${Date.now()}@localhost`;
const SHOTS_DIR = "../shots-rail";

test.use({ viewport: { width: 1440, height: 900 } });

test("onboarding — welcome → about you (answer path)", async ({ page }) => {
  const api = new TestApiClient();
  await api.login(EMAIL, "OBv3 Tester");
  const token = api.getToken();

  await page.addInitScript((t) => {
    localStorage.setItem("multica_token", t);
  }, token);
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" });
  await waitForPageText(page, "Start exploring");

  // 1. Welcome screen
  await expect(page.getByRole("button", { name: "Start exploring" })).toBeVisible({ timeout: 15000 });
  await page.screenshot({ path: `${SHOTS_DIR}/01-welcome.png`, fullPage: false });

  // BayClaw is server-centric: one CTA, no desktop-download fork.
  await page.getByRole("button", { name: "Start exploring" }).click();

  // 2. About you step — both questions live on this one screen and the
  //    source question must NOT exist anywhere in the flow.
  await expect(page.getByText("Tell us a bit about you.")).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("Which best describes you?")).toBeVisible();
  await expect(page.getByText("What do you want to use BayClaw for?")).toBeVisible();
  // The rail names every step and marks the current one; the ordinal
  // counter it replaced is gone.
  await expect(page.locator('[data-slot="stepper-title"]')).toHaveText([
    "About you",
    "Workspace",
    "Meet Mika",
  ]);
  await expect(
    page.locator('[aria-current="step"]').filter({ hasText: "About you" }),
  ).toBeVisible();
  await expect(page.getByText("How did you hear about BayClaw?")).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS_DIR}/02-about-you.png` });

  // Answer both groups, then Continue → workspace step.
  await page.getByRole("radio", { name: /Engineer \/ developer/i }).click();
  await page.getByRole("checkbox", { name: /Ship code with AI agents/i }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  // 3. Workspace step
  await expect(page.getByRole("heading", { name: /Name your workspace/i })).toBeVisible({ timeout: 10000 });
  await expect(
    page.locator('[aria-current="step"]').filter({ hasText: "Workspace" }),
  ).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS_DIR}/03-workspace.png` });

  // 4. Runtime step — the rail should now show two completed steps and mark
  //    "Meet Mika" current.
  await page.getByRole("textbox").first().fill(`Rail QA ${Date.now()}`);
  await page.getByRole("button", { name: /^Create /i }).click();
  await expect(
    page.locator('[aria-current="step"]').filter({ hasText: "Meet Mika" }),
  ).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS_DIR}/06-runtime.png` });
});

test("onboarding — one skip clears the whole questionnaire step", async ({ page }) => {
  const api = new TestApiClient();
  await api.login(`skip-${Date.now()}@localhost`, "Skipper");
  const token = api.getToken();

  await page.addInitScript((t) => localStorage.setItem("multica_token", t), token);
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" });
  await waitForPageText(page, "Start exploring");

  await page.getByRole("button", { name: "Start exploring" }).click();
  await expect(page.getByText("Tell us a bit about you.")).toBeVisible({ timeout: 10000 });

  // A single Skip covers role + use case — next stop is workspace.
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.getByRole("heading", { name: /Name your workspace/i })).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS_DIR}/04-after-skip.png` });
});

test("onboarding — zh-Hans renders Chinese labels", async ({ page, context, baseURL }) => {
  await context.addCookies([
    {
      name: "multica-locale",
      value: "zh-Hans",
      url: baseURL ?? "http://localhost:3000",
    },
  ]);
  const api = new TestApiClient();
  await api.login(`zh-${Date.now()}@localhost`, "中文用户");
  const token = api.getToken();

  await page.addInitScript((t) => localStorage.setItem("multica_token", t), token);
  await page.goto("/onboarding", { waitUntil: "domcontentloaded" });
  await waitForPageText(page, "开始探索");

  // Click the named CTA, not ".first()": the onboarding header gained a
  // logout escape (c3cc777ac) which sits earlier in DOM order and signs
  // the test user out.
  await page.getByRole("button", { name: "开始探索" }).click();

  // About-you screen — Chinese headline + both sub-questions.
  await expect(page.getByText("简单介绍一下你自己。")).toBeVisible({ timeout: 10000 });
  await expect(page.getByText("哪一项最符合你？")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS_DIR}/05-about-you-zh.png` });
});
