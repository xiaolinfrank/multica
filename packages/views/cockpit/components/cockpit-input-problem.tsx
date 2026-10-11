"use client";

import type { ReactNode } from "react";
import { useT } from "../../i18n";

export function CockpitInputProblem({ codes, recovery }: { codes: string[]; recovery?: ReactNode }) {
  const { t } = useT("cockpit");
  const reasons: Record<string, string> = {
    human_required: t(($) => $.meeting_lifecycle.human_required),
    workflow_manager_required: t(($) => $.meeting_lifecycle.manager_required),
    meeting_preparation_closed: t(($) => $.meeting_preparation.reason_closed),
    meeting_archived: t(($) => $.meeting_disposition.archived_preparation),
    meeting_cancelled: t(($) => $.meeting_disposition.cancelled_preparation),
    forbidden: t(($) => $.input_materials.error_permission),
    private_storage_required: t(($) => $.input_materials.error_private_storage),
    input_scope_not_configured: t(($) => $.input_materials.error_input_scope),
    source_changed: t(($) => $.input_materials.error_source_changed),
    content_hash_mismatch: t(($) => $.input_materials.error_source_changed),
    upload_incomplete: t(($) => $.input_materials.error_upload_incomplete),
    upload_session_expired: t(($) => $.input_materials.error_upload_incomplete),
    upload_in_progress: t(($) => $.input_materials.error_transfer_changed),
    transfer_lease_changed: t(($) => $.input_materials.error_transfer_changed),
    input_unavailable: t(($) => $.input_materials.error_unavailable),
    verification_pending: t(($) => $.input_materials.error_verification_pending),
    manifest_changed: t(($) => $.input_materials.error_manifest_changed),
    reference_exists: t(($) => $.input_materials.error_reference_exists),
    input_runtime_unsupported: t(($) => $.input_materials.error_runtime_unsupported),
    required_input_unavailable: t(($) => $.input_materials.error_required_input),
    permission_revoked: t(($) => $.input_materials.error_permission),
    target_gone: t(($) => $.input_materials.error_target),
  };
  if (codes.length === 0) return null;
  return <div className="min-w-0 space-y-3 rounded-lg border border-border p-3 text-caption">
    <div role="alert" className="space-y-2 [overflow-wrap:anywhere]">{[...new Set(codes.map((code) => reasons[code] ?? t(($) => $.input_materials.error_unknown)))].map((reason) => <p key={reason}>{reason}</p>)}</div>
    {recovery && <div className="flex flex-wrap items-center gap-2">{recovery}</div>}
    <details className="text-muted-foreground"><summary className="cursor-pointer">{t(($) => $.artifact_runtime.diagnostics)}</summary>
      <ul className="mt-2 max-h-32 overflow-y-auto break-words font-mono [overflow-wrap:anywhere]">{[...new Set(codes)].map((code) => <li key={code}>{code}</li>)}</ul>
    </details>
  </div>;
}
