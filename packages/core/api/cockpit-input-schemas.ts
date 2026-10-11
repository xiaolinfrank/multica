import { z } from "zod";

const id = z.string().uuid();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const capability = z.boolean().catch(false).default(false);

function safeInputDownload(url: string, versionId: string): boolean {
  if (!url.startsWith("/api/cockpit/input-files/") || /[\s\\]/.test(url)) return false;
  try {
    const parsed = new URL(url, "https://input.invalid");
    return parsed.origin === "https://input.invalid" && parsed.pathname === `/api/cockpit/input-files/${encodeURIComponent(versionId)}/download`
      && !parsed.hash && parsed.searchParams.getAll("token").length === 1 && Boolean(parsed.searchParams.get("token")) && [...parsed.searchParams.keys()].every((key) => key === "token");
  } catch { return false; }
}

const CockpitInputIssueSummaryWire = z.object({
  id: id,
  identifier: z.string(),
  title: z.string(),
  status: z.string(),
  status_category: z.string(),
  priority: z.string(),
  assignee_type: z.string().nullable(),
  assignee_id: id.nullable(),
  assignee_name: z.string(),
  due_date: z.string().nullable(),
  project_id: id.nullable(),
  module_id: id.nullable(),
  primary_node_id: id.nullable(),
  primary_node_code: z.string(),
  primary_node_name: z.string(),
  primary_revision: count,
  creation_key: id.nullable(),
});
export const CockpitInputIssueSummarySchema = CockpitInputIssueSummaryWire.transform((value) => ({
  id: value.id,
  identifier: value.identifier,
  title: value.title,
  status: value.status,
  statusCategory: value.status_category,
  priority: value.priority,
  assigneeType: value.assignee_type,
  assigneeId: value.assignee_id,
  assigneeName: value.assignee_name,
  dueDate: value.due_date,
  projectId: value.project_id,
  moduleId: value.module_id,
  primaryNodeId: value.primary_node_id,
  primaryNodeCode: value.primary_node_code,
  primaryNodeName: value.primary_node_name,
  primaryRevision: value.primary_revision,
  creationKey: value.creation_key,
}));

const CockpitInputPrincipalWire = z.object({
  actor_type: z.string(),
  actor_id: id,
  actor_name: z.string(),
  credential_owner_user_id: id,
  authorizing_user_id: id,
  authorizing_user_name: z.string(),
  agent_id: id.nullable(),
  run_id: id.nullable(),
  issue_id: id.nullable(),
  runtime_id: id.nullable(),
});
export const CockpitInputPrincipalSchema = CockpitInputPrincipalWire.transform((value) => ({
  actorType: value.actor_type,
  actorId: value.actor_id,
  actorName: value.actor_name,
  credentialOwnerUserId: value.credential_owner_user_id,
  authorizingUserId: value.authorizing_user_id,
  authorizingUserName: value.authorizing_user_name,
  agentId: value.agent_id,
  runId: value.run_id,
  issueId: value.issue_id,
  runtimeId: value.runtime_id,
})).refine((p) => p.actorType !== "member" || p.actorId === p.credentialOwnerUserId && p.actorId === p.authorizingUserId && !p.agentId && !p.runId && !p.issueId && !p.runtimeId).refine((p) => p.actorType !== "agent" || p.actorId === p.agentId && Boolean(p.runId && p.issueId && p.runtimeId));

const CockpitInputScopeWire = z.object({
  ids: z.array(id).max(200),
  project_id: id.nullable(),
  meeting_id: id.nullable(),
  agenda_id: id.nullable(),
  origin_issue_id: id.nullable(),
  q: z.string(),
  archive: z.string(),
  source_kind: z.string(),
});
export const CockpitInputScopeSchema = CockpitInputScopeWire.transform((value) => ({
  ids: value.ids,
  projectId: value.project_id,
  meetingId: value.meeting_id,
  agendaId: value.agenda_id,
  originIssueId: value.origin_issue_id,
  q: value.q,
  archive: value.archive,
  sourceKind: value.source_kind,
}));

const CockpitInputCapabilitiesWire = z.object({
  workspace_id: id,
  can_create: capability,
  can_browse_nas: capability,
  direct_upload_available: capability,
  file_capture_available: capability,
  unavailable_reason: z.string(),
  max_file_bytes: count,
  upload_session_ttl_seconds: count,
});
export const CockpitInputCapabilitiesSchema = CockpitInputCapabilitiesWire.transform((value) => ({
  workspaceId: value.workspace_id,
  canCreate: value.can_create,
  canBrowseNas: value.can_browse_nas,
  directUploadAvailable: value.direct_upload_available,
  fileCaptureAvailable: value.file_capture_available,
  unavailableReason: value.unavailable_reason,
  maxFileBytes: value.max_file_bytes,
  uploadSessionTtlSeconds: value.upload_session_ttl_seconds,
}));

const CockpitInputSourceMetadataWire = z.object({
  kind: z.string(),
  issue: CockpitInputIssueSummarySchema.nullable(),
  attachment_id: id.nullable(),
  root_id: id.nullable(),
  relative_path: z.string().nullable(),
  artifact_id: id.nullable(),
  artifact_title: z.string(),
  artifact_version_id: id.nullable(),
  artifact_version_number: count.nullable(),
  artifact_decision: z.string().nullable(),
  source_available: capability,
  source_unavailable_reason: z.string(),
});
export const CockpitInputSourceMetadataSchema = CockpitInputSourceMetadataWire.transform((value) => ({
  kind: value.kind,
  issue: value.issue,
  attachmentId: value.attachment_id,
  rootId: value.root_id,
  relativePath: value.relative_path,
  artifactId: value.artifact_id,
  artifactTitle: value.artifact_title,
  artifactVersionId: value.artifact_version_id,
  artifactVersionNumber: value.artifact_version_number,
  artifactDecision: value.artifact_decision,
  sourceAvailable: value.source_available,
  sourceUnavailableReason: value.source_unavailable_reason,
}));

