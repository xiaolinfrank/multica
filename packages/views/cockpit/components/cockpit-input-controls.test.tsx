import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { Button } from "@multica/ui/components/ui/button";
import { CockpitInputCandidates, CockpitInputSelectionSummary, type CockpitInputCandidate } from "./cockpit-input-candidates";
import { CockpitInputFileField } from "./cockpit-input-file-field";
import { CockpitInputTransferStatus } from "./cockpit-input-transfer-status";
import enCockpit from "../../locales/en/cockpit.json";

function Wrapper({ children }: { children: React.ReactNode }) {
  return <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider>;
}

describe("input material controls", () => {
  it("keeps the registered file visible after reload and requires an actual browser File to continue", () => {
    const selected = vi.fn();
    function Field() {
      const [file, setFile] = useState<File | null>(null);
      return <CockpitInputFileField file={file} retainedFile={{ name: "original-recording.wav", size: 4 }} maxBytes={1024}
        onSelect={(value) => { selected(value); setFile(value); }} />;
    }
    render(<Field />, { wrapper: Wrapper });
    expect(screen.getByText("original-recording.wav")).toBeVisible();
    expect(screen.getByText(enCockpit.input_materials.reselect_hint)).toBeVisible();
    expect(selected).not.toHaveBeenCalled();
    const file = new File(["data"], "original-recording.wav", { type: "audio/wav" });
    fireEvent.change(screen.getByLabelText("Select the original file again"), { target: { files: [file] } });
    expect(selected).toHaveBeenCalledExactlyOnceWith(file);
    expect(screen.queryByText(enCockpit.input_materials.reselect_hint)).toBeNull();
    expect(screen.getByLabelText("Choose an original file")).toHaveValue("");
  });

  it("does not present bytes received as a ready input and removes the percentage during copy verification", () => {
    const { rerender } = render(<CockpitInputTransferStatus state="reading" receivedBytes={1024} expectedBytes={1024} />, { wrapper: Wrapper });
    expect(screen.getByRole("progressbar", { name: "Content received" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.queryByText("Fixed version ready")).toBeNull();
    rerender(<CockpitInputTransferStatus state="verifying" receivedBytes={1024} expectedBytes={1024} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Checking the fixed copy");
    rerender(<CockpitInputTransferStatus state="awaiting_finalize" receivedBytes={1024} expectedBytes={1024}
      recovery={<Button>Confirm this version</Button>} />);
    expect(screen.getByText(enCockpit.input_materials.finalize_hint)).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm this version" })).toBeVisible();
    expect(screen.queryByText("Fixed version ready")).toBeNull();
  });

  it("keeps an unavailable selected file removable while preventing a new selection of the same unavailable source", () => {
    const select = vi.fn();
    const open = vi.fn();
    const items: CockpitInputCandidate[] = [
      { id: "selected-file", name: "Selected recording.wav", kind: "file", canSelect: false, selected: true, metadata: "NAS", blockedReason: "Source changed. Check it again." },
      { id: "other-file", name: "Other recording.wav", kind: "file", canSelect: false, selected: false, metadata: "NAS", blockedReason: "Source changed. Check it again." },
      { id: "folder", name: "Meeting files", kind: "directory", canOpen: true, selected: false, metadata: "NAS" },
    ];
    render(<CockpitInputCandidates items={items} onSelect={select} onOpenDirectory={open} />, { wrapper: Wrapper });
    const selected = screen.getByRole("checkbox", { name: "Selected recording.wav" });
    expect(selected).toBeEnabled();
    expect(selected).toHaveAccessibleDescription("Source changed. Check it again.");
    expect(screen.getByRole("checkbox", { name: "Other recording.wav" })).toBeDisabled();
    fireEvent.click(selected);
    expect(select).toHaveBeenCalledExactlyOnceWith("selected-file", false);
    fireEvent.click(screen.getByRole("button", { name: "Meeting files" }));
    expect(open).toHaveBeenCalledExactlyOnceWith("folder");
  });

  it("keeps cross-page selection review reachable when the current candidate page is empty", () => {
    const review = vi.fn();
    render(<><CockpitInputCandidates items={[]} onSelect={vi.fn()} onOpenDirectory={vi.fn()} />
      <CockpitInputSelectionSummary selectedCount={27} selectionLimit={50} onReview={review} /></>, { wrapper: Wrapper });
    expect(screen.getByText("No files or folders on this page.")).toBeVisible();
    expect(screen.getByText("Selected 27 / 50")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Review selected items" }));
    expect(review).toHaveBeenCalledOnce();
  });
});
