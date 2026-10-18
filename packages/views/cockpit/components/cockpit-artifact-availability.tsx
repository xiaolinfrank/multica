"use client";
import { useT } from "../../i18n";

export function CockpitArtifactAvailabilityReason({ reason }: { reason: string }) {
  const { t } = useT("cockpit");
  let message: string;
  switch (reason) {
    case "capture_not_ready": message = t(($) => $.artifact_runtime.capture_not_ready); break;
    case "content_mismatch": message = t(($) => $.artifact_runtime.content_mismatch); break;
    case "storage_unavailable": message = t(($) => $.artifact_runtime.storage_unavailable); break;
    case "private_storage_required": message = t(($) => $.artifact_runtime.private_content_unavailable); break;
    case "verification_timeout": message = t(($) => $.artifact_runtime.verification_timeout); break;
    case "content_unavailable": message = t(($) => $.artifact_runtime.content_unavailable); break;
    case "criteria_changed": message = t(($) => $.acceptance_request.criteria_changed); break;
    case "evidence_outdated": message = t(($) => $.acceptance_request.evidence_changed); break;
    default: return reason ? <details className="text-caption"><summary className="cursor-pointer">{t(($) => $.artifact_runtime.diagnostics)}</summary><p className="mt-2 break-words font-mono text-micro">{reason}</p></details> : null;
  }
  return <p className="text-caption">{message}</p>;
}