const CockpitInputVersionMetadataWire = z.object({
  latest_transfer_id: id.nullable().default(null),
  allowed_restart_modes: z.array(z.string()).max(10).default([]),
  current_transfer_id: id.nullable(),
  workspace_id: id,
  input_id: id,
  id: id,
  version_number: count,
  submission_key: id,
  revision: count,
  payload_kind: z.string(),
  source: CockpitInputSourceMetadataSchema,
  submitted_by: CockpitInputPrincipalSchema,
  filename: z.string(),
  content_type: z.string(),
  declared_size_bytes: count.nullable(),
  size_bytes: count.nullable(),
  content_hash: hash.nullable(),
  capture_state: z.string(),
  capture_error_code: z.string(),
  availability: z.string(),
  checked_at: z.string().datetime({ offset: true }).nullable(),
  unavailable_reason: z.string(),
  active_transfer_id: id.nullable(),
  accepted_transfer_id: id.nullable(),
  created_at: z.string().datetime({ offset: true }),
  ready_at: z.string().datetime({ offset: true }).nullable(),
  can_download: capability,
  can_restart: capability,
  can_reference: capability,
  can_verify: capability,
  blocked_reasons: z.array(z.string()).max(1000),
});
export const CockpitInputVersionMetadataSchema = CockpitInputVersionMetadataWire.transform((value) => ({
  latestTransferId: value.latest_transfer_id,
  allowedRestartModes: value.allowed_restart_modes,
  currentTransferId: value.current_transfer_id,
  workspaceId: value.workspace_id,
  inputId: value.input_id,
  id: value.id,
  versionNumber: value.version_number,
  submissionKey: value.submission_key,
  revision: value.revision,
  payloadKind: value.payload_kind,
  source: value.source,
  submittedBy: value.submitted_by,
  filename: value.filename,
  contentType: value.content_type,
  declaredSizeBytes: value.declared_size_bytes,
  sizeBytes: value.size_bytes,
  contentHash: value.content_hash,
  captureState: value.capture_state,
  captureErrorCode: value.capture_error_code,
  availability: value.availability,
  checkedAt: value.checked_at,
  unavailableReason: value.unavailable_reason,
  activeTransferId: value.active_transfer_id,
  acceptedTransferId: value.accepted_transfer_id,
  createdAt: value.created_at,
  readyAt: value.ready_at,
  canDownload: value.can_download,
  canRestart: value.can_restart,
  canReference: value.can_reference,
  canVerify: value.can_verify,
  blockedReasons: value.blocked_reasons,
})).refine((v) => (v.sizeBytes === null) === (v.contentHash === null) && (v.captureState !== "ready" || v.contentHash !== null && v.readyAt !== null)).transform((v) => ["awaiting_upload", "queued", "capturing", "ready", "needs_attention"].includes(v.captureState) && ["file", "text"].includes(v.payloadKind) && ["upload", "nas_file", "attachment", "artifact_version"].includes(v.source.kind) && ["member", "agent"].includes(v.submittedBy.actorType) ? { ...v, canDownload: v.canDownload && v.captureState === "ready", allowedRestartModes: v.allowedRestartModes.filter((mode) => ["retry_source", "upload_matching_bytes"].includes(mode)), canRestart: v.canRestart && v.allowedRestartModes.some((mode) => ["retry_source", "upload_matching_bytes"].includes(mode)) } : { ...v, canDownload: false, canRestart: false, allowedRestartModes: [], canReference: false, canVerify: false });

const CockpitInputHeaderWire = z.object({
  workspace_id: id,
  id: id,
  creation_key: id,
  title: z.string(),
  description: z.string(),
  project_id: id.nullable(),
  origin_issue: CockpitInputIssueSummarySchema.nullable(),
  revision: count,
  registered_by: CockpitInputPrincipalSchema,
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  archived_at: z.string().datetime({ offset: true }).nullable(),
  current_version: CockpitInputVersionMetadataSchema.nullable(),
  version_total: count,
  reference_total: count,
  can_edit: capability,
  can_submit: capability,
  can_archive: capability,
  can_unarchive: capability,
  blocked_reasons: z.array(z.string()).max(1000),
});
export const CockpitInputHeaderSchema = CockpitInputHeaderWire.transform((value) => ({
  workspaceId: value.workspace_id,
  id: value.id,
  creationKey: value.creation_key,
  title: value.title,
  description: value.description,
  projectId: value.project_id,
  originIssue: value.origin_issue,
  revision: value.revision,
  registeredBy: value.registered_by,
  createdAt: value.created_at,
  updatedAt: value.updated_at,
  archivedAt: value.archived_at,
  currentVersion: value.current_version,
  versionTotal: value.version_total,
  referenceTotal: value.reference_total,
  canEdit: value.can_edit,
  canSubmit: value.can_submit,
  canArchive: value.can_archive,
  canUnarchive: value.can_unarchive,
  blockedReasons: value.blocked_reasons,
})).refine((h) => !h.currentVersion || h.currentVersion.inputId === h.id && h.currentVersion.workspaceId === h.workspaceId && h.versionTotal > 0).transform((h) => ["member", "agent"].includes(h.registeredBy.actorType) ? h : { ...h, canEdit: false, canSubmit: false, canArchive: false, canUnarchive: false });

const CockpitInputPageWire = z.object({
  workspace_id: id,
  scope: CockpitInputScopeSchema,
  page_size: count,
  items: z.array(CockpitInputHeaderSchema).max(200),
  total: count,
  next_cursor: z.string().nullable(),
  can_create: capability,
});
export const CockpitInputPageSchema = CockpitInputPageWire.transform((value) => ({
  workspaceId: value.workspace_id,
  scope: value.scope,
  pageSize: value.page_size,
  items: value.items,
  total: value.total,
  nextCursor: value.next_cursor,
  canCreate: value.can_create,
})).refine((p) => p.pageSize >= 1 && p.pageSize <= 100 && p.items.length <= p.pageSize && p.total >= p.items.length).refine((p) => p.items.every((i) => i.workspaceId === p.workspaceId)).refine((p) => new Set(p.items.map((i) => i.id)).size === p.items.length);

const CockpitInputCreateInputWire = z.object({
  command_key: id,
  title: z.string(),
  description: z.string(),
  project_id: id.nullable(),
  origin_issue_id: id.nullable(),
});
export const CockpitInputCreateInputSchema = CockpitInputCreateInputWire.transform((value) => ({
  commandKey: value.command_key,
  title: value.title,
  description: value.description,
  projectId: value.project_id,
  originIssueId: value.origin_issue_id,
}));

const CockpitInputCreateReceiptWire = z.object({
  input_revision: z.literal(1),
  command_key: id,
  request_hash: hash,
  input_id: id,
  title: z.string(),
  description: z.string(),
  project_id: id.nullable(),
  origin_issue_id: id.nullable(),
  principal: CockpitInputPrincipalSchema,
  created_at: z.string().datetime({ offset: true }),
});
export const CockpitInputCreateReceiptSchema = CockpitInputCreateReceiptWire.transform((value) => ({
  inputRevision: value.input_revision,
  commandKey: value.command_key,
  requestHash: value.request_hash,
  inputId: value.input_id,
  title: value.title,
  description: value.description,
  projectId: value.project_id,
  originIssueId: value.origin_issue_id,
  principal: value.principal,
  createdAt: value.created_at,
}));

