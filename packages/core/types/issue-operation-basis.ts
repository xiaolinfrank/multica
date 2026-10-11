/** Server projections explain field restrictions; write-time guards remain authoritative. */
export type IssueOperationState = "allowed" | "blocked" | "unknown";
export type IssueOperationAvailability = "available" | "unavailable" | "unknown";
export interface IssueOperationField {
  state: IssueOperationState;
  reason_codes: string[];
}
export interface IssueStatusOperationField extends IssueOperationField {
  allowed_categories: string[];
}
export interface IssueOperationTarget {
  kind: string;
  label: string;
  purpose: string;
  issue_id?: string;
  node_id?: string;
  meeting_id?: string;
  action_id?: string;
  operation_id?: string;
  directory_operation_id?: string;
  artifact_id?: string;
  version_id?: string;
  request_id?: string;
  view?: string;
}
export interface IssueOperationBasis {
  issue_id: string;
  availability: IssueOperationAvailability;
  issue_revision: number | null;
  status: IssueStatusOperationField;
  assignee: IssueOperationField;
  scope: IssueOperationField;
  parent: IssueOperationField;
  primary: IssueOperationField;
  delete: IssueOperationField;
  execution: IssueOperationField;
  targets: IssueOperationTarget[];
  targets_total: number;
}
export type IssueOperationName = "status" | "assignee" | "scope" | "parent" | "primary" | "delete" | "execution";
export interface IssueOperationBasisPage {
  workspace_id: string;
  schema_version: 1;
  generated_at: string;
  items: IssueOperationBasis[];
}
export type ContainerOperationKind = "node" | "project" | "module";
export interface ContainerOperationBasis {
  workspace_id: string;
  schema_version: 1;
  generated_at: string;
  resource_kind: ContainerOperationKind;
  resource_id: string;
  availability: IssueOperationAvailability;
  resource_revision: number | null;
  delete: IssueOperationField;
  structural_edit: IssueOperationField;
  add_child: IssueOperationField;
  targets: IssueOperationTarget[];
  targets_total: number;
}
