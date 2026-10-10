import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { defaultStorage } from "@multica/core/platform";
import { cockpitSavedViewStorageKey, useCockpitSavedViewStore, type CockpitSavedViewDefinition } from "@multica/core/cockpit";
import enCockpit from "../../locales/en/cockpit.json";
import { CockpitSavedViewsControl } from "./cockpit-saved-views";
const definition: CockpitSavedViewDefinition = { surface: "work", scope: { projectId: null, moduleId: null }, audience: "mine", kind: "workflow", mode: "attention" };
const key = cockpitSavedViewStorageKey("person", "workspace");
function setup() { const apply = vi.fn(); const capture = vi.fn(() => definition); const wrapper = ({ children }: { children: React.ReactNode }) => <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>{children}</I18nProvider>;
  const view = render(<CockpitSavedViewsControl wsId="workspace" userId="person" capture={capture} onApply={apply} />, { wrapper }); return { ...view, apply, capture }; }
async function nameCurrent() { const user = userEvent.setup(); await user.click(screen.getByRole("button", { name: "Saved views" })); await user.click(await screen.findByRole("button", { name: "Save current view" })); await user.type(screen.getByRole("textbox", { name: "View name" }), "My reviews"); return user; }
beforeEach(() => { useCockpitSavedViewStore.getState().reset(); defaultStorage.removeItem(key); defaultStorage.removeItem(cockpitSavedViewStorageKey("other-person", "workspace")); });
afterEach(() => vi.restoreAllMocks());
describe("personal saved-view controls", () => {
  it("states its device boundary and applies the exact saved definition through the host", async () => {
    const { apply } = setup(); const user = await nameCurrent(); expect(screen.getByText(enCockpit.saved_views.device_only)).toBeVisible(); await user.click(screen.getByRole("button", { name: "Save view" }));
    expect(await screen.findByRole("status")).toHaveTextContent(enCockpit.saved_views.saved); await user.click(screen.getByRole("button", { name: "Apply view My reviews" })); expect(apply).toHaveBeenCalledExactlyOnceWith(definition);
  });
  it("retains the name and unsaved state when device storage refuses the write", async () => {
    setup(); const user = await nameCurrent(); vi.spyOn(defaultStorage, "setItem").mockImplementationOnce(() => { throw new Error("quota"); }); await user.click(screen.getByRole("button", { name: "Save view" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(enCockpit.saved_views.write_failed); expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue("My reviews"); expect(useCockpitSavedViewStore.getState().namespaces[key]?.items).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Save view" })); expect(await screen.findByRole("button", { name: "Apply view My reviews" })).toBeVisible();
  });
  it("renames and deletes a local view explicitly without exposing it under another account", async () => {
    const view = setup(); const user = await nameCurrent(); await user.click(screen.getByRole("button", { name: "Save view" })); const id = useCockpitSavedViewStore.getState().namespaces[key]!.items[0]!.id;
    await user.click(screen.getByRole("button", { name: "Manage view My reviews" })); await user.click(await screen.findByRole("menuitem", { name: "Rename" })); const input = screen.getByRole("textbox", { name: "View name" }); await user.clear(input); await user.type(input, "Team review"); await user.click(screen.getByRole("button", { name: "Save view" }));
    expect(useCockpitSavedViewStore.getState().namespaces[key]?.items[0]).toMatchObject({ id, name: "Team review" });
    view.rerender(<CockpitSavedViewsControl wsId="workspace" userId="other-person" capture={view.capture} onApply={view.apply} />); await user.click(screen.getByRole("button", { name: "Saved views" })); expect(await screen.findByText(enCockpit.saved_views.empty)).toBeVisible(); expect(screen.queryByRole("button", { name: "Apply view Team review" })).toBeNull();
    view.rerender(<CockpitSavedViewsControl wsId="workspace" userId="person" capture={view.capture} onApply={view.apply} />); await user.click(screen.getByRole("button", { name: "Saved views" })); await user.click(await screen.findByRole("button", { name: "Manage view Team review" })); await user.click(await screen.findByRole("menuitem", { name: "Delete view" })); expect(useCockpitSavedViewStore.getState().namespaces[key]?.items).toHaveLength(1);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete view" })); await waitFor(() => expect(useCockpitSavedViewStore.getState().namespaces[key]?.items).toEqual([]));
  });
});
