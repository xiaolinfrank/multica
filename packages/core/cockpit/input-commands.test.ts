// @vitest-environment node
import { expect, it } from "vitest";
import type { CockpitInputVersionResult, CockpitInputVersionSubmitInput } from "../types/cockpit-input";
import { cockpitInputVersionAcknowledged } from "./input-commands";

it("acknowledges the exact uploaded filename without silently trimming it", () => {
  const body: CockpitInputVersionSubmitInput = { commandKey: "command", expectedRevision: 3,
    source: { kind: "upload", upload: { filename: " meeting notes.txt ", contentType: "text/plain", sizeBytes: 2, clientSha256: null } } };
  const result: CockpitInputVersionResult = { workspaceId: "workspace", inputId: "input", commandKey: body.commandKey,
    action: "input_version_submit", replayed: false, current: null, transfer: null,
    receipt: { commandKey: body.commandKey, requestHash: "hash", inputId: "input", versionId: "version", versionNumber: 1,
      inputRevision: 4, source: body.source, payloadKind: "file", captureState: "awaiting_upload", transferId: "transfer", transferRevision: 1,
      acceptedAt: "2026-10-12T00:00:00Z", principal: { actorType: "member", actorId: "user", actorName: "User",
        credentialOwnerUserId: "user", authorizingUserId: "user", authorizingUserName: "User", agentId: null, runId: null, issueId: null, runtimeId: null } } };
  expect(cockpitInputVersionAcknowledged(result, "input", body)).toBe(true);
  const changed = { ...result, receipt: { ...result.receipt, source: { kind: "upload", upload: { ...body.source.upload!, filename: "meeting notes.txt" } } } };
  expect(cockpitInputVersionAcknowledged(changed, "input", body)).toBe(false);
});
