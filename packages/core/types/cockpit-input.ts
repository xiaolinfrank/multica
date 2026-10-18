// Input domain types use camelCase; schemas translate the HTTP wire boundary.

export interface CockpitInputIssueSummary {
  id: string;
  identifier: string;
  title: string;
  status: string;
  statusCategory: string;
  priority: string;
  assigneeType: string | null;
  assigneeId: string | null;
  assigneeName: string;
  dueDate: string | null;
  projectId: string | null;
  moduleId: string | null;
  primaryNodeId: string | null;
  primaryNodeCode: string;
  primaryNodeName: string;
  primaryRevision: number;
  creationKey: string | null;
}

export interface CockpitInputPrincipal {
  actorType: string;
  actorId: string;
  actorName: string;
  credentialOwnerUserId: string;
  authorizingUserId: string;
  authorizingUserName: string;
  agentId: string | null;
  runId: string | null;
  issueId: string | null;
  runtimeId: string | null;
}

export interface CockpitInputScope {
  ids: Array<string>;
  projectId: string | null;
  meetingId: string | null;
  agendaId: string | null;
  originIssueId: string | null;
  q: string;
  archive: string;
  sourceKind: string;
}

export interface CockpitInputCapabilities {
  workspaceId: string;
  canCreate: boolean;
  canBrowseNas: boolean;
  directUploadAvailable: boolean;
  fileCaptureAvailable: boolean;
  unavailableReason: string;
  maxFileBytes: number;
  uploadSessionTtlSeconds: number;
}

export interface CockpitInputHeader {
  workspaceId: string;
  id: string;
  creationKey: string;
  title: string;
  description: string;
  projectId: string | null;
  originIssue: CockpitInputIssueSummary | null;
  revision: number;
  registeredBy: CockpitInputPrincipal;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  currentVersion: CockpitInputVersionMetadata | null;
  versionTotal: number;
  referenceTotal: number;
  canEdit: boolean;
  canSubmit: boolean;
  canArchive: boolean;
  canUnarchive: boolean;
  blockedReasons: Array<string>;
}

export interface CockpitInputPage {
  workspaceId: string;
  scope: CockpitInputScope;
  pageSize: number;
  items: Array<CockpitInputHeader>;
  total: number;
  nextCursor: string | null;
  canCreate: boolean;
}

export interface CockpitInputCreateInput {
  commandKey: string;
  title: string;
  description: string;
  projectId: string | null;
  originIssueId: string | null;
}

export interface CockpitInputCreateReceipt {
  inputRevision: number;
  commandKey: string;
  requestHash: string;
  inputId: string;
  title: string;
  description: string;
  projectId: string | null;
  originIssueId: string | null;
  principal: CockpitInputPrincipal;
  createdAt: string;
}

export interface CockpitInputCreateResult {
  workspaceId: string;
  commandKey: string;
  action: string;
  replayed: boolean;
  receipt: CockpitInputCreateReceipt;
  current: CockpitInputHeader | null;
}

export interface CockpitInputEditInput {
  expectedRevision: number;
  title: string;
  description: string;
}

export interface CockpitInputArchiveInput {
  expectedRevision: number;
  archived: boolean;
}

export interface CockpitInputUploadSource {
  filename: string;
  contentType: string;
  sizeBytes: number;
  clientSha256: string | null;
}

export interface CockpitInputNASSource {
  rootId: string;
  relativePath: string;
  observationToken: string;
}

export interface CockpitInputAttachmentSource {
  issueId: string;
  attachmentId: string;
}

export interface CockpitInputArtifactSource {
  artifactId: string;
  versionId: string;
}

export interface CockpitInputSourceInput {
  kind: string;
  upload?: CockpitInputUploadSource | null;
  nasFile?: CockpitInputNASSource | null;
  attachment?: CockpitInputAttachmentSource | null;
  artifactVersion?: CockpitInputArtifactSource | null;
}

export interface CockpitInputSourceMetadata {
  kind: string;
  issue: CockpitInputIssueSummary | null;
  attachmentId: string | null;
  rootId: string | null;
  relativePath: string | null;
  artifactId: string | null;
  artifactTitle: string;
  artifactVersionId: string | null;
  artifactVersionNumber: number | null;
  artifactDecision: string | null;
  sourceAvailable: boolean;
  sourceUnavailableReason: string;
}

