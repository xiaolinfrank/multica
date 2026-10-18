import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { CockpitArtifactAvailabilityReason } from "./cockpit-artifact-availability";
import enCockpit from "../../locales/en/cockpit.json";

it("explains how to recover existing fixed content without exposing a private-storage code or describing it as a new submission", () => {
  render(<I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitArtifactAvailabilityReason reason="private_storage_required" /></I18nProvider>);
  expect(screen.getByText(enCockpit.artifact_runtime.private_content_unavailable)).toBeVisible();
  expect(screen.queryByText("private_storage_required")).toBeNull();
  expect(screen.queryByText(enCockpit.artifact_runtime.private_storage_required)).toBeNull();
});