const CockpitInputCreateResultWire = z.object({
  workspace_id: id,
  command_key: id,
  action: z.string(),
  replayed: z.boolean(),
  receipt: CockpitInputCreateReceiptSchema,
  current: CockpitInputHeaderSchema.nullable(),
});
export const CockpitInputCreateResultSchema = CockpitInputCreateResultWire.transform((value) => ({
  workspaceId: value.workspace_id,
  commandKey: value.command_key,
  action: value.action,
  replayed: value.replayed,
  receipt: value.receipt,
  current: value.current,
})).refine((r) => r.commandKey === r.receipt.commandKey && (!r.current || r.current.workspaceId === r.workspaceId)).refine((r) => r.action === "input_create" && (!r.current || r.receipt.inputId === r.current.id));

const CockpitInputEditInputWire = z.object({
  expected_revision: count,
  title: z.string(),
  description: z.string(),
});
export const CockpitInputEditInputSchema = CockpitInputEditInputWire.transform((value) => ({
  expectedRevision: value.expected_revision,
  title: value.title,
  description: value.description,
}));

const CockpitInputArchiveInputWire = z.object({
  expected_revision: count,
  archived: z.boolean(),
});
export const CockpitInputArchiveInputSchema = CockpitInputArchiveInputWire.transform((value) => ({
  expectedRevision: value.expected_revision,
  archived: value.archived,
}));

const CockpitInputUploadSourceWire = z.object({
  filename: z.string(),
  content_type: z.string(),
  size_bytes: count,
  client_sha256: hash.nullable(),
});
export const CockpitInputUploadSourceSchema = CockpitInputUploadSourceWire.transform((value) => ({
  filename: value.filename,
  contentType: value.content_type,
  sizeBytes: value.size_bytes,
  clientSha256: value.client_sha256,
}));

const CockpitInputNASSourceWire = z.object({
  root_id: id,
  relative_path: z.string(),
  observation_token: z.string(),
});
export const CockpitInputNASSourceSchema = CockpitInputNASSourceWire.transform((value) => ({
  rootId: value.root_id,
  relativePath: value.relative_path,
  observationToken: value.observation_token,
}));

const CockpitInputAttachmentSourceWire = z.object({
  issue_id: id,
  attachment_id: id,
});
export const CockpitInputAttachmentSourceSchema = CockpitInputAttachmentSourceWire.transform((value) => ({
  issueId: value.issue_id,
  attachmentId: value.attachment_id,
}));

const CockpitInputArtifactSourceWire = z.object({
  artifact_id: id,
  version_id: id,
});
export const CockpitInputArtifactSourceSchema = CockpitInputArtifactSourceWire.transform((value) => ({
  artifactId: value.artifact_id,
  versionId: value.version_id,
}));

const CockpitInputSourceInputWire = z.object({
  kind: z.string(),
  upload: CockpitInputUploadSourceSchema.nullable().optional(),
  nas_file: CockpitInputNASSourceSchema.nullable().optional(),
  attachment: CockpitInputAttachmentSourceSchema.nullable().optional(),
  artifact_version: CockpitInputArtifactSourceSchema.nullable().optional(),
});
export const CockpitInputSourceInputSchema = CockpitInputSourceInputWire.transform((value) => ({
  kind: value.kind,
  upload: value.upload,
  nasFile: value.nas_file,
  attachment: value.attachment,
  artifactVersion: value.artifact_version,
})).refine((s) => [s.upload, s.nasFile, s.attachment, s.artifactVersion].filter(Boolean).length === 1 && Boolean(s.kind === "upload" && s.upload || s.kind === "nas_file" && s.nasFile || s.kind === "attachment" && s.attachment || s.kind === "artifact_version" && s.artifactVersion));

const CockpitInputVersionDetailWire = z.object({
  workspace_id: id,
  input_id: id,
  version: CockpitInputVersionMetadataSchema,
  content: z.string().nullable(),
  capture_error: z.string(),
});
export const CockpitInputVersionDetailSchema = CockpitInputVersionDetailWire.transform((value) => ({
  workspaceId: value.workspace_id,
  inputId: value.input_id,
  version: value.version,
  content: value.content,
  captureError: value.capture_error,
})).refine((d) => d.version.workspaceId === d.workspaceId && d.version.inputId === d.inputId && (d.version.payloadKind !== "file" || d.content === null));

const CockpitInputVersionPageWire = z.object({
  workspace_id: id,
  input_id: id,
  page_size: count,
  items: z.array(CockpitInputVersionMetadataSchema).max(200),
  total: count,
  next_cursor: z.string().nullable(),
});
export const CockpitInputVersionPageSchema = CockpitInputVersionPageWire.transform((value) => ({
  workspaceId: value.workspace_id,
  inputId: value.input_id,
  pageSize: value.page_size,
  items: value.items,
  total: value.total,
  nextCursor: value.next_cursor,
})).refine((p) => p.pageSize >= 1 && p.pageSize <= 100 && p.items.length <= p.pageSize && p.total >= p.items.length).refine((p) => p.items.every((i) => i.workspaceId === p.workspaceId)).refine((p) => p.items.every((i) => i.inputId === p.inputId));

const CockpitInputInitialReferenceWire = z.object({
  reference_key: id,
  meeting_id: id,
  agenda_id: id.nullable(),
  purpose: z.string(),
});
export const CockpitInputInitialReferenceSchema = CockpitInputInitialReferenceWire.transform((value) => ({
  referenceKey: value.reference_key,
  meetingId: value.meeting_id,
  agendaId: value.agenda_id,
  purpose: value.purpose,
}));

const CockpitInputVersionSubmitInputWire = z.object({
  command_key: id,
  expected_revision: count,
  source: CockpitInputSourceInputSchema,
  initial_reference: CockpitInputInitialReferenceSchema.nullable(),
});
export const CockpitInputVersionSubmitInputSchema = CockpitInputVersionSubmitInputWire.transform((value) => ({
  commandKey: value.command_key,
  expectedRevision: value.expected_revision,
  source: value.source,
  initialReference: value.initial_reference,
}));

const CockpitInputReferenceReceiptWire = z.object({
  command_key: id,
  request_hash: hash,
  reference_id: id,
  meeting_id: id,
  agenda_id: id.nullable(),
  input_id: id,
  input_version_id: id,
  purpose: z.string(),
  removed: z.boolean(),
  principal: CockpitInputPrincipalSchema,
  accepted_at: z.string().datetime({ offset: true }),
});
export const CockpitInputReferenceReceiptSchema = CockpitInputReferenceReceiptWire.transform((value) => ({
  commandKey: value.command_key,
  requestHash: value.request_hash,
  referenceId: value.reference_id,
  meetingId: value.meeting_id,
  agendaId: value.agenda_id,
  inputId: value.input_id,
  inputVersionId: value.input_version_id,
  purpose: value.purpose,
  removed: value.removed,
  principal: value.principal,
  acceptedAt: value.accepted_at,
}));