export interface CockpitInputVersionMetadata {
  latestTransferId: string | null;
  allowedRestartModes: string[];
  currentTransferId: string | null;
  workspaceId: string;
  inputId: string;
  id: string;
  versionNumber: number;
  submissionKey: string;
  revision: number;
  payloadKind: string;
  source: CockpitInputSourceMetadata;
  submittedBy: CockpitInputPrincipal;
  filename: string;
  contentType: string;
  declaredSizeBytes: number | null;
  sizeBytes: number | null;
  contentHash: string | null;
  captureState: string;
  captureErrorCode: string;
  availability: string;
  checkedAt: string | null;
  unavailableReason: string;
  activeTransferId: string | null;
  acceptedTransferId: string | null;
  createdAt: string;
  readyAt: string | null;
  canDownload: boolean;
  canRestart: boolean;
  canReference: boolean;
  canVerify: boolean;
  blockedReasons: Array<string>;
}

export interface CockpitInputVersionDetail {
  workspaceId: string;
  inputId: string;
  version: CockpitInputVersionMetadata;
  content: string | null;
  captureError: string;
}

export interface CockpitInputVersionPage {
  workspaceId: string;
  inputId: string;
  pageSize: number;
  items: Array<CockpitInputVersionMetadata>;
  total: number;
  nextCursor: string | null;
}


export interface CockpitInputVersionSubmitInput {
  commandKey: string;
  expectedRevision: number;
  source: CockpitInputSourceInput;
}

export interface CockpitInputVersionReceipt {
  transferRevision: number | null;
  commandKey: string;
  requestHash: string;
  inputId: string;
  versionId: string;
  versionNumber: number;
  inputRevision: number;
  source: CockpitInputSourceInput;
  payloadKind: string;
  captureState: string;
  transferId: string | null;
  principal: CockpitInputPrincipal;
  acceptedAt: string;
}

export interface CockpitInputVersionResult {
  workspaceId: string;
  inputId: string;
  commandKey: string;
  action: string;
  replayed: boolean;
  receipt: CockpitInputVersionReceipt;
  current: CockpitInputVersionMetadata | null;
  transfer: CockpitInputTransferMetadata | null;
}

export interface CockpitInputTransferMetadata {
  mode: string;
  workspaceId: string;
  inputId: string;
  versionId: string;
  id: string;
  transferNumber: number;
  commandKey: string;
  kind: string;
  state: string;
  revision: number;
  principal: CockpitInputPrincipal;
  receivedBytes: number | null;
  expectedBytes: number;
  pinnedSizeBytes: number | null;
  contentHash: string | null;
  sessionExpiresAt: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  errorCode: string;
  canUpload: boolean;
  canRestart: boolean;
  canFinalize: boolean;
  canAbandon: boolean;
  blockedReasons: Array<string>;
}

export interface CockpitInputTransferDetail extends CockpitInputTransferMetadata {
  errorMessage: string;
}

export interface CockpitInputTransferPage {
  workspaceId: string;
  inputId: string;
  versionId: string;
  pageSize: number;
  items: Array<CockpitInputTransferMetadata>;
  total: number;
  nextCursor: string | null;
}

export interface CockpitInputRestartInput {
  mode: string;
  commandKey: string;
  expectedRevision: number;
  previousTransferId: string | null;
  reason: string;
}

export interface CockpitInputFinalizeInput {
  commandKey: string;
  expectedRevision: number;
  expectedContentHash: string;
}

export interface CockpitInputAbandonInput {
  commandKey: string;
  expectedRevision: number;
  reason: string;
}

export interface CockpitInputTransferReceipt {
  mode: string;
  commandKey: string;
  requestHash: string;
  action: string;
  inputId: string;
  versionId: string;
  transferId: string;
  transferNumber: number;
  replacesTransferId: string | null;
  beforeRevision: number;
  revision: number;
  state: string;
  sizeBytes: number | null;
  contentHash: string | null;
  reason: string;
  principal: CockpitInputPrincipal;
  acceptedAt: string;
}

export interface CockpitInputTransferResult {
  workspaceId: string;
  inputId: string;
  versionId: string;
  commandKey: string;
  action: string;
  replayed: boolean;
  receipt: CockpitInputTransferReceipt;
  current: CockpitInputTransferMetadata | null;
  version: CockpitInputVersionMetadata | null;
}

export interface CockpitInputUploadResult {
  workspaceId: string;
  inputId: string;
  versionId: string;
  transferId: string;
  current: CockpitInputTransferMetadata;
}


export interface CockpitInputDownloadLink {
  workspaceId: string;
  inputId: string;
  versionId: string;
  contentHash: string;
  sizeBytes: number;
  url: string;
  expiresAt: string;
}

export interface CockpitInputManifestCounts {
  total: number;
  required: number;
  availableRequired: number;
  unknownRequired: number;
  unavailableRequired: number;
}

export interface CockpitInputManifestVersionMetadata {
  workspaceId: string;
  issueId: string;
  id: string;
  versionNumber: number;
  commandKey: string;
  manifestHash: string;
  itemTotal: number;
  requiredTotal: number;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  hasNote: boolean;
}

