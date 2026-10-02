import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SegmentedPill, useSegmentedPill } from "./cockpit-segmented";

function DelayedControl() {
  const [mounted, setMounted] = useState(false);
  const ref = useSegmentedPill("overview");
  return (
    <>
      <button type="button" onClick={() => setMounted(true)}>Mount control</button>
      {mounted && (
        <div ref={ref} data-testid="segmented">
          <SegmentedPill />
          <button type="button" data-active="true">Overview</button>
        </div>
      )}
    </>
  );
}

describe("useSegmentedPill", () => {
  it("measures a control that mounts after the active key was established", async () => {
    render(<DelayedControl />);
    fireEvent.click(screen.getByRole("button", { name: "Mount control" }));

    await waitFor(() => {
      expect(screen.getByTestId("segmented").style.getPropertyValue("--pill-on")).toBe("1");
    });
  });
});
