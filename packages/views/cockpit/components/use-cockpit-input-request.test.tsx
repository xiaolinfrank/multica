import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@multica/core/api";
import { advanceCockpitInputForm, cockpitInputDraftKey, emptyCockpitInputForm, setCockpitInputForm, useCockpitInputDraftStore } from "@multica/core/cockpit";
import type { CockpitInputCreateResult } from "@multica/core/types/cockpit-input";
import { useCockpitInputRequest } from "./use-cockpit-input-request";
import { inputHeader, inputPrincipal, INPUT_ID, INPUT_KEY, INPUT_MEETING, INPUT_MEMBER, INPUT_TIME, INPUT_WS } from "./input-test-fixtures";

vi.mock("../../navigation", () => ({ useNavigation: () => ({ pathname: "/ws/cockpit", searchParams: new URLSearchParams() }) }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { createCockpitInput: vi.fn(), getCockpitInputCreateCommand: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); useCockpitInputDraftStore.getState().clearDraft(); });

describe("input command return context", () => {
  it("retains the original creation key when a late acknowledgement returns after A → B → A", async () => {
    const keyA = cockpitInputDraftKey(INPUT_WS, INPUT_MEMBER, "upload", INPUT_MEETING);
    const keyB = cockpitInputDraftKey(INPUT_WS, INPUT_MEMBER, "upload", "b2000000-0000-4000-8000-000000000001");
    const draft = emptyCockpitInputForm(INPUT_KEY);
    setCockpitInputForm(keyA, draft);
    const body = { commandKey: INPUT_KEY, title: "Recording", description: "", projectId: null, originIssueId: null };
    const receipt: CockpitInputCreateResult = { workspaceId: INPUT_WS, commandKey: INPUT_KEY, action: "input_create", replayed: false,
      receipt: { ...body, inputId: INPUT_ID, inputRevision: 1, requestHash: "a".repeat(64), principal: inputPrincipal(), createdAt: INPUT_TIME }, current: inputHeader({ title: body.title }) };
    let resolveCreate!: (value: CockpitInputCreateResult) => void;
    vi.mocked(api.createCockpitInput).mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));
    vi.mocked(api.getCockpitInputCreateCommand).mockResolvedValue({ ...receipt, replayed: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(({ draftKey }) => useCockpitInputRequest(INPUT_WS, draftKey), { initialProps: { draftKey: keyA }, wrapper });
    try {
      let request!: ReturnType<typeof view.result.current.run>;
      act(() => { request = view.result.current.run({ kind: "create", body }); });
      view.rerender({ draftKey: keyB });
      view.rerender({ draftKey: keyA });
      await act(async () => { resolveCreate(receipt); const oldResult = await request; expect(oldResult?.stillCurrent()).toBe(false); });
      expect(useCockpitInputDraftStore.getState().draft.forms[keyA]?.inputId).toBeNull();
      expect(useCockpitInputDraftStore.getState().draft.commands[keyA]?.body.commandKey).toBe(INPUT_KEY);
      expect(view.result.current.pending?.body.commandKey).toBe(INPUT_KEY);
      expect(view.result.current.busy).toBe(false);
      await act(async () => {
        const recovered = await view.result.current.verify();
        expect(recovered?.stillCurrent()).toBe(true);
        if (recovered?.acknowledged.kind === "create") advanceCockpitInputForm(keyA, draft.generation,
          { inputId: recovered.acknowledged.result.receipt.inputId, inputRevision: recovered.acknowledged.result.receipt.inputRevision });
      });
      expect(api.createCockpitInput).toHaveBeenCalledTimes(1);
      expect(api.getCockpitInputCreateCommand).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_KEY);
      expect(useCockpitInputDraftStore.getState().draft.commands[keyA]).toBeUndefined();
      expect(useCockpitInputDraftStore.getState().draft.forms[keyA]?.inputId).toBe(INPUT_ID);
    } finally { view.unmount(); client.clear(); }
  });
});