export interface CockpitInputManifestHeader {
  workspaceId: string;
  issue: CockpitInputIssueSummary;
  revision: number;
  currentVersion: CockpitInputManifestVersionMetadata | null;
  counts: CockpitInputManifestCounts;
  canEdit: boolean;
  blockedReasons: Array<string>;
}

export interface CockpitInputManifestItem {
  position: number;
  inputId: string;
  inputTitle: string;
  inputVersionId: string;
  inputVersionNumber: number;
  payloadKind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentHash: string;
  purpose: string;
  required: boolean;
  availability: string;
  unavailableReason: string;
}

export interface CockpitInputManifestVersionDetail extends CockpitInputManifestVersionMetadata {
  note: string;
}

export interface CockpitInputManifestVersionPage {
  workspaceId: string;
  issueId: string;
  pageSize: number;
  items: Array<CockpitInputManifestVersionMetadata>;
  total: number;
  nextCursor: string | null;
}

export interface CockpitInputManifestItemPage {
  workspaceId: string;
  issueId: string;
  manifestVersionId: string;
  manifestHash: string;
  pageSize: number;
  items: Array<CockpitInputManifestItem>;
  total: number;
  nextCursor: string | null;
}

export interface CockpitInputManifestItemInput {
  inputVersionId: string;
  purpose: string;
  required: boolean;
}

export interface CockpitInputManifestSaveInput {
  commandKey: string;
  expectedRevision: number;
  items: Array<CockpitInputManifestItemInput>;
  note: string;
}

export interface CockpitInputManifestReceipt {
  commandKey: string;
  requestHash: string;
  issueId: string;
  manifestVersionId: string;
  versionNumber: number;
  revision: number;
  manifestHash: string;
  items: Array<CockpitInputManifestItemInput>;
  note: string;
  createdBy: string;
  createdAt: string;
}

export interface CockpitInputManifestResult {
  workspaceId: string;
  commandKey: string;
  action: string;
  replayed: boolean;
  receipt: CockpitInputManifestReceipt;
  current: CockpitInputManifestHeader | null;
}

export interface CockpitRunInputManifest {
  workspaceId: string;
  taskId: string;
  issueId: string | null;
  manifestVersion: CockpitInputManifestVersionMetadata | null;
  preparationState: string;
  preparationHash: string | null;
  preparedAt: string | null;
  errorCode: string;
  counts: CockpitInputManifestCounts;
  runtimeSupported: boolean;
}

export interface CockpitRunInputPreparationInput {
  manifestVersionId: string;
  manifestHash: string;
  dispatchedAt: string;
  state: string;
  preparedInputVersionIds: Array<string>;
  errorCode: string;
}

export interface CockpitInputSpace {
  rootId: string;
  rootPath: string;
  inputSubpaths: Array<string>;
  rootConfigHash: string;
  canBrowse: boolean;
  unavailableReason: string;
}

export interface CockpitInputSpacePage {
  workspaceId: string;
  items: Array<CockpitInputSpace>;
  total: number;
}

export interface CockpitInputNASBrowseInput {
  relativeDirectory: string;
  q: string;
  cursor: string;
  pageSize: number;
}

export interface CockpitInputNASEntry {
  canOpenDirectory: boolean;
  name: string;
  relativePath: string;
  kind: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  observationToken: string;
  canSelect: boolean;
  unavailableReason: string;
}

export interface CockpitInputNASPage {
  workspaceId: string;
  rootId: string;
  relativeDirectory: string;
  q: string;
  rootConfigHash: string;
  observationToken: string;
  pageSize: number;
  items: Array<CockpitInputNASEntry>;
  total: number | null;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface CockpitInputPageQuery {
  cursor?: string;
  pageSize?: number;
  includeRemoved?: boolean;
  q?: string;
  purpose?: string;
}

export interface CockpitInputVersionBatch {
  workspaceId: string;
  requestedIds: string[];
  items: CockpitInputVersionMetadata[];
  unavailableIds: string[];
}
export interface CockpitInputListQuery extends CockpitInputPageQuery {
  ids?: string[];
  projectId?: string;
  meetingId?: string;
  agendaId?: string;
  originIssueId?: string;
  archive?: string;
  sourceKind?: string;
}


export interface CockpitInputAttachment {
  id: string;
  issueId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}
export interface CockpitInputAttachmentPage {
  workspaceId: string;
  issueId: string;
  q: string;
  pageSize: number;
  items: CockpitInputAttachment[];
  total: number;
  nextCursor: string | null;
  canCapture: boolean;
  blockedReasons: string[];
}
