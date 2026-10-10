export interface CockpitNasAttempt {
  id: string;
  attempt_number: number;
  status: string;
  target_path: string;
  receipt_path: string;
  content_hash: string;
  verified_path: string | null;
  verified_receipt_path: string | null;
  verified_attempt_id: string | null;
  receipt_hash: string | null;
  size_bytes: number | null;
  last_error_code: string;
  last_error: string;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
}

export interface CockpitNasAttemptPage {
  workspace_id: string;
  meeting_id: string;
  export_id: string;
  items: CockpitNasAttempt[];
  total: number;
  next_cursor: string | null;
}
