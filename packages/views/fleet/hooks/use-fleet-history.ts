import { useEffect, useRef, useState } from "react";
import type { FleetStatus } from "@multica/core/types";

/**
 * useFleetHistory — a view-local rolling history for the fleet board.
 *
 * The API only returns point-in-time snapshots (no server-side history), so we
 * build a client-side time series: on every fresh `FleetStatus` we append the
 * current CPU / GPU / Memory value for each device into a bounded ring buffer,
 * plus a pool-aggregate (average over online nodes) series for the Cluster
 * Vitals trend.
 *
 * Design notes / caveats:
 *  - This is *ephemeral derived UI state*. It lives entirely in this hook
 *    (refs + a render-trigger state), never in a global store, and is NOT
 *    persisted — history resets on reload, which is expected for a live board.
 *  - Dedup is keyed on `collected_at`: React can re-render with the same query
 *    data (e.g. a refetch that returned an identical snapshot), and we must not
 *    double-append. A new sample is only recorded when the snapshot timestamp
 *    changes.
 *  - We never fabricate or backfill history; series start empty and grow.
 *  - Offline nodes stop appending (the series simply pauses / flatlines), so
 *    the sparkline renders a gap-free but stale trend that the UI greys out.
 */

export const FLEET_HISTORY_CAP = 60; // ~5 min at the 5s refetch cadence.

export interface MetricSeries {
  cpu: number[];
  gpu: number[];
  mem: number[];
}

export interface FleetHistory {
  /** Per-device rolling series, keyed by device id. */
  devices: Record<string, MetricSeries>;
  /** Pool aggregate (avg over online nodes) rolling series. */
  pool: MetricSeries;
  /** Number of aggregate samples collected so far. */
  samples: number;
}

function emptySeries(): MetricSeries {
  return { cpu: [], gpu: [], mem: [] };
}

function push(buf: number[], v: number): number[] {
  const next = buf.length >= FLEET_HISTORY_CAP ? buf.slice(1) : buf.slice();
  next.push(Number.isFinite(v) ? v : 0);
  return next;
}

export function useFleetHistory(status: FleetStatus | undefined): FleetHistory {
  const historyRef = useRef<FleetHistory>({
    devices: {},
    pool: emptySeries(),
    samples: 0,
  });
  const lastStampRef = useRef<string | null>(null);
  // A monotonically increasing tick forces a re-render when (and only when) a
  // new sample is actually appended, so consumers see fresh arrays.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!status) return;
    const stamp = status.collected_at;
    // Dedup: same snapshot → no append (prevents double-counting on re-render).
    if (stamp && stamp === lastStampRef.current) return;
    lastStampRef.current = stamp ?? null;

    const prev = historyRef.current;
    const devices = { ...prev.devices };
    const seenIds = new Set<string>();

    let cpuSum = 0;
    let gpuSum = 0;
    let memSum = 0;
    let onlineCount = 0;

    for (const d of status.devices) {
      seenIds.add(d.id);
      const series = devices[d.id] ?? emptySeries();
      if (d.online) {
        devices[d.id] = {
          cpu: push(series.cpu, d.cpu_percent),
          gpu: push(series.gpu, d.gpu_percent),
          mem: push(series.mem, d.mem_used_percent),
        };
        cpuSum += d.cpu_percent;
        gpuSum += d.gpu_percent;
        memSum += d.mem_used_percent;
        onlineCount += 1;
      } else {
        // Offline: keep the existing series untouched (pause, don't append).
        devices[d.id] = series;
      }
    }

    // Drop history for devices no longer present in the snapshot.
    for (const id of Object.keys(devices)) {
      if (!seenIds.has(id)) delete devices[id];
    }

    const pool: MetricSeries = onlineCount
      ? {
          cpu: push(prev.pool.cpu, cpuSum / onlineCount),
          gpu: push(prev.pool.gpu, gpuSum / onlineCount),
          mem: push(prev.pool.mem, memSum / onlineCount),
        }
      : prev.pool;

    historyRef.current = {
      devices,
      pool,
      samples: prev.samples + 1,
    };
    setTick((n) => n + 1);
  }, [status]);

  return historyRef.current;
}
