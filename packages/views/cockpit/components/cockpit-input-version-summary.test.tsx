import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { CockpitInputVersionSource, CockpitInputVersionSummary } from "./cockpit-input-version-summary";
import { inputVersion } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("../../navigation", () => ({ useNavigation: () => ({ searchParams: new URLSearchParams() }), AppLink: ({ children, href, ...props }: React.ComponentProps<"a">) => <a href={href} {...props}>{children}</a> }));

function Wrapper({ children }: { children: React.ReactNode }) {
  return <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider>;
}

describe("fixed input evidence", () => {
  it("keeps a historical fixed version distinct from current unreadability", () => {
    render(<CockpitInputVersionSummary version={inputVersion({ availability: "unavailable", unavailableReason: "private_storage_unavailable", canDownload: false })} />, { wrapper: Wrapper });
    expect(screen.getByText("Content fixed")).toBeVisible();
    expect(screen.getByText("Fixed copy is currently unavailable")).toBeVisible();
    expect(screen.queryByText("Fixed copy is readable")).toBeNull();
  });

  it("retains the pending decision and exact version when an artifact is reused as input", () => {
    const version = inputVersion();
    render(<CockpitInputVersionSource version={{ ...version, source: { ...version.source, kind: "artifact_version", artifactId: "artifact-1", artifactTitle: "Draft analysis",
      artifactVersionId: "original-version", artifactVersionNumber: 3, artifactDecision: "pending" } }} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Source and verification details"));
    const link = screen.getByRole("link", { name: /Draft analysis/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("artifact=artifact-1"));
    expect(link).toHaveAttribute("href", expect.stringContaining("version=original-version"));
    expect(screen.getByText(enCockpit.workflow.pending_review)).toBeVisible();
    expect(screen.queryByText(enCockpit.workflow.approved)).toBeNull();
    expect(screen.queryByText("Original source")).toBeNull();
  });

});
