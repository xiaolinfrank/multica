"use client";
import type { CockpitLifecycleCommandDetail } from "@multica/core/types";
import { Button } from "@multica/ui/components/ui/button";
import { useT } from "../../i18n";
import type { useCockpitMeetingCommand } from "./use-cockpit-meeting-command";

export function CockpitMeetingCommandRecovery({ command, onConfirmed, onCurrentConfirmed }: {
  command: ReturnType<typeof useCockpitMeetingCommand>; onConfirmed?: () => void; onCurrentConfirmed?: (result: CockpitLifecycleCommandDetail) => void;
}) {
  const { t } = useT("cockpit");
  if (!command.pending) return null;
  return <div className="space-y-2"><p className="text-caption text-muted-foreground">{t(($) => $.meeting_lifecycle.pending_hint)}</p>
    <Button type="button" variant="outline" size="sm" disabled={command.busy} onClick={() => { void command.verify().then((response) => {
      if (!response) return; onConfirmed?.(); if (response.stillCurrent()) onCurrentConfirmed?.(response.result);
    }); }}>{t(($) => $.meeting_lifecycle.check_command)}</Button>
  </div>;
}