const CockpitInputVersionReceiptWire = z.object({
  transfer_revision: z.literal(1).nullable(),
  command_key: id,
  request_hash: hash,
  input_id: id,
  version_id: id,
  version_number: count,
  input_revision: count,
  source: CockpitInputSourceInputSchema,
  payload_kind: z.string(),
  capture_state: z.string(),
  transfer_id: id.nullable(),
  initial_reference: CockpitInputReferenceReceiptSchema.nullable(),
  principal: CockpitInputPrincipalSchema,
  accepted_at: z.string().datetime({ offset: true }),
});
export const CockpitInputVersionReceiptSchema = CockpitInputVersionReceiptWire.transform((value) => ({
  transferRevision: value.transfer_revision,
  commandKey: value.command_key,
  requestHash: value.request_hash,
  inputId: value.input_id,
  versionId: value.version_id,
  versionNumber: value.version_number,
  inputRevision: value.input_revision,
  source: value.source,
  payloadKind: value.payload_kind,
  captureState: value.capture_state,
  transferId: value.transfer_id,
  initialReference: value.initial_reference,
  principal: value.principal,
  acceptedAt: value.accepted_at,
})).refine((r) => (r.transferId === null) === (r.transferRevision === null));

const CockpitInputTransferMetadataWire = z.object({
  mode: z.string(),
  workspace_id: id,
  input_id: id,
  version_id: id,
  id: id,
  transfer_number: count,
  command_key: id,
  kind: z.string(),
  state: z.string(),
  revision: count,
  principal: CockpitInputPrincipalSchema,
  received_bytes: count.nullable(),
  expected_bytes: count,
  pinned_size_bytes: count.nullable(),
  content_hash: hash.nullable(),
  session_expires_at: z.string().datetime({ offset: true }).nullable(),
  lease_expires_at: z.string().datetime({ offset: true }).nullable(),
  created_at: z.string().datetime({ offset: true }),
  finished_at: z.string().datetime({ offset: true }).nullable(),
  error_code: z.string(),
  can_upload: capability,
  can_restart: capability,
  can_finalize: capability,
  can_abandon: capability,
  blocked_reasons: z.array(z.string()).max(1000),
});
export const CockpitInputTransferMetadataSchema = CockpitInputTransferMetadataWire.transform((value) => ({
  mode: value.mode,
  workspaceId: value.workspace_id,
  inputId: value.input_id,
  versionId: value.version_id,
  id: value.id,
  transferNumber: value.transfer_number,
  commandKey: value.command_key,
  kind: value.kind,
  state: value.state,
  revision: value.revision,
  principal: value.principal,
  receivedBytes: value.received_bytes,
  expectedBytes: value.expected_bytes,
  pinnedSizeBytes: value.pinned_size_bytes,
  contentHash: value.content_hash,
  sessionExpiresAt: value.session_expires_at,
  leaseExpiresAt: value.lease_expires_at,
  createdAt: value.created_at,
  finishedAt: value.finished_at,
  errorCode: value.error_code,
  canUpload: value.can_upload,
  canRestart: value.can_restart,
  canFinalize: value.can_finalize,
  canAbandon: value.can_abandon,
  blockedReasons: value.blocked_reasons,
})).refine((t) => (t.pinnedSizeBytes === null) === (t.contentHash === null) && (!["pinned", "writing", "verifying", "awaiting_finalize", "verified"].includes(t.state) || t.contentHash !== null)).transform((t) => ["awaiting_bytes", "queued", "reading", "pinned", "writing", "verifying", "awaiting_finalize", "verified", "failed", "abandoned", "expired"].includes(t.state) && ["direct_upload", "source_capture"].includes(t.kind) && ["initial", "retry_source", "upload_matching_bytes"].includes(t.mode) && ["member", "agent"].includes(t.principal.actorType) ? { ...t, canUpload: t.canUpload && t.state === "awaiting_bytes" && t.kind === "direct_upload", canFinalize: t.canFinalize && t.state === "awaiting_finalize" } : { ...t, canUpload: false, canRestart: false, canFinalize: false, canAbandon: false });

const CockpitInputVersionResultWire = z.object({
  workspace_id: id,
  input_id: id,
  command_key: id,
  action: z.string(),
  replayed: z.boolean(),
  receipt: CockpitInputVersionReceiptSchema,
  current: CockpitInputVersionMetadataSchema.nullable(),
  transfer: CockpitInputTransferMetadataSchema.nullable(),
});
export const CockpitInputVersionResultSchema = CockpitInputVersionResultWire.transform((value) => ({
  workspaceId: value.workspace_id,
  inputId: value.input_id,
  commandKey: value.command_key,
  action: value.action,
  replayed: value.replayed,
  receipt: value.receipt,
  current: value.current,
  transfer: value.transfer,
})).refine((r) => r.commandKey === r.receipt.commandKey && (!r.current || r.current.workspaceId === r.workspaceId)).refine((r) => r.action === "input_version_submit" && r.inputId === r.receipt.inputId && (!r.current || r.current.inputId === r.inputId && r.current.id === r.receipt.versionId) && (!r.transfer || r.transfer.id === r.receipt.transferId && r.transfer.workspaceId === r.workspaceId && r.transfer.versionId === r.receipt.versionId));

export const CockpitInputTransferDetailSchema = CockpitInputTransferMetadataSchema.and(z.object({ error_message: z.string() }).transform((value) => ({ errorMessage: value.error_message })));


const CockpitInputTransferPageWire = z.object({
  workspace_id: id,
  input_id: id,
  version_id: id,
  page_size: count,
  items: z.array(CockpitInputTransferMetadataSchema).max(200),
  total: count,
  next_cursor: z.string().nullable(),
});
export const CockpitInputTransferPageSchema = CockpitInputTransferPageWire.transform((value) => ({
  workspaceId: value.workspace_id,
  inputId: value.input_id,
  versionId: value.version_id,
  pageSize: value.page_size,
  items: value.items,
  total: value.total,
  nextCursor: value.next_cursor,
})).refine((p) => p.pageSize >= 1 && p.pageSize <= 100 && p.items.length <= p.pageSize && p.total >= p.items.length).refine((p) => p.items.every((i) => i.workspaceId === p.workspaceId)).refine((p) => p.items.every((i) => i.inputId === p.inputId)).refine((p) => p.items.every((i) => i.versionId === p.versionId));

