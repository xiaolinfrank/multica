import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multica/core/i18n/react";
import type { DirectoryFillResult } from "@multica/core/types";
import enCockpit from "../../locales/en/cockpit.json";
import enCommon from "../../locales/en/common.json";
import { FillDirectoriesButton } from "./cockpit-directories-fill";

const fill = vi.hoisted(() => ({
  calls: [] as unknown[],
  preview: null as unknown as DirectoryFillResult,
  applied: null as unknown as DirectoryFillResult,
}));
const sync = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("@multica/core/directory", async (original) => ({
  ...(await original<typeof import("@multica/core/directory")>()),
  useFillPlanDirectories: () => ({
    mutate: (vars: unknown, options?: { onSuccess?: (value: DirectoryFillResult) => void }) => {
      fill.calls.push(vars);
      const value = (vars as { apply?: boolean }).apply ? fill.applied : fill.preview;
      options?.onSuccess?.(value);
    },
    isPending: false,
  }),
  useSyncNodeDirectory: () => ({
    mutate: (vars: unknown, options?: { onSuccess?: (value: unknown) => void }) => {
      sync.calls.push(vars);
      options?.onSuccess?.({ directory_sync: { status: "created", directory_name: "01.01模块" }, directory: { full_path: "/share/01.01模块" } });
    },
    isPending: false,
  }),
}));

function result(applied: boolean, status: string): DirectoryFillResult {
  return {
    applied,
    items: [{
      node_id: "n1", code: "01.01", name: "模块", kind: "module", action: "create",
      status, directory_name: "01.01模块", full_path: "/share/01.01模块",
    }],
    counts: applied ? { [status]: 1 } : { create: 1 },
    shared_collab_projects: [],
    running_tasks: [],
  };
}

function renderButton() {
  return render(
    <I18nProvider locale="en" resources={{ en: { cockpit: enCockpit, common: enCommon } }}>
      <FillDirectoriesButton wsId="ws-1" projectId="p1" />
    </I18nProvider>,
  );
}

beforeEach(() => {
  fill.calls = [];
  sync.calls = [];
  fill.preview = result(false, "pending");
  fill.applied = result(true, "failed");
});

describe("FillDirectoriesButton", () => {
  it("shows one list after applying, not the preview list and the result list together", async () => {
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: /Fill folders/ }));
    await waitFor(() => expect(fill.calls.length).toBe(1));
    fireEvent.click(await screen.findByRole("button", { name: /Apply/ }));
    await waitFor(() => expect(fill.calls.length).toBe(2));

    expect(screen.getAllByText("01.01")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Close" }).length).toBeGreaterThan(0);
    expect(screen.queryByText("Sync even while agent tasks are running")).toBeNull();
  });

  it("updates a failed row after retrying it", async () => {
    renderButton();
    fireEvent.click(screen.getByRole("button", { name: /Fill folders/ }));
    await waitFor(() => expect(fill.calls.length).toBe(1));
    fireEvent.click(await screen.findByRole("button", { name: /Apply/ }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Retry/ }).length).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => expect(sync.calls.length).toBe(1));
    expect(sync.calls[0]).toEqual({ nodeId: "n1", force: false });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull());
    expect(screen.getByText("Created")).toBeInTheDocument();
  });
});
