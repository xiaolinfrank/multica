import type { CockpitInputHeader, CockpitInputPrincipal, CockpitInputTransferDetail, CockpitInputVersionMetadata } from "@multica/core/types/cockpit-input";

export const INPUT_WS = "b1000000-0000-4000-8000-000000000001";
export const INPUT_ID = "b1000000-0000-4000-8000-000000000002";
export const INPUT_VERSION = "b1000000-0000-4000-8000-000000000003";
export const INPUT_MEETING = "b1000000-0000-4000-8000-000000000004";
export const INPUT_REFERENCE = "b1000000-0000-4000-8000-000000000005";
export const INPUT_MEMBER = "b1000000-0000-4000-8000-000000000006";
export const INPUT_KEY = "b1000000-0000-4000-8000-000000000007";
export const INPUT_TRANSFER = "b1000000-0000-4000-8000-000000000008";
export const INPUT_TIME = "2026-10-11T10:00:00Z";

export function inputPrincipal(patch: Partial<CockpitInputPrincipal> = {}): CockpitInputPrincipal {
  return { actorType: "member", actorId: INPUT_MEMBER, actorName: "Meeting owner", credentialOwnerUserId: INPUT_MEMBER, authorizingUserId: INPUT_MEMBER,
    authorizingUserName: "Meeting owner", agentId: null, runId: null, issueId: null, runtimeId: null, ...patch };
}

export function inputVersion(patch: Partial<CockpitInputVersionMetadata> = {}): CockpitInputVersionMetadata {
  return { workspaceId: INPUT_WS, inputId: INPUT_ID, id: INPUT_VERSION, versionNumber: 1, submissionKey: INPUT_KEY, revision: 1, payloadKind: "file",
    source: { kind: "upload", issue: null, attachmentId: null, rootId: null, relativePath: null, artifactId: null, artifactTitle: "", artifactVersionId: null,
      artifactVersionNumber: null, artifactDecision: null, sourceAvailable: false, sourceUnavailableReason: "local_source_not_checked" },
    submittedBy: inputPrincipal(), filename: "original-recording.wav", contentType: "audio/wav", declaredSizeBytes: 6, sizeBytes: 6, contentHash: "a".repeat(64),
    captureState: "ready", captureErrorCode: "", availability: "available", checkedAt: INPUT_TIME, unavailableReason: "", activeTransferId: null, acceptedTransferId: null, currentTransferId: null,
    latestTransferId: null, allowedRestartModes: [],
    createdAt: INPUT_TIME, readyAt: INPUT_TIME, canDownload: true, canRestart: false, canReference: true, canVerify: true, blockedReasons: [], ...patch };
}

export function inputHeader(patch: Partial<CockpitInputHeader> = {}): CockpitInputHeader {
  return { workspaceId: INPUT_WS, id: INPUT_ID, creationKey: INPUT_KEY, title: "Original meeting recording", description: "", projectId: null, originIssue: null,
    revision: 1, registeredBy: inputPrincipal(), createdAt: INPUT_TIME, updatedAt: INPUT_TIME, archivedAt: null, currentVersion: null, versionTotal: 0, referenceTotal: 0,
    canEdit: true, canSubmit: true, canArchive: true, canUnarchive: false, blockedReasons: [], ...patch };
}

export function inputTransfer(patch: Partial<CockpitInputTransferDetail> = {}): CockpitInputTransferDetail {
  return { workspaceId: INPUT_WS, inputId: INPUT_ID, versionId: INPUT_VERSION, id: INPUT_TRANSFER, transferNumber: 1, commandKey: INPUT_KEY, kind: "direct_upload", mode: "initial",
    state: "awaiting_bytes", revision: 1, principal: inputPrincipal(), receivedBytes: null, expectedBytes: 6, pinnedSizeBytes: null, contentHash: null,
    sessionExpiresAt: "2026-10-12T10:00:00Z", leaseExpiresAt: null, createdAt: INPUT_TIME, finishedAt: null, errorCode: "", errorMessage: "",
    canUpload: true, canRestart: false, canFinalize: false, canAbandon: true, blockedReasons: [], ...patch };
}
