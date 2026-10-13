import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import { cockpitEndedInputRegistrations, cockpitInputDraftKey, emptyCockpitInputForm, setCockpitInputForm, useCockpitInputDraftStore } from "@multica/core/cockpit";
import { CockpitInputSourceForm } from "./cockpit-input-source-form";
import { inputHeader, inputPrincipal, INPUT_ID, INPUT_MEETING, INPUT_MEMBER, INPUT_TIME, INPUT_VERSION, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

const navigation = { pathname: "/ws/cockpit", searchParams: new URLSearchParams(`meeting=${INPUT_MEETING}`) };
vi.mock("../../navigation", () => ({ useNavigation: () => navigation, AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@multica/core/paths", () => ({ useWorkspacePaths: () => ({ cockpit: () => "/ws/cockpit", issueDetail: (id: string) => `/ws/issues/${id}` }) }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: { createCockpitInput: vi.fn(), submitCockpitInputVersion: vi.fn(), getCockpitInputVersionCommand: vi.fn(), getCockpitInput: vi.fn(), getCockpitInputAttachment: vi.fn(), getCockpitArtifactVersion: vi.fn(), uploadCockpitInputBytes: vi.fn() } }));
const key = cockpitInputDraftKey(INPUT_WS, INPUT_MEMBER, "source-input", INPUT_MEETING, "");
beforeEach(() => {
  vi.clearAllMocks(); useCockpitInputDraftStore.getState().clearDraft();
  vi.mocked(api.createCockpitInput).mockImplementation(async (_ws, body) => ({ workspaceId: INPUT_WS, commandKey: body.commandKey, action: "input_create", replayed: false,
    receipt: { ...body, inputRevision: 1, inputId: INPUT_ID, requestHash: "a".repeat(64), principal: inputPrincipal(), createdAt: INPUT_TIME }, current: inputHeader() }));
  vi.mocked(api.getCockpitInput).mockResolvedValue(inputHeader());
  vi.mocked(api.getCockpitInputAttachment).mockResolvedValue({ workspaceId: INPUT_WS, id: INPUT_VERSION, issueId: INPUT_ID, filename: "Original source", contentType: "text/plain", sizeBytes: 6, createdAt: INPUT_TIME });
  vi.mocked(api.getCockpitArtifactVersion).mockResolvedValue({ workspace_id: INPUT_WS, artifact_id: INPUT_ID, content: "Original fixed source", feedback: "", download_url: null, content_available: true, content_unavailable_reason: "",
    version: { id: INPUT_VERSION, artifact_id: INPUT_ID, version_number: 3, submission_key: INPUT_VERSION, revision: 1,
      producer_issue_id: INPUT_ID, producer_issue_identifier: "PMO-1", producer_issue_title: "Produce analysis", producer_run_id: null,
      source_meeting_id: null, source_meeting_title: "", source_minutes_version_id: null, source_minutes_version_number: null,
      payload_kind: "text", source_attachment_id: null, filename: "", content_type: "text/plain", size_bytes: 6, content_hash: "a".repeat(64),
      capture_status: "ready", capture_error_code: "", capture_error: "", decision: "pending", reviewer_id: INPUT_MEMBER, review_issue: null,
      submitted_by_type: "member", submitted_by_id: INPUT_MEMBER, created_at: INPUT_TIME, reviewed_at: null, has_feedback: false, can_review: false, can_retry_capture: false } });
  vi.mocked(api.submitCockpitInputVersion).mockImplementation(async (_ws, inputId, body) => {
    return { workspaceId: INPUT_WS, inputId, commandKey: body.commandKey, action: "input_version_submit", replayed: false,
      receipt: { commandKey: body.commandKey, requestHash: "b".repeat(64), inputId, inputRevision: 2, versionId: INPUT_VERSION, versionNumber: 1, source: body.source,
        payloadKind: body.source.kind === "artifact_version" ? "text" : "file", captureState: body.source.kind === "artifact_version" ? "ready" : "queued", transferId: null, transferRevision: null,
        principal: inputPrincipal(), acceptedAt: INPUT_TIME }, current: null, transfer: null };
  });
});
describe("existing source registration", () => {
  it("keeps an unknown source command, exposes the changed header for review, and frees its slot only after explicit ending", async () => {
    setCockpitInputForm(key, { ...emptyCockpitInputForm(crypto.randomUUID()), title: "Original source", source: { kind: "artifact_version", artifactVersion: { artifactId: INPUT_ID, versionId: INPUT_VERSION }, upload: null, nasFile: null, attachment: null } });
    vi.mocked(api.submitCockpitInputVersion).mockRejectedValueOnce(new Error("Reply lost"))
      .mockImplementationOnce(async () => { vi.mocked(api.getCockpitInput).mockResolvedValue(inputHeader({ title: "Current source record", revision: 2 })); throw new ApiError("Header changed", 409, "Conflict", { code: "revision_conflict" }); });
    vi.mocked(api.getCockpitInputVersionCommand).mockRejectedValue(new ApiError("No receipt", 404, "Not Found"));
    const cancel = vi.fn(); const inspect = vi.fn(); const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    function Form() { const [open, setOpen] = useState(true); return open ? <CockpitInputSourceForm wsId={INPUT_WS} accountId={INPUT_MEMBER} meetingId={INPUT_MEETING} targetLabel="Project meeting" canAdd
      capabilities={{ workspaceId: INPUT_WS, canCreate: true, canBrowseNas: false, fileCaptureAvailable: true, directUploadAvailable: true, maxFileBytes: 500 * 1024 * 1024, unavailableReason: "", uploadSessionTtlSeconds: 86400 }} onOpenVersion={inspect} onCancel={() => { cancel(); setOpen(false); }} /> : null; }
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><Form /></I18nProvider></QueryClientProvider>);
    try {
      const submit = screen.getByRole("button", { name: enCockpit.input_materials.register_source }); await waitFor(() => expect(submit).toBeEnabled()); fireEvent.click(submit);
      await screen.findByText(enCockpit.input_materials.command_unconfirmed);
      expect(screen.queryByRole("button", { name: enCockpit.input_materials.end_registration })).toBeNull();
      const originalKey = useCockpitInputDraftStore.getState().draft.commands[key]!.body.commandKey;
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.verify_command }));
      fireEvent.click(await screen.findByRole("button", { name: enCockpit.input_materials.retry_command }));
      const end = await screen.findByRole("button", { name: enCockpit.input_materials.end_registration }); await waitFor(() => expect(end).toBeEnabled());
      expect(vi.mocked(api.submitCockpitInputVersion).mock.calls.map((call) => call[2].commandKey)).toEqual([originalKey, originalKey]);
      expect(await screen.findByText("Current source record")).toBeVisible();
      expect(screen.getByRole("textbox", { name: enCockpit.input_materials.name })).toHaveValue("Original source");
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.open_registered }));
      expect(inspect).toHaveBeenCalledExactlyOnceWith(INPUT_ID, undefined);
      expect(useCockpitInputDraftStore.getState().draft.forms[key]?.inputRevision).toBe(1);
      fireEvent.click(end); const dialog = screen.getByRole("dialog", { name: enCockpit.input_materials.end_registration });
      fireEvent.change(within(dialog).getByRole("textbox", { name: enCockpit.input_materials.end_reason }), { target: { value: "Keep the original registration for reference" } });
      fireEvent.click(within(dialog).getByRole("button", { name: enCockpit.input_materials.end_registration }));
      expect(cancel).toHaveBeenCalledOnce(); expect(useCockpitInputDraftStore.getState().draft.forms[key]).toBeUndefined();
      const records = cockpitEndedInputRegistrations(useCockpitInputDraftStore.getState().draft, INPUT_WS, INPUT_MEMBER, INPUT_MEETING);
      expect(records).toEqual([expect.objectContaining({ inputId: INPUT_ID, title: "Original source", reason: "Keep the original registration for reference" })]);
      expect(useCockpitInputDraftStore.getState().draft.forms[records[0]!.key]).toMatchObject({ versionId: null, source: { artifactVersion: { artifactId: INPUT_ID, versionId: INPUT_VERSION } } });
      expect(api.createCockpitInput).toHaveBeenCalledTimes(1); expect(api.uploadCockpitInputBytes).not.toHaveBeenCalled();
    } finally { view.unmount(); client.clear(); }
  });

  it.each(["artifact_version", "attachment"] as const)("registers an independent fixed input from %s without a meeting reference", async (kind) => {
    const source = { kind, upload: null, nasFile: null, artifactVersion: kind === "artifact_version" ? { artifactId: INPUT_ID, versionId: INPUT_VERSION } : null,
      attachment: kind === "attachment" ? { issueId: INPUT_ID, attachmentId: INPUT_VERSION } : null };
    setCockpitInputForm(key, { ...emptyCockpitInputForm(crypto.randomUUID()), title: "Original source", source });
    const open = vi.fn(); const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}><CockpitInputSourceForm wsId={INPUT_WS} accountId={INPUT_MEMBER} meetingId={INPUT_MEETING} targetLabel="Project meeting" canAdd
      capabilities={{ workspaceId: INPUT_WS, canCreate: true, canBrowseNas: false, fileCaptureAvailable: true, directUploadAvailable: true, maxFileBytes: 500 * 1024 * 1024, unavailableReason: "", uploadSessionTtlSeconds: 86400 }} onOpenVersion={open} onCancel={vi.fn()} /></I18nProvider></QueryClientProvider>);
    try {
      const submit = screen.getByRole("button", { name: enCockpit.input_materials.register_source }); await waitFor(() => expect(submit).toBeEnabled()); fireEvent.click(submit);
      await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith(INPUT_ID, INPUT_VERSION));
      expect(api.submitCockpitInputVersion).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_ID, expect.objectContaining({ expectedRevision: 1, source }));
      expect(vi.mocked(api.submitCockpitInputVersion).mock.calls[0]?.[2]).not.toHaveProperty("initialReference");
      expect(api.uploadCockpitInputBytes).not.toHaveBeenCalled();
      expect(useCockpitInputDraftStore.getState().draft.forms[key]).toBeUndefined();
      expect(screen.queryByText("Fixed version ready")).toBeNull();
    } finally { view.unmount(); client.clear(); }
  });
});
