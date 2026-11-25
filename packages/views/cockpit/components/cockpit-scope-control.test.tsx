/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setApiInstance } from "@multica/core/api";
import type { ApiClient } from "@multica/core/api/client";
import { renderWithI18n } from "../../test/i18n";
import { CockpitScopeControl } from "./cockpit-scope-control";

const pushMock = vi.fn();

vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    pathname: "/acme/cockpit",
    searchParams: new URLSearchParams("tab=plan"),
    push: pushMock,
  }),
}));

describe("CockpitScopeControl", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    pushMock.mockReset();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    setApiInstance({
      searchCockpitScopes: async (_wsId: string, kind: "projects" | "modules") =>
        kind === "projects"
          ? {
              workspace_id: "ws-1",
              project_id: null,
              total: 2,
              next_cursor: null,
              items: [
                { id: "p1", code: "01", title: "高质量数据集", project_id: null },
                { id: "p2", code: "02", title: "算法平台建设", project_id: null },
              ],
            }
          : {
              workspace_id: "ws-1",
              project_id: "p1",
              total: 2,
              next_cursor: null,
              items: [
                { id: "m1", code: "01.01", title: "回顾性队列数据集（JIA）", project_id: "p1" },
                { id: "m2", code: "01.02", title: "前瞻性队列数据集（JIA）", project_id: "p1" },
              ],
            },
    } as unknown as ApiClient);
  });

  afterEach(() => {
    cleanup();
  });

  it("shows plan codes alongside project and module titles in triggers and dropdown choices", async () => {
    renderWithI18n(
      <QueryClientProvider client={queryClient}>
        <CockpitScopeControl
          wsId="ws-1"
          scope={{ projectId: "p1", moduleId: "m1" }}
          projectCode="01"
          projectTitle="高质量数据集"
          moduleCode="01.01"
          moduleTitle="回顾性队列数据集（JIA）"
        />
      </QueryClientProvider>,
    );

    const projectTrigger = screen.getByRole("button", { name: "Project scope" });
    expect(projectTrigger).toHaveTextContent("01 高质量数据集");
    const moduleTrigger = screen.getByRole("button", { name: "Module scope" });
    expect(moduleTrigger).toHaveTextContent("01.01 回顾性队列数据集（JIA）");

    fireEvent.click(projectTrigger);
    expect(await screen.findByRole("button", { name: "01 高质量数据集" })).toBeVisible();
    expect(await screen.findByRole("button", { name: "02 算法平台建设" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "02 算法平台建设" }));
    expect(pushMock).toHaveBeenCalledWith("/acme/cockpit?tab=plan&project=p2");

    fireEvent.click(moduleTrigger);
    expect(await screen.findByRole("button", { name: "01.01 回顾性队列数据集（JIA）" })).toBeVisible();
    expect(await screen.findByRole("button", { name: "01.02 前瞻性队列数据集（JIA）" })).toBeVisible();
  });
});
