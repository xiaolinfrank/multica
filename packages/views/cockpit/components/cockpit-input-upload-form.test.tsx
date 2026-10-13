import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { api, ApiError } from "@multica/core/api";
import { cockpitEndedInputRegistrations, cockpitInputDraftKey, useCockpitInputDraftStore } from "@multica/core/cockpit";
import type { CockpitInputCreateInput, CockpitInputCreateResult, CockpitInputVersionResult, CockpitInputVersionSubmitInput } from "@multica/core/types/cockpit-input";
import { CockpitInputUploadForm } from "./cockpit-input-upload-form";
import { inputHeader, inputPrincipal, inputTransfer, inputVersion, INPUT_ID, INPUT_MEETING, INPUT_MEMBER, INPUT_TIME, INPUT_TRANSFER, INPUT_VERSION, INPUT_WS } from "./input-test-fixtures";
import enCockpit from "../../locales/en/cockpit.json";

const navigation = { pathname: "/ws/cockpit", searchParams: new URLSearchParams(`meeting=${INPUT_MEETING}&meeting_view=resources`) };
vi.mock("../../navigation", () => ({ useNavigation: () => navigation, AppLink: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a> }));
vi.mock("@multica/core/api", async (original) => ({ ...(await original<typeof import("@multica/core/api")>()), api: {
  createCockpitInput: vi.fn(), submitCockpitInputVersion: vi.fn(), getCockpitInputCreateCommand: vi.fn(), getCockpitInputVersionCommand: vi.fn(),
  restartCockpitInputTransfer: vi.fn(), getCockpitInput: vi.fn(), getCockpitInputTransfer: vi.fn(), getCockpitInputVersion: vi.fn(), uploadCockpitInputBytes: vi.fn(), finalizeCockpitInputTransfer: vi.fn(),
} }));
let transfer = inputTransfer();
let version = inputVersion();
let headerRevision = 1;
const key = cockpitInputDraftKey(INPUT_WS, INPUT_MEMBER, "upload", INPUT_MEETING, "");

function createResult(body: CockpitInputCreateInput): CockpitInputCreateResult {
  return { workspaceId: INPUT_WS, commandKey: body.commandKey, action: "input_create", replayed: false,
    receipt: { ...body, inputId: INPUT_ID, inputRevision: 1, requestHash: "a".repeat(64), principal: inputPrincipal(), createdAt: INPUT_TIME },
    current: inputHeader({ creationKey: body.commandKey, title: body.title, description: body.description }) };
}
function versionResult(body: CockpitInputVersionSubmitInput): CockpitInputVersionResult {
  return { workspaceId: INPUT_WS, inputId: INPUT_ID, commandKey: body.commandKey, action: "input_version_submit", replayed: false,
    receipt: { commandKey: body.commandKey, requestHash: "b".repeat(64), inputId: INPUT_ID, versionId: INPUT_VERSION, versionNumber: 1, inputRevision: 2,
      source: body.source, payloadKind: "file", captureState: "awaiting_upload", transferId: INPUT_TRANSFER, transferRevision: 1,
      principal: inputPrincipal(), acceptedAt: INPUT_TIME }, current: version, transfer };
}

beforeEach(() => {
  vi.clearAllMocks(); useCockpitInputDraftStore.getState().clearDraft();
  headerRevision = 1;
  transfer = inputTransfer(); version = inputVersion({ captureState: "awaiting_upload", availability: "unknown", readyAt: null, sizeBytes: null, contentHash: null,
    activeTransferId: INPUT_TRANSFER, canDownload: false, canReference: false });
  vi.mocked(api.createCockpitInput).mockImplementation(async (_ws, body) => createResult(body));
  vi.mocked(api.submitCockpitInputVersion).mockImplementation(async (_ws, _input, body) => { headerRevision = 2; return versionResult(body); });
  vi.mocked(api.getCockpitInput).mockImplementation(async () => inputHeader({ revision: headerRevision, currentVersion: headerRevision > 1 ? version : null }));
  vi.mocked(api.getCockpitInputTransfer).mockImplementation(async () => transfer);
  vi.mocked(api.getCockpitInputVersion).mockImplementation(async () => ({ workspaceId: INPUT_WS, inputId: INPUT_ID, version, content: null, captureError: "" }));
  vi.mocked(api.uploadCockpitInputBytes).mockImplementation(async () => {
    transfer = inputTransfer({ mode: transfer.mode, state: "awaiting_finalize", revision: 4, receivedBytes: 6, pinnedSizeBytes: 6, contentHash: "a".repeat(64), canUpload: false, canFinalize: true });
    return { workspaceId: INPUT_WS, inputId: INPUT_ID, versionId: INPUT_VERSION, transferId: INPUT_TRANSFER, current: transfer };
  });
  vi.mocked(api.finalizeCockpitInputTransfer).mockImplementation(async (_ws, _input, _version, _transfer, body) => {
    transfer = { ...transfer, state: "verified", revision: 5, canFinalize: false, canAbandon: false };
    version = inputVersion({ currentTransferId: INPUT_TRANSFER, acceptedTransferId: INPUT_TRANSFER });
    return { workspaceId: INPUT_WS, inputId: INPUT_ID, versionId: INPUT_VERSION, commandKey: body.commandKey, action: "input_transfer_finalize", replayed: false,
      receipt: { mode: transfer.mode, commandKey: body.commandKey, requestHash: "d".repeat(64), action: "input_transfer_finalize", inputId: INPUT_ID, versionId: INPUT_VERSION,
        transferId: INPUT_TRANSFER, transferNumber: 1, replacesTransferId: null, beforeRevision: body.expectedRevision, revision: 5, state: "verified", sizeBytes: 6,
        contentHash: body.expectedContentHash, reason: "", principal: inputPrincipal(), acceptedAt: INPUT_TIME }, current: transfer, version };
  });
});

