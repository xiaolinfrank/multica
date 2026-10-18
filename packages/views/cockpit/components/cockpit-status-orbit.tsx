"use client";

import { useId } from "react";
import type { CockpitOverviewIssueCounts } from "@multica/core/types";
import { useT } from "../../i18n";

/** The chart mirrors the status distribution, not formal acceptance or progress. */
export function CockpitStatusOrbit({ counts }: { counts: CockpitOverviewIssueCounts }) {
  const { t } = useT("cockpit");
  const id = useId();
  const parts = [
    { key: "unstarted", count: counts.unstarted },
    { key: "started", count: counts.started },
    { key: "done", count: counts.done },
    { key: "closed", count: counts.closed },
    { key: "unknown", count: counts.unknown },
  ];
  const valid = counts.total > 0 && parts.every((part) => Number.isFinite(part.count) && part.count >= 0)
    && parts.reduce((sum, part) => sum + part.count, 0) === counts.total;
  const segments = parts.map((part, index) => ({ ...part,
    length: valid ? part.count / counts.total * 100 : 0,
    offset: valid ? parts.slice(0, index).reduce((sum, previous) => sum + previous.count, 0) / counts.total * 100 : 0,
  }));
  return <div className="cockpit-status-orbit">
    <svg viewBox="0 0 200 220" aria-hidden="true" className="cockpit-orbit-chart">
      <defs>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="var(--cockpit-metal-light)" /><stop offset="0.42" stopColor="var(--cockpit-metal-mid)" /><stop offset="0.65" stopColor="var(--cockpit-metal-light)" /><stop offset="1" stopColor="var(--cockpit-metal-deep)" /></linearGradient>
        <radialGradient id={`${id}-face`} cx="0.36" cy="0.25" r="0.8"><stop stopColor="var(--cockpit-metal-light)" /><stop offset="1" stopColor="var(--cockpit-paper)" /></radialGradient>
        <radialGradient id={`${id}-shadow`}><stop stopColor="var(--cockpit-ink)" stopOpacity="0.17" /><stop offset="1" stopColor="var(--cockpit-ink)" stopOpacity="0" /></radialGradient>
      </defs>
      <ellipse cx="100" cy="200" rx="83" ry="16" fill={`url(#${id}-shadow)`} />
      <circle className="cockpit-orbit-plinth" cx="100" cy="103" r="86" fill={`url(#${id}-rim)`} />
      <circle className="cockpit-orbit-face" cx="100" cy="96" r="86" fill={`url(#${id}-face)`} />
      <circle className="cockpit-orbit-ticks" cx="100" cy="96" r="78" pathLength="100" />
      <circle className="cockpit-orbit-track" cx="100" cy="96" r="65" />
      {segments.filter((part) => part.length > 0).map((part) => <circle key={part.key} data-status={part.key}
        className="cockpit-orbit-segment" cx="100" cy="96" r="65" pathLength="100"
        strokeDasharray={`${part.length} ${100 - part.length}`} strokeDashoffset={-part.offset} transform="rotate(-90 100 96)" />)}
      <circle className="cockpit-orbit-core" cx="100" cy="96" r="51" fill={`url(#${id}-face)`} />
      <path d="M 39 68 A 67 67 0 0 1 162 72" className="cockpit-orbit-specular" />
    </svg>
    <div className="cockpit-orbit-readout" data-digits={String(counts.active).length}><span className={`${String(counts.active).length > 7 ? "text-title-lg" : String(counts.active).length > 4 ? "text-display-sm" : "text-display"} font-semibold tabular-nums`}>{counts.active}</span>
      <span className="text-caption">{t(($) => $.work_overview.active_tasks)}</span></div>
  </div>;
}
