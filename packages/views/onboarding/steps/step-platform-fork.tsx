"use client";

import { ArrowRight } from "lucide-react";
import { captureEvent } from "@multica/core/analytics";
import { Button } from "@multica/ui/components/ui/button";
import type { AgentRuntime } from "@multica/core/types";
import { runtimeDisplayLabel } from "@multica/core/runtimes";
import { StepFooter, StepHeading } from "../components/step-shell";
import { CompactRuntimeRow } from "../../runtimes/components/compact-runtime-row";
import { useRuntimePicker } from "../components/use-runtime-picker";
import { useT } from "../../i18n";

/**
 * Step 3 on **web**. BayClaw is a server-centric deployment: agents run on
 * shared runtimes operated by the platform team, so there is nothing for
 * the user to install. This screen lists the workspace's shared (public)
 * runtimes live and lets the user pick one to continue.
 *
 * If no shared runtime is online yet (a fresh workspace whose runner has
 * not been provisioned), the screen shows a waiting state and the user can
 * skip and bind a runtime later.
 *
 * Rendered inside <StepShell>, so this component owns only the column body
 * (a StepHeading, the shared-runtime list or waiting state, and a StepFooter
 * with Skip / Continue). Back is owned by the shell's rail. Unlike the CLI
 * path, no model picker is offered — a shared runtime runs on the model the
 * platform team configured for it.
 */
export function StepPlatformFork({
  wsId,
  onNext,
}: {
  wsId: string;
  onNext: (runtime: AgentRuntime | null) => void | Promise<void>;
}) {
  const { t } = useT("onboarding");

  // Shared runtimes are registered by the platform's server-side runner
  // account, so they are not owned by the onboarding user — list the
  // whole workspace and keep only the publicly usable ones.
  const picker = useRuntimePicker(wsId, "all");
  const sharedRuntimes = picker.runtimes.filter(
    (rt) => rt.visibility === "public",
  );
  const hasShared = sharedRuntimes.length > 0;
  const selected =
    picker.selected && picker.selected.visibility === "public"
      ? picker.selected
      : (sharedRuntimes.find((rt) => rt.status === "online") ??
        sharedRuntimes[0] ??
        null);

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
                  onSelect={() => picker.setSelectedId(rt.id)}
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
