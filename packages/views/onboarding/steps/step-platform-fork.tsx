"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { captureEvent } from "@multica/core/analytics";
import { Button } from "@multica/ui/components/ui/button";
import type { AgentRuntime } from "@multica/core/types";
import {
  runtimeDisplayLabel,
  runtimeNodeLabel,
  normalizeNodeLabel,
} from "@multica/core/runtimes";
import { useConfigStore } from "@multica/core/config";
import { StepFooter, StepHeading } from "../components/step-shell";
import { CompactRuntimeRow } from "../../runtimes/components/compact-runtime-row";
import { useRuntimePicker } from "../components/use-runtime-picker";
import { useT } from "../../i18n";

/**
 * Web onboarding lists the workspace's public runtimes. Their execution
 * location depends on the deployment: this Mac or an authorized remote node.
 * This step selects an existing runtime; installation remains in Settings.
 */
export function StepPlatformFork({
  wsId,
  onNext,
}: {
  wsId: string;
  onNext: (runtime: AgentRuntime | null) => void | Promise<void>;
}) {
  const { t } = useT("onboarding");

  // List the whole workspace and keep the existing public-visibility gate;
  // the runtime's deployment location does not change this access rule.
  const picker = useRuntimePicker(wsId, "all");
  const sharedRuntimes = picker.runtimes.filter(
    (rt) => rt.visibility === "public",
  );
  const hasShared = sharedRuntimes.length > 0;

  // The node co-located with the API server (BayClaw fork,
  // DEFAULT_ISSUE_ASSIGNEE_NODE) — when set, its Claude runtime is the
  // default pick instead of an arbitrary online fleet worker.
  const defaultNode = useConfigStore((s) => s.defaultIssueAssigneeNode);
  const preferredRuntime = defaultNode
    ? sharedRuntimes.find(
        (rt) =>
          rt.provider === "claude" &&
          rt.status === "online" &&
          normalizeNodeLabel(runtimeNodeLabel(rt.device_info)) ===
            normalizeNodeLabel(defaultNode),
      )
    : undefined;

  // Tracks an explicit row click so it always wins over the local-Claude
  // default above, even after the shared-runtime list refetches.
  const [manualId, setManualId] = useState<string | null>(null);
  const selected = manualId
    ? (sharedRuntimes.find((rt) => rt.id === manualId) ?? null)
    : (preferredRuntime ??
      (picker.selected && picker.selected.visibility === "public"
        ? picker.selected
        : (sharedRuntimes.find((rt) => rt.status === "online") ??
          sharedRuntimes[0] ??
          null)));

  const handleSelect = (id: string) => {
    setManualId(id);
    picker.setSelectedId(id);
  };

  const handleContinue = () => {
    if (!selected) return;
    captureEvent("onboarding_runtime_path_selected", {
      workspace_id: wsId,
      path: "cloud_shared",
      source: "onboarding",
      surface: "step3",
    });
    void onNext(selected);
  };

  return (
    <>
      <StepHeading
        title={
          hasShared
            ? t(($) => $.step_platform.cloud_ready_headline)
            : t(($) => $.step_platform.cloud_waiting_headline)
        }
        description={
          hasShared
            ? t(($) => $.step_platform.cloud_ready_lede)
            : t(($) => $.step_platform.cloud_waiting_lede)
        }
      />

      <div className="mt-8 flex flex-col gap-3">
        {hasShared ? (
          <>
            <div className="flex items-center gap-2 text-body">
              <span
                aria-hidden
                className="inline-block size-2 shrink-0 rounded-full bg-success"
              />
              <span className="font-medium">
                {t(($) => $.step_platform.runtimes_connected, {
                  count: sharedRuntimes.length,
                })}
              </span>
            </div>
            <div className="flex max-h-[280px] flex-col gap-2 overflow-y-auto">
              {sharedRuntimes.map((rt) => (
                <CompactRuntimeRow
                  key={rt.id}
                  runtime={rt}
                  selected={rt.id === (selected?.id ?? null)}
                  onSelect={() => handleSelect(rt.id)}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-4">
            <span
              aria-hidden
              className="inline-block size-2 shrink-0 rounded-full bg-success animate-pulse"
            />
            <span className="text-label leading-[1.55] text-muted-foreground">
              {t(($) => $.step_platform.cloud_waiting_hint)}
            </span>
          </div>
        )}
      </div>

      <StepFooter
        hint={
          hasShared && selected
            ? t(($) => $.step_runtime.hint_selected, {
                // Not selected.name: a user-set custom_name alias would
                // otherwise be ignored here while every other runtime
                // surface shows it (MUL-4217).
                name: runtimeDisplayLabel(selected),
              })
            : t(($) => $.step_platform.cloud_waiting_footer)
        }
      >
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => onNext(null)}
          >
            {t(($) => $.step_runtime.skip)}
          </Button>
          <Button
            className="flex-1"
            disabled={!selected}
            onClick={handleContinue}
          >
            {t(($) => $.step_runtime.start_exploring)}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </StepFooter>
    </>
  );
}
