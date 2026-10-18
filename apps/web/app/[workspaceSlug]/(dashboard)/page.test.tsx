// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ preference: undefined as string | undefined, redirect: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => state.preference ? { value: state.preference } : undefined }) }));
vi.mock("next/navigation", () => ({ redirect: state.redirect }));
import WorkspaceStartPage from "./page";
beforeEach(() => { state.preference = undefined; state.redirect.mockClear(); });
it("routes a bare workspace entry to its supported device choice", async () => {
  await WorkspaceStartPage({ params: Promise.resolve({ workspaceSlug: "acme" }) });
  expect(state.redirect).toHaveBeenLastCalledWith("/acme/cockpit");
  state.preference = "inbox";
  await WorkspaceStartPage({ params: Promise.resolve({ workspaceSlug: "acme" }) });
  expect(state.redirect).toHaveBeenLastCalledWith("/acme/inbox");
  state.preference = "https://outside.example";
  await WorkspaceStartPage({ params: Promise.resolve({ workspaceSlug: "acme" }) });
  expect(state.redirect).toHaveBeenLastCalledWith("/acme/cockpit");
});
