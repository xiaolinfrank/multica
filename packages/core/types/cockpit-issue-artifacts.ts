export interface CockpitIssueArtifactContext {
  kind: string;
  id: string;
  roles: string[];
  artifact_id: string | null;
  artifact_title: string;
  version_id: string | null;
  version_number: number | null;
  node_id: string;
  node_label: string;
  request_id: string | null;
  decision: string;
  reviewer_id: string | null;
  is_current_review: boolean;
}

export interface CockpitIssueArtifactContextPage {
  formal_review: CockpitIssueFormalReview | null;
  workspace_id: string;
  issue_id: string;
  items: CockpitIssueArtifactContext[];
  total: number;
  next_cursor: string | null;
}

export interface CockpitIssueFormalReview {
  kind: string;
  stage: string;
  node_id: string;
  artifact_id: string | null;
  version_id: string | null;
  request_id: string | null;
}