function show(onOpenVersion = vi.fn(), props: Partial<React.ComponentProps<typeof CockpitInputUploadForm>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><I18nProvider locale="en" resources={{ en: { cockpit: enCockpit } }}>
    <CockpitInputUploadForm wsId={INPUT_WS} accountId={INPUT_MEMBER} meetingId={INPUT_MEETING} targetLabel="Project review" canAdd
      capabilities={{ workspaceId: INPUT_WS, canCreate: true, canBrowseNas: false, directUploadAvailable: true, fileCaptureAvailable: true, unavailableReason: "", maxFileBytes: 500 * 1024 * 1024, uploadSessionTtlSeconds: 86400 }}
      onOpenVersion={onOpenVersion} onCancel={vi.fn()} {...props} />
  </I18nProvider></QueryClientProvider>);
  return { ...view, client, onOpenVersion };
}
function chooseFile() {
  const file = new File(["sample"], "original-recording.wav", { type: "audio/wav" });
  fireEvent.change(screen.getByLabelText("Choose an original file"), { target: { files: [file] } });
  return file;
}

describe("original material upload", () => {
  it("keeps an unknown upload registration locked, then explicitly ends a rejected version without losing the created header", async () => {
    vi.mocked(api.submitCockpitInputVersion).mockRejectedValueOnce(new Error("Reply lost"))
      .mockRejectedValueOnce(new ApiError("Source rejected", 409, "Conflict", { code: "source_changed" }));
    vi.mocked(api.getCockpitInputVersionCommand).mockRejectedValue(new ApiError("No receipt", 404, "Not Found"));
    const cancel = vi.fn(); const view = show(vi.fn(), { onCancel: cancel });
    try {
      chooseFile(); fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.upload_and_fix }));
      await screen.findByText(enCockpit.input_materials.command_unconfirmed);
      expect(screen.queryByRole("button", { name: enCockpit.input_materials.end_registration })).toBeNull();
      const originalKey = useCockpitInputDraftStore.getState().draft.commands[key]!.body.commandKey;
      fireEvent.click(screen.getByRole("button", { name: enCockpit.input_materials.verify_command }));
      fireEvent.click(await screen.findByRole("button", { name: enCockpit.input_materials.retry_command }));
      const end = await screen.findByRole("button", { name: enCockpit.input_materials.end_registration }); await waitFor(() => expect(end).toBeEnabled());
      expect(vi.mocked(api.submitCockpitInputVersion).mock.calls.map((call) => call[2].commandKey)).toEqual([originalKey, originalKey]);
      fireEvent.click(end);
      const dialog = screen.getByRole("dialog", { name: enCockpit.input_materials.end_registration });
      fireEvent.change(within(dialog).getByRole("textbox", { name: enCockpit.input_materials.end_reason }), { target: { value: "This source is no longer needed" } });
      fireEvent.click(within(dialog).getByRole("button", { name: enCockpit.input_materials.end_registration }));
      expect(cancel).toHaveBeenCalledOnce();
      expect(useCockpitInputDraftStore.getState().draft.forms[key]).toBeUndefined();
      expect(cockpitEndedInputRegistrations(useCockpitInputDraftStore.getState().draft, INPUT_WS, INPUT_MEMBER, INPUT_MEETING)).toEqual([expect.objectContaining({ inputId: INPUT_ID, title: "original-recording.wav", sourcePath: "original-recording.wav", reason: "This source is no longer needed" })]);
      expect(api.createCockpitInput).toHaveBeenCalledTimes(1); expect(api.uploadCockpitInputBytes).not.toHaveBeenCalled();
    } finally { view.unmount(); view.client.clear(); }
  });

  it("restores the same borrowed fixed version with matching bytes and never submits a replacement version", async () => {
    const original = inputVersion();
    version = { ...original, availability: "unavailable", canDownload: false, canRestart: true, allowedRestartModes: ["upload_matching_bytes"],
      source: { ...original.source, kind: "artifact_version", artifactId: INPUT_ID, artifactVersionId: INPUT_VERSION, artifactDecision: "pending" } };
    vi.mocked(api.restartCockpitInputTransfer).mockImplementation(async (_ws, _input, _version, body) => {
      transfer = inputTransfer({ mode: "upload_matching_bytes" });
      version = { ...version, activeTransferId: INPUT_TRANSFER, latestTransferId: INPUT_TRANSFER, allowedRestartModes: [] };
      return { workspaceId: INPUT_WS, inputId: INPUT_ID, versionId: INPUT_VERSION, commandKey: body.commandKey, action: "input_transfer_restart", replayed: false,
        receipt: { mode: body.mode, commandKey: body.commandKey, requestHash: "e".repeat(64), action: "input_transfer_restart", inputId: INPUT_ID, versionId: INPUT_VERSION, transferId: INPUT_TRANSFER,
          transferNumber: 1, replacesTransferId: null, beforeRevision: body.expectedRevision, revision: 1, state: "awaiting_bytes", sizeBytes: 6, contentHash: original.contentHash, reason: "", principal: inputPrincipal(), acceptedAt: INPUT_TIME },
        current: null, version: null };
    });
    const view = show(vi.fn(), { existingInput: inputHeader({ currentVersion: version }), recoveryVersion: version, meetingId: undefined, canAdd: false });
    try {
      const restore = await screen.findByRole("button", { name: enCockpit.input_materials.provide_matching_copy });
      expect(restore).toBeDisabled();
      const file = new File(["sample"], "renamed-but-identical.wav", { type: "audio/wav" });
      fireEvent.change(screen.getByLabelText(enCockpit.input_materials.choose_recovery_file), { target: { files: [file] } });
      fireEvent.click(restore);
      await waitFor(() => expect(view.onOpenVersion).toHaveBeenCalledExactlyOnceWith(INPUT_ID, INPUT_VERSION));
      expect(api.restartCockpitInputTransfer).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_ID, INPUT_VERSION, expect.objectContaining({ mode: "upload_matching_bytes", previousTransferId: null }));
      expect(api.uploadCockpitInputBytes).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_ID, INPUT_VERSION, INPUT_TRANSFER, 1, file, undefined);
      expect(api.createCockpitInput).not.toHaveBeenCalled(); expect(api.submitCockpitInputVersion).not.toHaveBeenCalled();
    } finally { view.unmount(); view.client.clear(); }
  });

  it("records a historical creation receipt with no current projection after permission changes", async () => {
    vi.mocked(api.createCockpitInput).mockRejectedValueOnce(new TypeError("Connection lost"));
    vi.mocked(api.getCockpitInputCreateCommand).mockImplementation(async () => ({ ...createResult(vi.mocked(api.createCockpitInput).mock.calls[0]![1]), current: null, replayed: true }));
    vi.mocked(api.getCockpitInput).mockRejectedValue(new ApiError("Permission revoked", 403, "Forbidden"));
    const view = show();
    try {
      chooseFile(); fireEvent.click(screen.getByRole("button", { name: "Upload and save this version" }));
      const check = await screen.findByRole("button", { name: "Check the original operation" });
      await waitFor(() => expect(check).toBeEnabled()); fireEvent.click(check);
      expect(await screen.findByText(enCockpit.input_materials.registered_permission_changed)).toBeVisible();
      expect(useCockpitInputDraftStore.getState().draft.forms[key]?.inputId).toBe(INPUT_ID);
      expect(useCockpitInputDraftStore.getState().draft.commands[key]).toBeUndefined();
      expect(screen.getByRole("button", { name: "Continue uploading" })).toBeDisabled();
      expect(api.createCockpitInput).toHaveBeenCalledTimes(1);
      expect(api.submitCockpitInputVersion).not.toHaveBeenCalled();
      expect(view.onOpenVersion).not.toHaveBeenCalled();
    } finally { view.unmount(); view.client.clear(); }
  });

  it("registers an independent input and fixes its file without a meeting reference", async () => {
    const view = show();
    try {
      const file = chooseFile();
      fireEvent.click(screen.getByRole("button", { name: "Upload and save this version" }));
      await waitFor(() => expect(view.onOpenVersion).toHaveBeenCalledExactlyOnceWith(INPUT_ID, INPUT_VERSION));
      expect(api.createCockpitInput).toHaveBeenCalledExactlyOnceWith(INPUT_WS, expect.objectContaining({ title: file.name, projectId: null, originIssueId: null }));
      expect(api.submitCockpitInputVersion).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_ID, expect.objectContaining({ expectedRevision: 1 }));
      expect(vi.mocked(api.submitCockpitInputVersion).mock.calls[0]?.[2]).not.toHaveProperty("initialReference");
      expect(api.uploadCockpitInputBytes).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_ID, INPUT_VERSION, INPUT_TRANSFER, 1, file, undefined);
      expect(api.finalizeCockpitInputTransfer).toHaveBeenCalledExactlyOnceWith(INPUT_WS, INPUT_ID, INPUT_VERSION, INPUT_TRANSFER,
        expect.objectContaining({ expectedRevision: 4, expectedContentHash: "a".repeat(64) }));
      expect(useCockpitInputDraftStore.getState().draft.forms[key]).toBeUndefined();
    } finally { view.unmount(); view.client.clear(); }
  });

  it("keeps an unknown registration and only permits an explicit retry with its original command key", async () => {
    vi.mocked(api.createCockpitInput).mockRejectedValueOnce(new TypeError("Connection lost"));
    vi.mocked(api.getCockpitInputCreateCommand).mockRejectedValue(new ApiError("Not found yet", 404, "Not Found"));
    const view = show();
    try {
      chooseFile(); fireEvent.click(screen.getByRole("button", { name: "Upload and save this version" }));
      const verify = await screen.findByRole("button", { name: "Check the original operation" });
      await waitFor(() => expect(verify).toBeEnabled());
      const original = vi.mocked(api.createCockpitInput).mock.calls[0]![1];
      expect(useCockpitInputDraftStore.getState().draft.commands[key]?.body.commandKey).toBe(original.commandKey);
      fireEvent.click(verify);
      const retry = await screen.findByRole("button", { name: "Resubmit the same operation" });
      expect(api.createCockpitInput).toHaveBeenCalledTimes(1);
      expect(api.submitCockpitInputVersion).not.toHaveBeenCalled();
      fireEvent.click(retry);
      await waitFor(() => expect(api.createCockpitInput).toHaveBeenCalledTimes(2));
      expect(vi.mocked(api.createCockpitInput).mock.calls[1]![1]).toEqual(original);
      expect(useCockpitInputDraftStore.getState().draft.forms[key]?.inputId).toBe(INPUT_ID);
    } finally { view.unmount(); view.client.clear(); }
  });

  it("finishes an already received copy after reload without requesting the local file or uploading twice", async () => {
    vi.mocked(api.uploadCockpitInputBytes).mockImplementationOnce(async () => {
      transfer = inputTransfer({ mode: transfer.mode, state: "awaiting_finalize", revision: 4, receivedBytes: 6, pinnedSizeBytes: 6, contentHash: "a".repeat(64), canUpload: false, canFinalize: true });
      throw new TypeError("Upload response lost");
    });
    const first = show();
    chooseFile(); fireEvent.click(screen.getByRole("button", { name: "Upload and save this version" }));
    await screen.findByText("Upload response lost");
    first.unmount(); first.client.clear();
    expect(useCockpitInputDraftStore.getState().draft.forms[key]?.transferId).toBe(INPUT_TRANSFER);
    const second = show();
    try {
      const finish = await screen.findByRole("button", { name: "Finish registering this version" });
      expect(screen.queryByLabelText("Select the original file again")).toBeNull();
      expect(screen.getByText(enCockpit.input_materials.finalize_hint)).toBeVisible();
      fireEvent.click(finish);
      await waitFor(() => expect(second.onOpenVersion).toHaveBeenCalledExactlyOnceWith(INPUT_ID, INPUT_VERSION));
      expect(api.uploadCockpitInputBytes).toHaveBeenCalledTimes(1);
      expect(api.createCockpitInput).toHaveBeenCalledTimes(1);
      expect(api.submitCockpitInputVersion).toHaveBeenCalledTimes(1);
    } finally { second.unmount(); second.client.clear(); }
  });
});
