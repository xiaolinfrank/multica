// Compute pool (fleet) status types. These mirror the Go response from
// GET /api/fleet/status (server/internal/fleet) — fields are snake_case to
// match the wire format. The dashboard treats every device as possibly
// offline and every metric as possibly zero; see packages/views/fleet.

/** Docker daemon state on a device. Treated as an open string (with a
 *  generic fallback in the UI) so a future value never crashes the page. */
export type FleetDockerState = "running" | "stopped" | "absent" | "unknown";

export interface FleetDevice {
  id: string;
  name: string;
  host: string;
  labels: string[];
  /** True for the coordinator host the server runs on (probed locally). */
  local: boolean;
  /** False when the probe failed; `error` then carries a short reason. */
  online: boolean;
  hostname: string;
  os: string;
  cpu_percent: number;
  mem_used_percent: number;
  disk_used_percent: number;
  load1: number;
  ncpu: number;
  uptime_seconds: number;
  docker: FleetDockerState;
  containers: number;
  error?: string;
}

export interface FleetStatus {
  devices: FleetDevice[];
  /** RFC3339 timestamp of when the snapshot was gathered. */
  collected_at: string;
}
