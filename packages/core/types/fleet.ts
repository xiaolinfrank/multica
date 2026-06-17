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
  /** Apple Silicon chip, e.g. "Apple M4". */
  chip: string;
  /** GPU active-residency percentage (0 when idle or unavailable). */
  gpu_percent: number;
  /** SoC total power draw (CPU+GPU+ANE) in watts. */
  system_power_w: number;
  /** Thermal pressure: "Nominal" | "Fair" | "Serious" | "Critical" | "". */
  thermal_pressure: string;
  /** en0 receive throughput, bytes/sec. */
  net_rx_bytes_sec: number;
  /** en0 transmit throughput, bytes/sec. */
  net_tx_bytes_sec: number;
  /** Whether this device's agent daemon/runtime is online for the current
   *  workspace. Distinct from `online` (SSH reachability) — a box can be
   *  reachable while its daemon is down. */
  runtime_online: boolean;
  /** Agent providers the device's daemon serves (e.g. ["hermes"]). */
  providers: string[];
  /** Tasks the device is actively running right now. */
  running_tasks: number;
  /** Tasks queued for this device's runtime, waiting to be claimed. */
  queued_tasks: number;
  /** multica daemon/CLI version reported by the runtime. */
  daemon_version: string;
  error?: string;
}

export interface FleetStatus {
  devices: FleetDevice[];
  /** RFC3339 timestamp of when the snapshot was gathered. */
  collected_at: string;
}
