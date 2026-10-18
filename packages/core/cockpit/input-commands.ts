import type {
  CockpitInputCreateInput, CockpitInputCreateResult, CockpitInputVersionSubmitInput, CockpitInputVersionResult,
  CockpitInputRestartInput, CockpitInputFinalizeInput, CockpitInputAbandonInput, CockpitInputTransferResult,
  CockpitInputManifestSaveInput, CockpitInputManifestResult,
  CockpitInputSourceInput,
} from "../types/cockpit-input";

function sameSource(actual: CockpitInputSourceInput, expected: CockpitInputSourceInput): boolean {
  if (actual.kind !== expected.kind) return false;
  switch (expected.kind) {
    case "upload": return Boolean(actual.upload && expected.upload && actual.upload.filename === expected.upload.filename
      && actual.upload.contentType === expected.upload.contentType && actual.upload.sizeBytes === expected.upload.sizeBytes
      && actual.upload.clientSha256 === expected.upload.clientSha256);
    case "nas_file": return Boolean(actual.nasFile && expected.nasFile && actual.nasFile.rootId === expected.nasFile.rootId
      && actual.nasFile.relativePath === expected.nasFile.relativePath && actual.nasFile.observationToken === expected.nasFile.observationToken);
    case "attachment": return Boolean(actual.attachment && expected.attachment && actual.attachment.issueId === expected.attachment.issueId
      && actual.attachment.attachmentId === expected.attachment.attachmentId);
    case "artifact_version": return Boolean(actual.artifactVersion && expected.artifactVersion && actual.artifactVersion.artifactId === expected.artifactVersion.artifactId
      && actual.artifactVersion.versionId === expected.artifactVersion.versionId);
    default: return false;
  }
}

export function cockpitInputCreateAcknowledged(result: CockpitInputCreateResult, body: CockpitInputCreateInput): boolean {
  const receipt = result.receipt;
  return result.action === "input_create" && result.commandKey === body.commandKey && receipt.commandKey === body.commandKey
    && receipt.title === body.title.trim() && receipt.description === body.description
    && receipt.projectId === body.projectId && receipt.originIssueId === body.originIssueId;
}

/** Later current progress is not evidence that this exact submission succeeded. */
export function cockpitInputVersionAcknowledged(result: CockpitInputVersionResult, inputId: string, body: CockpitInputVersionSubmitInput): boolean {
  const r = result.receipt;
  if (result.action !== "input_version_submit" || result.commandKey !== body.commandKey || r.commandKey !== body.commandKey
    || r.inputId !== inputId || !sameSource(r.source, body.source) || r.inputRevision !== body.expectedRevision + 1) return false;
  return true;
}

export function cockpitInputTransferAcknowledged(result: CockpitInputTransferResult, inputId: string, versionId: string,
  body: CockpitInputRestartInput | CockpitInputFinalizeInput | CockpitInputAbandonInput, transferId?: string): boolean {
  const r = result.receipt;
  if (result.commandKey !== body.commandKey || r.commandKey !== body.commandKey || r.action !== result.action
    || r.inputId !== inputId || r.versionId !== versionId || transferId && r.transferId !== transferId) return false;
  if ("previousTransferId" in body) return result.action === "input_transfer_restart" && r.mode === body.mode && r.replacesTransferId === body.previousTransferId
    && r.transferId !== body.previousTransferId && r.reason === body.reason.trim() && ["awaiting_bytes", "queued"].includes(r.state);
  if (r.beforeRevision !== body.expectedRevision) return false;
  if ("expectedContentHash" in body) return result.action === "input_transfer_finalize" && r.state === "verified" && r.contentHash === body.expectedContentHash;
  return result.action === "input_transfer_abandon" && r.state === "abandoned" && r.reason === body.reason.trim();
}


export function cockpitInputManifestAcknowledged(result: CockpitInputManifestResult, issueId: string, body: CockpitInputManifestSaveInput): boolean {
  const r = result.receipt;
  return result.action === "input_manifest_save" && result.commandKey === body.commandKey && r.commandKey === body.commandKey
    && r.issueId === issueId && r.revision === body.expectedRevision + 1 && r.note === body.note && r.items.length === body.items.length
    && r.items.every((item, index) => item.inputVersionId === body.items[index]?.inputVersionId && item.purpose === body.items[index]?.purpose && item.required === body.items[index]?.required);
}
