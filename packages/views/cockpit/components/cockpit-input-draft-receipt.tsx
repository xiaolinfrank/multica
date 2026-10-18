"use client";

import { advanceCockpitInputForm, clearCockpitInputForm, useCockpitInputDraftStore } from "@multica/core/cockpit";
import { toast } from "sonner";
import { useT } from "../../i18n";
import { useCockpitInputRequest } from "./use-cockpit-input-request";
import { CockpitInputCommandRecovery } from "./cockpit-input-command-recovery";

/** Historical receipt reads remain available when a newer projection is forbidden. */
export function CockpitInputDraftReceipt({ wsId, draftKey, onConfirmed }: { wsId: string; draftKey: string; onConfirmed: () => void }) {
  const { t } = useT("cockpit"); const request = useCockpitInputRequest(wsId, draftKey);
  async function verify() {
    const form = useCockpitInputDraftStore.getState().draft.forms[draftKey];
    const response = await request.verify();
    if (!response?.stillCurrent()) return;
    const ack = response.acknowledged;
    if (form && ack.kind === "version") advanceCockpitInputForm(draftKey, form.generation, { inputId: ack.result.receipt.inputId, inputRevision: ack.result.receipt.inputRevision, versionId: ack.result.receipt.versionId, transferId: ack.result.receipt.transferId, transferRevision: ack.result.receipt.transferRevision });
    if (form && ack.kind === "restart") advanceCockpitInputForm(draftKey, form.generation, { transferId: ack.result.receipt.transferId, transferRevision: ack.result.receipt.revision });
    if (form && (ack.kind === "finalize" || ack.kind === "abandon")) clearCockpitInputForm(draftKey, form);
    toast.success(t(($) => $.input_materials.operation_confirmed)); onConfirmed();
  }
  return <div className="space-y-2"><CockpitInputCommandRecovery pending={Boolean(request.pending)} busy={request.busy} canRetry={false} onVerify={() => void verify()} />
    {request.error && <p role="alert" className="break-words text-caption text-destructive">{request.error}</p>}
  </div>;
}