const CockpitInputRestartInputWire = z.object({
  mode: z.enum(["retry_source", "upload_matching_bytes"]),
  command_key: id,
  expected_revision: count,
  previous_transfer_id: id.nullable(),
  reason: z.string(),
});
export const CockpitInputRestartInputSchema = CockpitInputRestartInputWire.transform((value) => ({
  mode: value.mode,
  commandKey: value.command_key,
  expectedRevision: value.expected_revision,
  previousTransferId: value.previous_transfer_id,
  reason: value.reason,
}));

const CockpitInputFinalizeInputWire = z.object({
  command_key: id,
  expected_revision: count,
  expected_content_hash: hash,
});
export const CockpitInputFinalizeInputSchema = CockpitInputFinalizeInputWire.transform((value) => ({
  commandKey: value.command_key,
  expectedRevision: value.expected_revision,
  expectedContentHash: value.expected_content_hash,
}));

const CockpitInputAbandonInputWire = z.object({
  command_key: id,
  expected_revision: count,
  reason: z.string(),
});
export const CockpitInputAbandonInputSchema = CockpitInputAbandonInputWire.transform((value) => ({
  commandKey: value.command_key,
  expectedRevision: value.expected_revision,
  reason: value.reason,
}));

const CockpitInputTransferReceiptWire = z.object({
  mode: z.string(),
  command_key: id,
  request_hash: hash,
  action: z.string(),
  input_id: id,
  version_id: id,
  transfer_id: id,
  transfer_number: count,
  replaces_transfer_id: id.nullable(),
  before_revision: count,
  revision: count,
  state: z.string(),
  size_bytes: count.nullable(),
  content_hash: hash.nullable(),
  reason: z.string(),
  principal: CockpitInputPrincipalSchema,
  accepted_at: z.string().datetime({ offset: true }),
});
export const CockpitInputTransferReceiptSchema = CockpitInputTransferReceiptWire.transform((value) => ({
  mode: value.mode,
  commandKey: value.command_key,
  requestHash: value.request_hash,
  action: value.action,
  inputId: value.input_id,
  versionId: value.version_id,
  transferId: value.transfer_id,
  transferNumber: value.transfer_number,
  replacesTransferId: value.replaces_transfer_id,
  beforeRevision: value.before_revision,
  revision: value.revision,
  state: value.state,
  sizeBytes: value.size_bytes,
  contentHash: value.content_hash,
  reason: value.reason,
  principal: value.principal,
  acceptedAt: value.accepted_at,
}));

const CockpitInputTransferResultWire = z.object({
  workspace_id: id,
  input_id: id,
  version_id: id,
  command_key: id,
  action: z.string(),
  replayed: z.boolean(),
  receipt: CockpitInputTransferReceiptSchema,
  current: CockpitInputTransferMetadataSchema.nullable(),
  version: CockpitInputVersionMetadataSchema.nullable(),
});
export const CockpitInputTransferResultSchema = CockpitInputTransferResultWire.transform((value) => ({
  workspaceId: value.workspace_id,
  inputId: value.input_id,
  versionId: value.version_id,
  commandKey: value.command_key,
  action: value.action,
  replayed: value.replayed,
  receipt: value.receipt,
  current: value.current,
  version: value.version,
})).refine((r) => r.commandKey === r.receipt.commandKey && (!r.current || r.current.workspaceId === r.workspaceId)).refine((r) => ["input_transfer_restart", "input_transfer_finalize", "input_transfer_abandon"].includes(r.action) && r.action === r.receipt.action && r.inputId === r.receipt.inputId && r.versionId === r.receipt.versionId && (!r.current || r.current.id === r.receipt.transferId && r.current.inputId === r.inputId && r.current.versionId === r.versionId) && (!r.version || r.version.id === r.versionId && r.version.workspaceId === r.workspaceId && r.version.inputId === r.inputId));

const CockpitInputUploadResultWire = z.object({
  workspace_id: id,
  input_id: id,
  version_id: id,
  transfer_id: id,
  current: CockpitInputTransferMetadataSchema,
});
export const CockpitInputUploadResultSchema = CockpitInputUploadResultWire.transform((value) => ({
  workspaceId: value.workspace_id,
  inputId: value.input_id,
  versionId: value.version_id,
  transferId: value.transfer_id,
  current: value.current,
})).refine((r) => r.current.workspaceId === r.workspaceId && r.current.inputId === r.inputId && r.current.versionId === r.versionId && r.current.id === r.transferId);

const CockpitInputReferenceWire = z.object({
  workspace_id: id,
  id: id,
  reference_key: id,
  meeting_id: id,
  meeting_title: z.string(),
  agenda_id: id.nullable(),
  agenda_title: z.string(),
  input_id: id,
  input_title: z.string(),
  version: CockpitInputVersionMetadataSchema,
  purpose: z.string(),
  created_by: CockpitInputPrincipalSchema,
  created_at: z.string().datetime({ offset: true }),
  removed_at: z.string().datetime({ offset: true }).nullable(),
  can_remove: capability,
});
export const CockpitInputReferenceSchema = CockpitInputReferenceWire.transform((value) => ({
  workspaceId: value.workspace_id,
  id: value.id,
  referenceKey: value.reference_key,
  meetingId: value.meeting_id,
  meetingTitle: value.meeting_title,
  agendaId: value.agenda_id,
  agendaTitle: value.agenda_title,
  inputId: value.input_id,
  inputTitle: value.input_title,
  version: value.version,
  purpose: value.purpose,
  createdBy: value.created_by,
  createdAt: value.created_at,
  removedAt: value.removed_at,
  canRemove: value.can_remove,
})).refine((r) => r.version.workspaceId === r.workspaceId && r.version.inputId === r.inputId).transform((r) => ["material", "recording", "supporting"].includes(r.purpose) ? r : { ...r, canRemove: false });

const CockpitInputReferenceSummaryWire = z.object({
  available_ready: count,
  unavailable_ready: count,
  unknown_ready: count,
  total: count,
  ready: count,
  pending: count,
  needs_attention: count,
});
export const CockpitInputReferenceSummarySchema = CockpitInputReferenceSummaryWire.transform((value) => ({
  availableReady: value.available_ready,
  unavailableReady: value.unavailable_ready,
  unknownReady: value.unknown_ready,
  total: value.total,
  ready: value.ready,
  pending: value.pending,
  needsAttention: value.needs_attention,
})).refine((s) => s.total === s.ready + s.pending + s.needsAttention && s.ready === s.availableReady + s.unavailableReady + s.unknownReady);

