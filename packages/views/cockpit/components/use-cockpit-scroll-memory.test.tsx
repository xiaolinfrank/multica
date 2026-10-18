import { useRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useCockpitScopeViewStore } from "@multica/core/cockpit";
import { useCockpitScrollMemory } from "./use-cockpit-scroll-memory";
const key = JSON.stringify(["workspace", "project", "gantt"]);
function View({ filter = "" }: { filter?: string }) { const element = useRef<HTMLDivElement>(null); useCockpitScrollMemory(element, key, true, filter); return <div ref={element} data-testid="viewport" />; }
beforeEach(() => useCockpitScopeViewStore.getState().reset());
describe("cockpit viewport return context", () => {
  it("restores the same viewport after leaving and resets vertical position only when the filter changes", async () => {
    useCockpitScopeViewStore.getState().updatePlan(key, { scrollTop: 520, scrollLeft: 240 });
    const view = render(<View />); const element = screen.getByTestId("viewport"); expect(element.scrollTop).toBe(520); expect(element.scrollLeft).toBe(240);
    element.scrollTop = 820; fireEvent.scroll(element); await waitFor(() => expect(useCockpitScopeViewStore.getState().plans[key]?.scrollTop).toBe(820));
    view.rerender(<View filter="new query" />); expect(element.scrollTop).toBe(0); expect(element.scrollLeft).toBe(240);
    view.unmount(); render(<View filter="new query" />); expect(screen.getByTestId("viewport").scrollLeft).toBe(240);
  });
  it("does not recreate the former account's viewport during unmount after session reset", () => {
    const view = render(<View />); screen.getByTestId("viewport").scrollTop = 999;
    act(() => useCockpitScopeViewStore.getState().reset()); view.unmount(); expect(useCockpitScopeViewStore.getState().plans).toEqual({});
  });
});
