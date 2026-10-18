"use client";

import { Button } from "@multica/ui/components/ui/button";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { useT } from "../../i18n";

export function CockpitInputCommandRecovery({ pending, busy, canRetry, onVerify, onRetry }: {
  pending: boolean;
  busy: boolean;
  canRetry: boolean;
  onVerify: () => void;
  onRetry?: () => void;
}) {
  const { t } = useT("cockpit");
  if (!pending) return null;
  return <div className="space-y-3 rounded-lg border border-border p-3 text-caption">
    <p role="status">{t(($) => $.input_materials.command_unconfirmed)}</p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" disabled={busy} aria-busy={busy} onClick={onVerify}>
        {busy && <Spinner aria-hidden="true" />}{t(($) => $.input_materials.verify_command)}
      </Button>
      {canRetry && onRetry && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRetry}>{t(($) => $.input_materials.retry_command)}</Button>}
    </div>
    {canRetry && <p className="text-muted-foreground">{t(($) => $.input_materials.command_not_found)}</p>}
  </div>;
}