const CockpitInputReferencePageWire = z.object({
  q: z.string(),
  purpose: z.string(),
  workspace_id: id,
  meeting_id: id,
  agenda_id: id.nullable(),
  include_removed: z.boolean(),
  page_size: count,
  items: z.array(CockpitInputReferenceSchema).max(200),
  total: count,
  summary: CockpitInputReferenceSummarySchema,
  next_cursor: z.string().nullable(),
  can_add: capability,
  blocked_reasons: z.array(z.string()).max(1000),
});
export const CockpitInputReferencePageSchema = CockpitInputReferencePageWire.transform((value) => ({
  q: value.q,
  purpose: value.purpose,
  workspaceId: value.workspace_id,
  meetingId: value.meeting_id,
  agendaId: value.agenda_id,
  includeRemoved: value.include_removed,
  pageSize: value.page_size,
  items: value.items,
  total: value.total,
  summary: value.summary,
  nextCursor: value.next_cursor,
  canAdd: value.can_add,
  blockedReasons: value.blocked_reasons,
})).refine((p) => p.pageSize >= 1 && p.pageSize <= 100 && p.items.length <= p.pageSize && p.total >= p.items.length).refine((p) => p.items.every((i) => i.workspaceId === p.workspaceId)).refine((p) => p.items.every((i) => i.meetingId === p.meetingId && (!p.agendaId || i.agendaId === p.agendaId)));

const CockpitInputReferenceCreateInputWire = z.object({
  command_key: id,
  agenda_id: id.nullable(),
  input_version_id: id,
  purpose: z.string(),
});
export const CockpitInputReferenceCreateInputSchema = CockpitInputReferenceCreateInputWire.transform((value) => ({
  commandKey: value.command_key,
  agendaId: value.agenda_id,
  inputVersionId: value.input_version_id,
  purpose: value.purpose,
}));

const CockpitInputReferenceRemoveInputWire = z.object({
  command_key: id,
});
export const CockpitInputReferenceRemoveInputSchema = CockpitInputReferenceRemoveInputWire.transform((value) => ({
  commandKey: value.command_key,
}));

const CockpitInputReferenceResultWire = z.object({
  workspace_id: id,
  command_key: id,
  action: z.string(),
  replayed: z.boolean(),
  receipt: CockpitInputReferenceReceiptSchema,
  current: CockpitInputReferenceSchema.nullable(),
});
export const CockpitInputReferenceResultSchema = CockpitInputReferenceResultWire.transform((value) => ({
  workspaceId: value.workspace_id,
  commandKey: value.command_key,
  action: value.action,
  replayed: value.replayed,
  receipt: value.receipt,
  current: value.current,
})).refine((r) => r.commandKey === r.receipt.commandKey && (!r.current || r.current.workspaceId === r.workspaceId)).refine((r) => ["input_reference_create", "input_reference_remove"].includes(r.action) && (!r.current || r.current.id === r.receipt.referenceId && r.current.meetingId === r.receipt.meetingId && r.current.agendaId === r.receipt.agendaId && r.current.version.id === r.receipt.inputVersionId && r.current.inputId === r.receipt.inputId));

const CockpitInputDownloadLinkWire = z.object({
  workspace_id: id,
  input_id: id,
  version_id: id,
  content_hash: hash,
  size_bytes: count,
  url: z.string(),
  expires_at: z.string().datetime({ offset: true }),
});
export const CockpitInputDownloadLinkSchema = CockpitInputDownloadLinkWire.transform((value) => ({
  workspaceId: value.workspace_id,
  inputId: value.input_id,
  versionId: value.version_id,
  contentHash: value.content_hash,
  sizeBytes: value.size_bytes,
  url: value.url,
  expiresAt: value.expires_at,
})).refine((r) => safeInputDownload(r.url, r.versionId));

const CockpitInputManifestCountsWire = z.object({
  total: count,
  required: count,
  available_required: count,
  unknown_required: count,
  unavailable_required: count,
});
export const CockpitInputManifestCountsSchema = CockpitInputManifestCountsWire.transform((value) => ({
  total: value.total,
  required: value.required,
  availableRequired: value.available_required,
  unknownRequired: value.unknown_required,
  unavailableRequired: value.unavailable_required,
})).refine((s) => s.required <= s.total && s.required === s.availableRequired + s.unknownRequired + s.unavailableRequired);

const CockpitInputManifestVersionMetadataWire = z.object({
  workspace_id: id,
  issue_id: id,
  id: id,
  version_number: count,
  command_key: id,
  manifest_hash: hash,
  item_total: count,
  required_total: count,
  created_by: z.string(),
  created_by_name: z.string(),
  created_at: z.string().datetime({ offset: true }),
  has_note: z.boolean(),
});
export const CockpitInputManifestVersionMetadataSchema = CockpitInputManifestVersionMetadataWire.transform((value) => ({
  workspaceId: value.workspace_id,
  issueId: value.issue_id,
  id: value.id,
  versionNumber: value.version_number,
  commandKey: value.command_key,
  manifestHash: value.manifest_hash,
  itemTotal: value.item_total,
  requiredTotal: value.required_total,
  createdBy: value.created_by,
  createdByName: value.created_by_name,
  createdAt: value.created_at,
  hasNote: value.has_note,
}));

const CockpitInputManifestHeaderWire = z.object({
  workspace_id: id,
  issue: CockpitInputIssueSummarySchema,
  revision: count,
  current_version: CockpitInputManifestVersionMetadataSchema.nullable(),
  counts: CockpitInputManifestCountsSchema,
  can_edit: capability,
  blocked_reasons: z.array(z.string()).max(1000),
});
export const CockpitInputManifestHeaderSchema = CockpitInputManifestHeaderWire.transform((value) => ({
  workspaceId: value.workspace_id,
  issue: value.issue,
  revision: value.revision,
  currentVersion: value.current_version,
  counts: value.counts,
  canEdit: value.can_edit,
  blockedReasons: value.blocked_reasons,
})).refine((h) => !h.currentVersion || h.currentVersion.workspaceId === h.workspaceId && h.currentVersion.issueId === h.issue.id && h.currentVersion.itemTotal === h.counts.total && h.currentVersion.requiredTotal === h.counts.required);

const CockpitInputManifestItemWire = z.object({
  position: count,
  input_id: id,
  input_title: z.string(),
  input_version_id: id,
  input_version_number: count,
  payload_kind: z.string(),
  filename: z.string(),
  content_type: z.string(),
  size_bytes: count,
  content_hash: hash,
  purpose: z.string(),
  required: z.boolean(),
  availability: z.string(),
  unavailable_reason: z.string(),
});
export const CockpitInputManifestItemSchema = CockpitInputManifestItemWire.transform((value) => ({
  position: value.position,
  inputId: value.input_id,
  inputTitle: value.input_title,
  inputVersionId: value.input_version_id,
  inputVersionNumber: value.input_version_number,
  payloadKind: value.payload_kind,
  filename: value.filename,
  contentType: value.content_type,
  sizeBytes: value.size_bytes,
  contentHash: value.content_hash,
  purpose: value.purpose,
  required: value.required,
  availability: value.availability,
  unavailableReason: value.unavailable_reason,
}));

