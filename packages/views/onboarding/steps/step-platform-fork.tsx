"use client";

import { useRef } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { captureEvent } from "@multica/core/analytics";
import { Button } from "@multica/ui/components/ui/button";
import { useScrollFade } from "@multica/ui/hooks/use-scroll-fade";
import type { AgentRuntime } from "@multica/core/types";
import { DragStrip } from "@multica/views/platform";
import { StepHeader } from "../components/step-header";
import { RuntimeAsidePanel } from "../components/runtime-aside-panel";
import { CompactRuntimeRow } from "../components/compact-runtime-row";
import { useRuntimePicker } from "../components/use-runtime-picker";
import { useT } from "../../i18n";

/**
 * Step 3 on **web**. BayClaw is a server-centric deployment: agents run
 * on shared runtimes operated by the platform team, so there is nothing
 * for the user to install. This screen lists the workspace's shared
 * (public) runtimes live and lets the user pick one to continue.
 *
 * If no shared runtime is online yet (a fresh workspace whose runner
 * hasn't been provisioned), the screen shows a waiting state and the
 * user can skip and bind a runtime later.
 */

export function StepPlatformFork({
  wsId,
  onNext,
  onBack,
}: {
  wsId: string;
  onNext: (runtime: AgentRuntime | null) => void | Promise<void>;
  onBack?: () => void;
}) {
  const { t } = useT("onboarding");
  const mainRef = useRef<HTMLElement>(null);
  const fadeStyle = useScrollFade(mainRef);

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
    <div className="animate-onboarding-enter grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_480px]">
      {/* Left — DragStrip + 3-region app shell */}
      <div className="flex min-h-0 flex-col">
        <DragStrip />

        <header className="flex shrink-0 items-center gap-4 bg-background px-6 py-3 sm:px-10 md:px-14 lg:px-16">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {t(($) => $.common.back)}
            </button>
          ) : (
            <span aria-hidden className="w-0" />
          )}
          <div className="flex-1">
            <StepHeader currentStep="runtime" />
          </div>
        </header>

        <main
          ref={mainRef}
          style={fadeStyle}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto w-full max-w-[620px] px-6 py-10 sm:px-10 md:px-14 lg:px-0 lg:py-14">
            <div className="mb-2 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {t(($) => $.step_platform.cloud_ready_eyebrow)}
            </div>
            <h1 className="text-balance font-serif text-[36px] font-medium leading-[1.1] tracking-tight text-foreground">
              {hasShared
                ? t(($) => $.step_platform.cloud_ready_headline)
                : t(($) => $.step_platform.cloud_waiting_headline)}
            </h1>
            <p className="mt-4 max-w-[560px] text-[15.5px] leading-[1.55] text-muted-foreground">
              {hasShared
                ? t(($) => $.step_platform.cloud_ready_lede)
                : t(($) => $.step_platform.cloud_waiting_lede)}
            </p>

            <div className="mt-10 flex max-w-[560px] flex-col gap-3.5">
              {hasShared ? (
                <>
                  <div className="flex items-center gap-2 text-sm">
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
                  <span className="text-[13px] leading-[1.55] text-muted-foreground">
                    {t(($) => $.step_platform.cloud_waiting_hint)}
                  </span>
                </div>
              )}
            </div>

            {/* Inline action bar — hint on the left, Skip + Continue on
                the right. Continue is enabled once a shared runtime is
                selected; Skip creates the self-serve onboarding issue. */}
            <div className="mt-8 flex max-w-[560px] flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <span aria-live="polite" className="text-xs text-muted-foreground">
                {hasShared && selected
                  ? t(($) => $.step_runtime.hint_selected, {
                      name: selected.name,
                    })
                  : t(($) => $.step_platform.cloud_waiting_footer)}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => onNext(null)}>
                  {t(($) => $.step_runtime.skip)}
                </Button>
                <Button disabled={!selected} onClick={handleContinue}>
                  {t(($) => $.step_runtime.start_exploring)}
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* Right — always-visible aside */}
      <aside className="hidden min-h-0 border-l bg-muted/40 lg:flex lg:flex-col">
        <DragStrip />
        <div className="min-h-0 flex-1 overflow-y-auto px-12 py-12">
          <RuntimeAsidePanel />
        </div>
      </aside>
    </div>
  );
}
