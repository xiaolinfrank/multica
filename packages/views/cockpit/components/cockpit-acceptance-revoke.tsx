"use client";

import { useRef, useState } from "react";
import { useRevokeCockpitAcceptanceApproval } from "@multica/core/cockpit";
import { ApiError } from "@multica/core/api";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@multica/ui/components/ui/dialog";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";

// R2 reverse command: withdrawing the approval in force returns the L3 to
// awaiting acceptance; the historical decision rows stay on record.
export function CockpitAcceptanceRevoke({ wsId, nodeId, requestId, disabled }: {
  wsId: string; nodeId: string; requestId: string; disabled: boolean;
}) {
  const { t } = useT("cockpit");
  const revoke = useRevokeCockpitAcceptanceApproval(wsId);
  const [open, setOpen] = useState(false); const [reason, setReason] = useState(""); const [error, setError] = useState("");
  const lock = useRef(false);
  const trimmed = reason.trim();
  const valid = Boolean(trimmed && new TextEncoder().encode(trimmed).length <= 16000);
  async function submit() {
    if (lock.current || disabled || !valid) return;
    lock.current = true; setError("");
    try { await revoke.mutateAsync({ nodeId, requestId, reason: trimmed }); setOpen(false); setReason(""); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : t(($) => $.task_flow.unconfirmed)); }
    finally { lock.current = false; }
  }
  return <Dialog open={open} onOpenChange={(next) => { if (lock.current) return; if (next) setError(""); setOpen(next); }}>
    <DialogTrigger render={<Button size="sm" variant="outline" disabled={disabled} />}>{t(($) => $.acceptance.revoke_approval)}</DialogTrigger>
    <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{t(($) => $.acceptance.revoke_approval)}</DialogTitle><DialogDescription>{t(($) => $.acceptance.revoke_hint)}</DialogDescription></DialogHeader>
      <div className="space-y-3">
        <label className="block space-y-1 text-caption"><span>{t(($) => $.artifact_runtime.reason)}</span><Textarea value={reason} disabled={revoke.isPending} onChange={(event) => setReason(event.target.value)} /></label>
        {reason.length > 0 && !valid && <p className="text-caption text-destructive">{t(($) => $.acceptance.revoke_reason_required)}</p>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      </div>
      <DialogFooter><DialogClose render={<Button variant="outline" disabled={revoke.isPending} />}>{t(($) => $.task_create.cancel)}</DialogClose>
        <Button type="button" disabled={disabled || revoke.isPending || !valid} aria-busy={revoke.isPending} onClick={() => void submit()}>{revoke.isPending && <Spinner />}{t(($) => $.acceptance.revoke_confirm)}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