const CockpitInputManifestVersionDetailWire = z.object({
  ...CockpitInputManifestVersionMetadataWire.shape,
  note: z.string(),
});
export const CockpitInputManifestVersionDetailSchema = CockpitInputManifestVersionDetailWire.transform((value) => ({
  workspaceId: value.workspace_id,
  issueId: value.issue_id,
  id: value.id,
  versionNumber: value.version_number,
  commandKey: value.command_key,
  manifestHash: value.manifest_hash,
  itemTotal: value.item_total,
  requiredTotal: value.required_total,
  createdBy: value.created_by,
  createdByName: value.created_by_name,
  createdAt: value.created_at,
  hasNote: value.has_note,
  note: value.note,
}));

const CockpitInputManifestVersionPageWire = z.object({
  workspace_id: id,
  issue_id: id,
  page_size: count,
  items: z.array(CockpitInputManifestVersionMetadataSchema).max(200),
  total: count,
  next_cursor: z.string().nullable(),
});
export const CockpitInputManifestVersionPageSchema = CockpitInputManifestVersionPageWire.transform((value) => ({
  workspaceId: value.workspace_id,
  issueId: value.issue_id,
  pageSize: value.page_size,
  items: value.items,
  total: value.total,
  nextCursor: value.next_cursor,
})).refine((p) => p.pageSize >= 1 && p.pageSize <= 100 && p.items.length <= p.pageSize && p.total >= p.items.length).refine((p) => p.items.every((i) => i.workspaceId === p.workspaceId));

const CockpitInputManifestItemPageWire = z.object({
  workspace_id: id,
  issue_id: id,
  manifest_version_id: id,
  manifest_hash: hash,
  page_size: count,
  items: z.array(CockpitInputManifestItemSchema).max(200),
  total: count,
  next_cursor: z.string().nullable(),
});
export const CockpitInputManifestItemPageSchema = CockpitInputManifestItemPageWire.transform((value) => ({
  workspaceId: value.workspace_id,
  issueId: value.issue_id,
  manifestVersionId: value.manifest_version_id,
  manifestHash: value.manifest_hash,
  pageSize: value.page_size,
  items: value.items,
  total: value.total,
  nextCursor: value.next_cursor,
})).refine((p) => p.pageSize >= 1 && p.pageSize <= 100 && p.items.length <= p.pageSize && p.total >= p.items.length);

const CockpitInputManifestItemInputWire = z.object({
  input_version_id: id,
  purpose: z.string(),
  required: z.boolean(),
});
export const CockpitInputManifestItemInputSchema = CockpitInputManifestItemInputWire.transform((value) => ({
  inputVersionId: value.input_version_id,
  purpose: value.purpose,
  required: value.required,
}));

const CockpitInputManifestSaveInputWire = z.object({
  command_key: id,
  expected_revision: count,
  items: z.array(CockpitInputManifestItemInputSchema).max(200),
  note: z.string(),
});
export const CockpitInputManifestSaveInputSchema = CockpitInputManifestSaveInputWire.transform((value) => ({
  commandKey: value.command_key,
  expectedRevision: value.expected_revision,
  items: value.items,
  note: value.note,
}));

const CockpitInputManifestReceiptWire = z.object({
  command_key: id,
  request_hash: hash,
  issue_id: id,
  manifest_version_id: id,
  version_number: count,
  revision: count,
  manifest_hash: hash,
  items: z.array(CockpitInputManifestItemInputSchema).max(200),
  note: z.string(),
  created_by: z.string(),
  created_at: z.string().datetime({ offset: true }),
});
export const CockpitInputManifestReceiptSchema = CockpitInputManifestReceiptWire.transform((value) => ({
  commandKey: value.command_key,
  requestHash: value.request_hash,
  issueId: value.issue_id,
  manifestVersionId: value.manifest_version_id,
  versionNumber: value.version_number,
  revision: value.revision,
  manifestHash: value.manifest_hash,
  items: value.items,
  note: value.note,
  createdBy: value.created_by,
  createdAt: value.created_at,
}));

const CockpitInputManifestResultWire = z.object({
  workspace_id: id,
  command_key: id,
  action: z.string(),
  replayed: z.boolean(),
  receipt: CockpitInputManifestReceiptSchema,
  current: CockpitInputManifestHeaderSchema.nullable(),
});
export const CockpitInputManifestResultSchema = CockpitInputManifestResultWire.transform((value) => ({
  workspaceId: value.workspace_id,
  commandKey: value.command_key,
  action: value.action,
  replayed: value.replayed,
  receipt: value.receipt,
  current: value.current,
})).refine((r) => r.commandKey === r.receipt.commandKey && (!r.current || r.current.workspaceId === r.workspaceId)).refine((r) => r.action === "input_manifest_save" && (!r.current || r.current.issue.id === r.receipt.issueId) && r.receipt.items.length <= 200 && new Set(r.receipt.items.map((i) => i.inputVersionId)).size === r.receipt.items.length);

const CockpitRunInputManifestWire = z.object({
  workspace_id: id,
  task_id: id,
  issue_id: id.nullable(),
  manifest_version: CockpitInputManifestVersionMetadataSchema.nullable(),
  preparation_state: z.string(),
  preparation_hash: hash.nullable(),
  prepared_at: z.string().datetime({ offset: true }).nullable(),
  error_code: z.string(),
  counts: CockpitInputManifestCountsSchema,
  runtime_supported: capability,
});
export const CockpitRunInputManifestSchema = CockpitRunInputManifestWire.transform((value) => ({
  workspaceId: value.workspace_id,
  taskId: value.task_id,
  issueId: value.issue_id,
  manifestVersion: value.manifest_version,
  preparationState: value.preparation_state,
  preparationHash: value.preparation_hash,
  preparedAt: value.prepared_at,
  errorCode: value.error_code,
  counts: value.counts,
  runtimeSupported: value.runtime_supported,
})).refine((r) => r.manifestVersion ? r.manifestVersion.workspaceId === r.workspaceId && r.manifestVersion.issueId === r.issueId && r.counts.total === r.manifestVersion.itemTotal && r.counts.required === r.manifestVersion.requiredTotal && (r.preparationState !== "required_ready" || r.preparationHash === r.manifestVersion.manifestHash && r.preparedAt !== null) : r.preparationState === "not_recorded" && r.preparationHash === null && r.preparedAt === null);

