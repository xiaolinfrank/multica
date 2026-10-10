import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useCockpitCommandContext } from "./use-cockpit-command-context";

const location = vi.hoisted(() => ({ pathname: "/workspace/cockpit", search: "node=A" }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: location.pathname, searchParams: new URLSearchParams(location.search) }) }));
beforeEach(() => { location.pathname = "/workspace/cockpit"; location.search = "node=A"; });

it("does not revive an A command after A→B→A on the same mounted consumer", () => {
  const view = renderHook(({ identity }) => useCockpitCommandContext(identity), { initialProps: { identity: "workspace:A:open" } });
  const captureA = view.result.current; const oldA = captureA(); expect(oldA()).toBe(true);
  view.rerender({ identity: "workspace:B:open" }); view.rerender({ identity: "workspace:A:open" });
  expect(oldA()).toBe(false); expect(captureA()()).toBe(false); expect(view.result.current()()).toBe(true);
});
it("treats closing and reopening the same confirmation as a new interaction", () => {
  const view = renderHook(({ open }) => useCockpitCommandContext(JSON.stringify(["workspace", "A", open])), { initialProps: { open: true } });
  const pending = view.result.current(); view.rerender({ open: false }); view.rerender({ open: true });
  expect(pending()).toBe(false); expect(view.result.current()()).toBe(true);
});
it("tracks navigation ABA and rejects a callback after unmount", () => {
  const view = renderHook(() => useCockpitCommandContext("workspace:A")); const old = view.result.current();
  location.search = "node=B"; view.rerender(); location.search = "node=A"; view.rerender();
  expect(old()).toBe(false); const current = view.result.current(); expect(current()).toBe(true);
  view.unmount(); expect(current()).toBe(false);
});
