"use client";

import type { ReactNode } from "react";
import { Progress } from "@multica/ui/components/ui/progress";
import { Spinner } from "@multica/ui/components/ui/spinner";
import { formatBytes } from "../../common/format-bytes";
import { useT } from "../../i18n";

export function CockpitInputTransferStatus({ state, receivedBytes, expectedBytes, error, recovery }: {
  state: string;
  receivedBytes: number | null;
  expectedBytes: number;
  error?: ReactNode;
  recovery?: ReactNode;
}) {
  const { t } = useT("cockpit");
  const labels: Record<string, string> = {
    awaiting_bytes: t(($) => $.input_materials.awaiting_bytes),
    queued: t(($) => $.input_materials.queued),
    reading: t(($) => $.input_materials.reading),
    pinned: t(($) => $.input_materials.pinned),
    writing: t(($) => $.input_materials.writing),
    verifying: t(($) => $.input_materials.verifying),
    awaiting_finalize: t(($) => $.input_materials.awaiting_finalize),
    verified: t(($) => $.input_materials.verified),
    failed: t(($) => $.input_materials.failed),
    abandoned: t(($) => $.input_materials.abandoned),
    expired: t(($) => $.input_materials.expired),
  };
  const label = labels[state] ?? t(($) => $.input_materials.unknown_state);
  const active = ["queued", "reading", "pinned", "writing", "verifying"].includes(state);
  const measurable = state === "reading" && receivedBytes !== null && Number.isSafeInteger(receivedBytes) && receivedBytes >= 0
    && Number.isSafeInteger(expectedBytes) && expectedBytes > 0 && receivedBytes <= expectedBytes;
  return <div className="min-w-0 space-y-3 rounded-lg border border-border p-3">
    <p role="status" className="flex items-center gap-2 text-caption font-medium">{active && <Spinner aria-hidden="true" />}{label}</p>
    {measurable && <div className="space-y-2">
      <Progress value={(receivedBytes / expectedBytes) * 100} aria-label={t(($) => $.input_materials.received_progress)} />
      <p className="text-caption text-muted-foreground tabular-nums">{t(($) => $.input_materials.received_bytes, { received: formatBytes(receivedBytes), total: formatBytes(expectedBytes) })}</p>
    </div>}
    {state === "awaiting_finalize" && <p className="text-caption text-muted-foreground">{t(($) => $.input_materials.finalize_hint)}</p>}
    {error && <div role="alert" className="break-words text-caption text-destructive [overflow-wrap:anywhere]">{error}</div>}
    {recovery && <div className="flex flex-wrap items-center gap-2">{recovery}</div>}
  </div>;
}