const CockpitRunInputPreparationInputWire = z.object({
  manifest_version_id: id,
  manifest_hash: hash,
  dispatched_at: z.string().datetime({ offset: true }),
  state: z.string(),
  prepared_input_version_ids: z.array(id).max(200),
  error_code: z.string(),
});
export const CockpitRunInputPreparationInputSchema = CockpitRunInputPreparationInputWire.transform((value) => ({
  manifestVersionId: value.manifest_version_id,
  manifestHash: value.manifest_hash,
  dispatchedAt: value.dispatched_at,
  state: value.state,
  preparedInputVersionIds: value.prepared_input_version_ids,
  errorCode: value.error_code,
}));

const CockpitInputSpaceWire = z.object({
  root_id: id,
  root_path: z.string(),
  input_subpaths: z.array(z.string()).max(1000),
  root_config_hash: hash,
  can_browse: capability,
  unavailable_reason: z.string(),
});
export const CockpitInputSpaceSchema = CockpitInputSpaceWire.transform((value) => ({
  rootId: value.root_id,
  rootPath: value.root_path,
  inputSubpaths: value.input_subpaths,
  rootConfigHash: value.root_config_hash,
  canBrowse: value.can_browse,
  unavailableReason: value.unavailable_reason,
}));

const CockpitInputSpacePageWire = z.object({
  workspace_id: id,
  items: z.array(CockpitInputSpaceSchema).max(200),
  total: count,
});
export const CockpitInputSpacePageSchema = CockpitInputSpacePageWire.transform((value) => ({
  workspaceId: value.workspace_id,
  items: value.items,
  total: value.total,
}));

const CockpitInputNASBrowseInputWire = z.object({
  relative_directory: z.string(),
  q: z.string(),
  cursor: z.string(),
  page_size: count,
});
export const CockpitInputNASBrowseInputSchema = CockpitInputNASBrowseInputWire.transform((value) => ({
  relativeDirectory: value.relative_directory,
  q: value.q,
  cursor: value.cursor,
  pageSize: value.page_size,
}));

const CockpitInputNASEntryWire = z.object({
  can_open_directory: capability,
  name: z.string(),
  relative_path: z.string(),
  kind: z.string(),
  size_bytes: count.nullable(),
  modified_at: z.string().datetime({ offset: true }).nullable(),
  observation_token: z.string(),
  can_select: capability,
  unavailable_reason: z.string(),
});
export const CockpitInputNASEntrySchema = CockpitInputNASEntryWire.transform((value) => ({
  canOpenDirectory: value.can_open_directory,
  name: value.name,
  relativePath: value.relative_path,
  kind: value.kind,
  sizeBytes: value.size_bytes,
  modifiedAt: value.modified_at,
  observationToken: value.observation_token,
  canSelect: value.can_select,
  unavailableReason: value.unavailable_reason,
})).transform((e) => ({ ...e, canSelect: e.kind === "file" && e.canSelect, canOpenDirectory: e.kind === "directory" && e.canOpenDirectory }));

const CockpitInputNASPageWire = z.object({
  workspace_id: id,
  root_id: id,
  relative_directory: z.string(),
  q: z.string(),
  root_config_hash: hash,
  observation_token: z.string(),
  page_size: count,
  items: z.array(CockpitInputNASEntrySchema).max(200),
  total: count.nullable(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});
export const CockpitInputNASPageSchema = CockpitInputNASPageWire.transform((value) => ({
  workspaceId: value.workspace_id,
  rootId: value.root_id,
  relativeDirectory: value.relative_directory,
  q: value.q,
  rootConfigHash: value.root_config_hash,
  observationToken: value.observation_token,
  pageSize: value.page_size,
  items: value.items,
  total: value.total,
  hasMore: value.has_more,
  nextCursor: value.next_cursor,
})).refine((p) => p.pageSize >= 1 && p.pageSize <= 100 && p.items.length <= p.pageSize && (p.total === null || p.total >= p.items.length) && p.hasMore === Boolean(p.nextCursor) && new Set(p.items.map((i) => i.relativePath)).size === p.items.length);

export const CockpitInputVersionBatchSchema = z.object({
  workspace_id: id, requested_ids: z.array(id).max(100), items: z.array(CockpitInputVersionMetadataSchema).max(100), unavailable_ids: z.array(id).max(100),
}).refine((batch) => {
  const returned = [...batch.items.map((item) => item.id), ...batch.unavailable_ids];
  return new Set(batch.requested_ids).size === batch.requested_ids.length && new Set(returned).size === returned.length
    && returned.length === batch.requested_ids.length && returned.every((value) => batch.requested_ids.includes(value))
    && batch.items.every((item) => item.workspaceId === batch.workspace_id)
    && batch.items.every((item, index) => item.id === batch.requested_ids.filter((id) => !batch.unavailable_ids.includes(id))[index]);
}).transform((batch) => ({ workspaceId: batch.workspace_id, requestedIds: batch.requested_ids, items: batch.items, unavailableIds: batch.unavailable_ids }));


const CockpitInputAttachmentSchema = z.object({
  id, issue_id: id, filename: z.string(), content_type: z.string(), size_bytes: count,
  created_at: z.string().datetime({ offset: true }),
}).transform((value) => ({ id: value.id, issueId: value.issue_id, filename: value.filename,
  contentType: value.content_type, sizeBytes: value.size_bytes, createdAt: value.created_at }));
export const CockpitInputAttachmentPageSchema = z.object({
  workspace_id: id, issue_id: id, q: z.string(), page_size: z.number().int().min(1).max(100),
  items: z.array(CockpitInputAttachmentSchema).max(100), total: count, next_cursor: z.string().nullable(),
  can_capture: capability, blocked_reasons: z.array(z.string()).default([]),
}).refine((page) => page.items.length <= page.page_size && page.total >= page.items.length
  && new Set(page.items.map((item) => item.id)).size === page.items.length
  && page.items.every((item) => item.issueId === page.issue_id))
  .transform((value) => ({ workspaceId: value.workspace_id, issueId: value.issue_id, q: value.q,
    pageSize: value.page_size, items: value.items, total: value.total, nextCursor: value.next_cursor,
    canCapture: value.can_capture, blockedReasons: value.blocked_reasons }));


export const CockpitInputAttachmentDetailSchema = z.object({
  workspace_id: id, issue_id: id, id, filename: z.string(), content_type: z.string(),
  size_bytes: count, created_at: z.string().datetime({ offset: true }),
}).transform((value) => ({ workspaceId: value.workspace_id, id: value.id, issueId: value.issue_id,
  filename: value.filename, contentType: value.content_type, sizeBytes: value.size_bytes, createdAt: value.created_at }));
