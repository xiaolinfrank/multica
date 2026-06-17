"use client";

import { useMemo } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Box,
  Clock,
  Cpu,
  Gauge,
  HardDrive,
  ListChecks,
  MemoryStick,
  Network,
  Radio,
  Server,
  Thermometer,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  LazyMotion,
  domAnimation,
  m,
  useReducedMotion,
  type Variants,
} from "motion/react";
import { fleetStatusOptions } from "@multica/core/fleet";
import type { FleetDevice, FleetDockerState } from "@multica/core/types";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { useT } from "../../i18n";
import { RadialGauge } from "./radial-gauge";
import { Sparkline } from "./sparkline";
import { useFleetHistory } from "../hooks/use-fleet-history";

type FleetT = ReturnType<typeof useT<"fleet">>["t"];

// Per-metric identity hue. Each metric owns one hue everywhere it appears
// (gauge ring, sparkline, vitals meter, heat-strip) so it stays recognisable.
// These are *identity* colours, separate from health tones below. The classes
// set `color`, which currentColor-driven widgets inherit.
const METRIC = {
  cpu: "fleet-metric-cpu",
  gpu: "fleet-metric-gpu",
  mem: "fleet-metric-mem",
  disk: "fleet-metric-disk",
  net: "fleet-metric-net",
} as const;

// ---------------------------------------------------------------------------
// Motion orchestration. The console performs ONE deliberate page-load: the
// command bar drops in, then the vitals band, then the node grid reveals with
// a spring-driven stagger. Children share a single parent → one timeline, not
// scattered jitter. Gated behind prefers-reduced-motion (the hook returns the
// same variants but with instant transitions so layout is identical).
// ---------------------------------------------------------------------------
const SPRING = { type: "spring", stiffness: 240, damping: 26, mass: 0.9 } as const;

const stageVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.04 } },
};

const riseVariants: Variants = {
  hidden: { opacity: 0, y: 16, filter: "blur(6px)" },
  show: { opacity: 1, y: 0, filter: "blur(0px)", transition: SPRING },
};

const gridVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.12 } },
};

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 22, scale: 0.985 },
  show: { opacity: 1, y: 0, scale: 1, transition: SPRING },
};

// Health tone for a usage reading. Reserved for *status* semantics only: a
// reading crosses warning/critical thresholds. Below the warning line a metric
// keeps its identity hue rather than going green, so the board reads as
// "identity by default, alert on pressure" instead of a wall of traffic-lights.
function healthTone(pct: number): string | null {
  if (pct >= 85) return "text-destructive";
  if (pct >= 60) return "text-warning";
  return null;
}

// Resolve the colour a metric widget should paint with: its identity hue, or a
// health tone once the reading is under pressure.
function metricTone(metricClass: string, pct: number): string {
  return healthTone(pct) ?? metricClass;
}

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Human-friendly bytes/sec: B/s → KB/s → MB/s → GB/s. Decimal SI steps so the
// readout matches what users see in Activity Monitor.
function formatBytesPerSec(bytes: number): { value: string; unit: string } {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: "0", unit: "B/s" };
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  const value = v >= 100 || i === 0 ? Math.round(v).toString() : v.toFixed(1);
  return { value, unit: units[i] ?? "B/s" };
}

// Enum-drift safe: an unknown server value downgrades to the generic chip.
function dockerVisual(state: FleetDockerState | string): { dot: string; tone: string } {
  switch (state) {
    case "running":
      return { dot: "bg-success", tone: "border-success/30 text-success" };
    case "stopped":
      return { dot: "bg-warning", tone: "border-warning/30 text-warning" };
    case "absent":
      return { dot: "bg-muted-foreground/40", tone: "border-border text-muted-foreground" };
    default:
      return { dot: "bg-muted-foreground/40", tone: "border-border text-muted-foreground" };
  }
}

function dockerLabel(t: FleetT, state: FleetDockerState | string): string {
  switch (state) {
    case "running":
      return t(($) => $.docker.running);
    case "stopped":
      return t(($) => $.docker.stopped);
    case "absent":
      return t(($) => $.docker.absent);
    default:
      return t(($) => $.docker.unknown);
  }
}

// Thermal pressure → {0..3 active segments, tone, label}. Enum-drift safe:
// an empty/unknown string renders the muted "unavailable" state (the
// coordinator lacks the powermetrics grant), never a crash.
type Thermal = { active: number; tone: string; label: string; available: boolean };
function thermalVisual(t: FleetT, pressure: string): Thermal {
  switch (pressure) {
    case "Nominal":
      return { active: 1, tone: "text-success", label: t(($) => $.thermal_level.nominal), available: true };
    case "Fair":
      return { active: 2, tone: "text-warning", label: t(($) => $.thermal_level.fair), available: true };
    case "Serious":
      return { active: 3, tone: "text-destructive", label: t(($) => $.thermal_level.serious), available: true };
    case "Critical":
      return { active: 4, tone: "text-destructive", label: t(($) => $.thermal_level.critical), available: true };
    default:
      return { active: 0, tone: "text-muted-foreground", label: t(($) => $.thermal_level.unknown), available: false };
  }
}

function StatusDot({ online, size = "md" }: { online: boolean; size?: "sm" | "md" }) {
  const dim = size === "sm" ? "h-1.5 w-1.5" : "h-2.5 w-2.5";
  return (
    <span className={cn("relative flex", dim)}>
      {online && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
      )}
      <span
        className={cn(
          "relative inline-flex rounded-full",
          dim,
          online ? "bg-success" : "bg-muted-foreground/40",
        )}
      />
    </span>
  );
}

/** A thin horizontal usage meter with a token-tinted, animated fill. */
function MeterBar({
  pct,
  toneClass,
  className,
}: {
  pct: number;
  toneClass: string;
  className?: string;
}) {
  const v = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div
        className={cn("fleet-meter-fill h-full rounded-full transition-[width] duration-700 ease-out", toneClass)}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}

/** Segmented thermal indicator — 4 ticks, fills up to the active level. */
function ThermalMeter({ thermal }: { thermal: Thermal }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-end gap-0.5">
        {["h-1.5", "h-2", "h-2.5", "h-3"].map((heightCls, i) => {
          const lit = i < thermal.active;
          const isPeak = thermal.active >= 3 && i === thermal.active - 1;
          return (
            <span
              key={i}
              className={cn(
                "w-1 rounded-sm bg-current",
                // staircase heights so it reads like a level meter
                heightCls,
                lit ? thermal.tone : "text-muted opacity-60",
                isPeak && "fleet-thermal-pulse",
              )}
            />
          );
        })}
      </div>
      <span className={cn("text-[10px] font-medium tabular-nums", thermal.tone)}>
        {thermal.label}
      </span>
    </div>
  );
}

/** Compact rx/tx network readout with directional glyphs + human units. */
function NetReadout({ rx, tx, t }: { rx: number; tx: number; t: FleetT }) {
  const down = formatBytesPerSec(rx);
  const up = formatBytesPerSec(tx);
  const active = rx > 0 || tx > 0;
  return (
    <div className="flex items-center gap-2.5 font-mono text-[10px] tabular-nums">
      <span
        className={cn("flex items-center gap-0.5", active ? "text-foreground" : "text-muted-foreground")}
        title={t(($) => $.net.down)}
      >
        <ArrowDown className={cn("h-3 w-3", rx > 0 ? "text-success" : "text-muted-foreground")} />
        {down.value}
        <span className="text-muted-foreground">{down.unit}</span>
      </span>
      <span
        className={cn("flex items-center gap-0.5", active ? "text-foreground" : "text-muted-foreground")}
        title={t(($) => $.net.up)}
      >
        <ArrowUp className={cn("h-3 w-3", tx > 0 ? "text-brand" : "text-muted-foreground")} />
        {up.value}
        <span className="text-muted-foreground">{up.unit}</span>
      </span>
    </div>
  );
}

/** A labelled stat block, used in the per-card hardware grid. */
function MicroStat({
  label,
  Icon,
  children,
}: {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-background/40 px-2.5 py-2">
      <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </span>
      {children}
    </div>
  );
}

/** A labelled per-node sparkline row: metric glyph + identity-coloured trend. */
function NodeSpark({
  label,
  Icon,
  metricClass,
  data,
  online,
  t,
}: {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  metricClass: string;
  data: number[];
  online: boolean;
  t: FleetT;
}) {
  const hasHistory = data.length > 1;
  return (
    <div className={cn("flex flex-col gap-1", metricClass)}>
      <span className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="h-2.5 w-2.5" />
        {label}
      </span>
      <div className="h-6 w-full">
        {hasHistory ? (
          <Sparkline data={data} height={24} range="percent" muted={!online} live={online} />
        ) : (
          <span className="flex h-6 items-center text-[9px] tabular-nums text-muted-foreground/70">
            {t(($) => $.trend.collecting)}
          </span>
        )}
      </div>
    </div>
  );
}

function DeviceCard({
  device,
  history,
  t,
}: {
  device: FleetDevice;
  history?: { cpu: number[]; gpu: number[]; mem: number[] };
  t: FleetT;
}) {
  const online = device.online;
  const docker = dockerVisual(device.docker);
  const busy = online && device.running_tasks > 0;
  const thermal = thermalVisual(t, device.thermal_pressure);

  return (
    <m.div variants={cardVariants}>
      <div
        className={cn(
          "group relative h-full overflow-hidden rounded-xl border bg-card/80 backdrop-blur-sm transition-colors",
          online ? "fleet-panel border-border hover:border-brand/40" : "border-border/60 opacity-75",
          busy && "fleet-node-active fleet-panel-glow border-success/40",
        )}
      >
        {/* Top accent rail — the "online" glow that gives the grid its pulse. */}
        <div
          className={cn(
            "h-0.5 w-full",
            online
              ? "bg-gradient-to-r from-brand/80 via-brand/20 to-transparent"
              : "bg-gradient-to-r from-muted-foreground/30 to-transparent",
          )}
        />

        <div className="space-y-3 p-4">
          {/* Header */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <StatusDot online={online} />
                <span className="fleet-display truncate text-sm font-semibold tracking-wide">
                  {device.name}
                </span>
                {device.local ? (
                  <span className="flex shrink-0 items-center gap-0.5 rounded border border-brand/30 bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-brand">
                    <Radio className="h-2.5 w-2.5" />
                    {t(($) => $.coordinator)}
                  </span>
                ) : (
                  <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t(($) => $.runtime.label)}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 pl-[18px]">
                {device.chip && (
                  <span
                    className="flex shrink-0 items-center gap-1 rounded border border-brand/20 bg-brand/5 px-1.5 py-0.5 text-[10px] font-medium text-brand"
                    title={t(($) => $.hw.chip)}
                  >
                    <Cpu className="h-2.5 w-2.5" />
                    {device.chip}
                  </span>
                )}
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {device.host}
                  {device.os ? ` · macOS ${device.os}` : ""}
                </span>
              </div>
            </div>

            {/* Docker chip */}
            <div
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
                docker.tone,
              )}
              title={t(($) => $.docker.label)}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", docker.dot)} />
              <Box className="h-3 w-3" />
              <span>{dockerLabel(t, device.docker)}</span>
              {device.docker === "running" && (
                <span className="font-mono tabular-nums">{device.containers}</span>
              )}
            </div>
          </div>

          {/* Agent runtime / live load — independent of SSH reachability. First-class:
              this is a compute pool running AI agents, so the execution state leads. */}
          {(device.providers.length > 0 || device.runtime_online) && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-brand/20 bg-brand/[0.06] px-2.5 py-1.5 text-[11px]">
              <span className="flex min-w-0 items-center gap-1.5">
                <StatusDot online={device.runtime_online} size="sm" />
                <span className="text-muted-foreground">{t(($) => $.runtime.label)}</span>
                <span className="flex min-w-0 flex-wrap gap-1">
                  {device.providers.map((p) => (
                    <span
                      key={p}
                      className="rounded border border-brand/30 bg-brand/10 px-1 font-mono text-[10px] font-medium text-brand"
                    >
                      {p}
                    </span>
                  ))}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2 font-mono tabular-nums">
                <span
                  className={cn(
                    "flex items-center gap-1",
                    device.running_tasks > 0 ? "text-success" : "text-muted-foreground",
                  )}
                  title={t(($) => $.runtime.running)}
                >
                  <Activity className="h-3 w-3" />
                  {device.running_tasks}
                </span>
                <span
                  className="flex items-center gap-1 text-muted-foreground"
                  title={t(($) => $.runtime.queued)}
                >
                  <Clock className="h-3 w-3" />
                  {device.queued_tasks}
                </span>
              </span>
            </div>
          )}

          {online ? (
            <>
              {/* Headline GPU meter + CPU/Mem/Disk triad. GPU leads because this is
                  a compute pool; its watts ride as a secondary readout. */}
              <div className="flex items-center gap-4 py-1">
                <RadialGauge
                  value={device.gpu_percent}
                  toneClass={metricTone(METRIC.gpu, device.gpu_percent)}
                  label={t(($) => $.hw.gpu)}
                  Icon={Gauge}
                  size={84}
                  stroke={7}
                  unit="%"
                  hero
                />
                <div className="grid flex-1 grid-cols-3 gap-1">
                  <RadialGauge
                    value={device.cpu_percent}
                    toneClass={metricTone(METRIC.cpu, device.cpu_percent)}
                    label={t(($) => $.metric.cpu)}
                    Icon={Cpu}
                  />
                  <RadialGauge
                    value={device.mem_used_percent}
                    toneClass={metricTone(METRIC.mem, device.mem_used_percent)}
                    label={t(($) => $.metric.memory)}
                    Icon={MemoryStick}
                  />
                  <RadialGauge
                    value={device.disk_used_percent}
                    toneClass={metricTone(METRIC.disk, device.disk_used_percent)}
                    label={t(($) => $.metric.disk)}
                    Icon={HardDrive}
                  />
                </div>
              </div>

              {/* Live rolling trends — CPU + GPU sparklines built from the
                  client-side history (resets on reload). Each carries its metric
                  identity hue and animates the area's "streaming" sweep. */}
              <div className="grid grid-cols-2 gap-2 rounded-lg border bg-background/40 px-2.5 py-2">
                <NodeSpark
                  label={t(($) => $.metric.cpu)}
                  Icon={Cpu}
                  metricClass={METRIC.cpu}
                  data={history?.cpu ?? []}
                  online={online}
                  t={t}
                />
                <NodeSpark
                  label={t(($) => $.hw.gpu)}
                  Icon={Gauge}
                  metricClass={METRIC.gpu}
                  data={history?.gpu ?? []}
                  online={online}
                  t={t}
                />
              </div>

              {/* Thermal + Network — varied widget shapes (segmented meter + glyph
                  readout) so the card doesn't read as repeated bars. */}
              <div className="grid grid-cols-2 gap-2">
                <MicroStat label={t(($) => $.hw.thermal)} Icon={Thermometer}>
                  {thermal.available ? (
                    <ThermalMeter thermal={thermal} />
                  ) : (
                    <span className="text-[11px] text-muted-foreground">
                      {t(($) => $.thermal_level.unknown)}
                    </span>
                  )}
                </MicroStat>
                <MicroStat label={t(($) => $.hw.network)} Icon={Network}>
                  <NetReadout rx={device.net_rx_bytes_sec} tx={device.net_tx_bytes_sec} t={t} />
                </MicroStat>
              </div>

              {/* Footer stats — monospace ops readout. */}
              <div className="flex items-center justify-between border-t pt-2.5 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1" title={t(($) => $.metric.load)}>
                  <Activity className="h-3 w-3" />
                  <span className="font-mono tabular-nums">{device.load1.toFixed(2)}</span>
                </span>
                <span className="flex items-center gap-1" title={t(($) => $.metric.cores)}>
                  <Cpu className="h-3 w-3" />
                  <span className="font-mono tabular-nums">{device.ncpu}</span>
                </span>
                <span className="flex items-center gap-1" title={t(($) => $.metric.uptime)}>
                  <Clock className="h-3 w-3" />
                  <span className="font-mono tabular-nums">{formatUptime(device.uptime_seconds)}</span>
                </span>
                <span
                  className="flex items-center gap-1 fleet-metric-net"
                  title={t(($) => $.hw.power)}
                >
                  <Zap className="h-3 w-3" />
                  <span className="font-mono tabular-nums">{device.system_power_w.toFixed(1)} W</span>
                </span>
              </div>
            </>
          ) : (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-muted-foreground">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              <div className="min-w-0">
                <div className="font-medium text-destructive">{t(($) => $.status.offline)}</div>
                {device.error && (
                  <div className="mt-0.5 break-words font-mono text-[10px]">{device.error}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </m.div>
  );
}

function SummaryStat({
  label,
  value,
  accent,
  sub,
  Icon,
}: {
  label: string;
  value: string;
  accent?: string;
  sub?: string;
  Icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="relative flex flex-col gap-1.5 px-4 py-3.5">
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className={cn("fleet-display text-3xl font-semibold leading-none tabular-nums", accent)}>
          {value}
        </span>
        {sub && (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{sub}</span>
        )}
      </span>
    </div>
  );
}

/** An aggregate cluster-vitals mini-meter: label + big % + identity-coloured
 *  bar + a live trend sparkline of the pool aggregate for that metric. */
function VitalMeter({
  label,
  pct,
  Icon,
  metricClass,
  data,
}: {
  label: string;
  pct: number;
  Icon: React.ComponentType<{ className?: string }>;
  metricClass: string;
  data: number[];
}) {
  const tone = metricTone(metricClass, pct);
  const hasHistory = data.length > 1;
  return (
    <div className={cn("flex flex-col gap-1.5", metricClass)}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <Icon className="h-3 w-3" />
          {label}
        </span>
        <span className={cn("fleet-display text-base font-semibold tabular-nums", tone)}>
          {Math.round(pct)}
          <span className="text-[10px]">%</span>
        </span>
      </div>
      <MeterBar pct={pct} toneClass={tone} />
      <div className="h-9 w-full">
        {hasHistory && <Sparkline data={data} height={36} range="percent" live />}
      </div>
    </div>
  );
}

export function FleetPage() {
  const { t } = useT("fleet");
  const { data, isLoading } = useQuery(fleetStatusOptions());
  const prefersReduced = useReducedMotion();

  // Client-side rolling history (ephemeral, view-local; resets on reload).
  const history = useFleetHistory(data);

  const devices = data?.devices ?? [];

  const summary = useMemo(() => {
    const online = devices.filter((d) => d.online);
    const avg = (sel: (d: FleetDevice) => number) =>
      online.length ? online.reduce((s, d) => s + sel(d), 0) / online.length : 0;
    return {
      total: devices.length,
      online: online.length,
      runtimesOnline: devices.filter((d) => d.runtime_online).length,
      avgCpu: avg((d) => d.cpu_percent),
      avgMem: avg((d) => d.mem_used_percent),
      avgGpu: avg((d) => d.gpu_percent),
      systemPower: online.reduce((s, d) => s + (d.system_power_w || 0), 0),
      running: devices.reduce((s, d) => s + (d.running_tasks || 0), 0),
      queued: devices.reduce((s, d) => s + (d.queued_tasks || 0), 0),
    };
  }, [devices]);

  const allOnline = summary.total > 0 && summary.online === summary.total;

  // Reduced motion → keep the same staged structure but resolve instantly, so
  // the composition is identical and nothing animates per poll tick.
  const initial = prefersReduced ? false : "hidden";

  return (
    <LazyMotion features={domAnimation} strict>
      {/* `.fleet-console` redefines the semantic tokens to the cinematic dark
          palette (see tokens.css), so this whole subtree is a fixed dark surface
          regardless of the global light/dark theme. */}
      <div className="fleet-console fleet-console-bg relative flex h-full flex-col overflow-hidden bg-background text-foreground">
        {/* Atmosphere stack: scan grid + film grain, masked + non-interactive. */}
        <div className="fleet-console-scan pointer-events-none absolute inset-0" aria-hidden />
        <div className="fleet-console-grain pointer-events-none absolute inset-0 opacity-60" aria-hidden />

        <div className="relative flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl space-y-5 p-6">
            <m.div
              variants={stageVariants}
              initial={initial}
              animate="show"
              className="space-y-5"
            >
              {/* COMMAND BAR — the cluster-overview console header. Layered
                  glows, a radar light-sweep, the mission-control wordmark in the
                  display face, and the aggregate ops readout. */}
              <m.div variants={riseVariants}>
                <div className="fleet-panel-glow relative overflow-hidden rounded-2xl border border-brand/20 bg-card/70 backdrop-blur-md">
                  <div className="pointer-events-none absolute inset-x-0 top-0 h-px fleet-command-sweep" />
                  <div
                    className="pointer-events-none absolute inset-0 bg-gradient-to-br from-brand/[0.1] via-transparent to-transparent"
                    aria-hidden
                  />

                  <div className="relative flex flex-wrap items-center justify-between gap-4 p-5">
                    <div className="min-w-0 space-y-2">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-brand/30 bg-brand/10 text-brand">
                          <Server className="h-4 w-4" />
                        </span>
                        <div className="flex flex-col">
                          <span className="flex items-center gap-2">
                            <h1 className="fleet-display text-xl font-bold uppercase tracking-[0.18em] text-foreground">
                              {t(($) => $.title)}
                            </h1>
                            <span className="rounded border border-brand/30 bg-brand/10 px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-[0.2em] text-brand">
                              {t(($) => $.console_tag)}
                            </span>
                          </span>
                        </div>
                      </div>
                      <p className="max-w-2xl text-sm text-muted-foreground">{t(($) => $.subtitle)}</p>
                    </div>

                    <div className="flex items-center gap-3">
                      <span
                        className={cn(
                          "fleet-display flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold uppercase tracking-wider tabular-nums",
                          allOnline
                            ? "border-success/40 bg-success/10 text-success"
                            : "border-warning/40 bg-warning/10 text-warning",
                        )}
                      >
                        <StatusDot online={allOnline} size="sm" />
                        {summary.online}/{summary.total}
                      </span>
                      <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
                        </span>
                        {t(($) => $.live)}
                      </span>
                    </div>
                  </div>

                  {/* Aggregate stat strip */}
                  <div className="relative grid grid-cols-2 border-t border-border/70 divide-x divide-y divide-border/70 sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6">
                    <SummaryStat
                      label={t(($) => $.summary.devices)}
                      value={String(summary.total)}
                      Icon={Server}
                    />
                    <SummaryStat
                      label={t(($) => $.summary.online)}
                      value={`${summary.online}`}
                      sub={`/ ${summary.total}`}
                      accent={allOnline ? "text-success" : "text-warning"}
                      Icon={Radio}
                    />
                    <SummaryStat
                      label={t(($) => $.summary.avg_cpu)}
                      value={`${Math.round(summary.avgCpu)}%`}
                      accent={metricTone(METRIC.cpu, summary.avgCpu)}
                      Icon={Cpu}
                    />
                    <SummaryStat
                      label={t(($) => $.summary.avg_gpu)}
                      value={`${Math.round(summary.avgGpu)}%`}
                      accent={metricTone(METRIC.gpu, summary.avgGpu)}
                      Icon={Gauge}
                    />
                    <SummaryStat
                      label={t(($) => $.summary.avg_mem)}
                      value={`${Math.round(summary.avgMem)}%`}
                      accent={metricTone(METRIC.mem, summary.avgMem)}
                      Icon={MemoryStick}
                    />
                    <SummaryStat
                      label={t(($) => $.summary.tasks)}
                      value={String(summary.running)}
                      sub={summary.queued > 0 ? `+${summary.queued}` : undefined}
                      accent={summary.running > 0 ? "text-success" : undefined}
                      Icon={Activity}
                    />
                  </div>
                </div>
              </m.div>

              {/* Cluster vitals band — aggregate CPU/Mem/GPU mini-meters + a node
                  activity heat-strip so the whole pool reads at a glance. */}
              {summary.online > 0 && (
                <m.div variants={riseVariants}>
                  <div className="fleet-panel grid gap-4 rounded-2xl border bg-card/70 p-4 backdrop-blur-sm lg:grid-cols-[1.4fr_1fr]">
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                        <Gauge className="h-3.5 w-3.5 text-brand" />
                        <span className="fleet-display">{t(($) => $.vitals.title)}</span>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <VitalMeter
                          label={t(($) => $.metric.cpu)}
                          pct={summary.avgCpu}
                          Icon={Cpu}
                          metricClass={METRIC.cpu}
                          data={history.pool.cpu}
                        />
                        <VitalMeter
                          label={t(($) => $.metric.memory)}
                          pct={summary.avgMem}
                          Icon={MemoryStick}
                          metricClass={METRIC.mem}
                          data={history.pool.mem}
                        />
                        <VitalMeter
                          label={t(($) => $.hw.gpu)}
                          pct={summary.avgGpu}
                          Icon={Gauge}
                          metricClass={METRIC.gpu}
                          data={history.pool.gpu}
                        />
                      </div>
                      <div className="flex items-center gap-4 border-t pt-3 text-[11px]">
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <ListChecks className="h-3.5 w-3.5 text-success" />
                          <span className="fleet-display text-base font-semibold tabular-nums text-foreground">
                            {summary.running}
                          </span>
                          {t(($) => $.runtime.running)}
                        </span>
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <Clock className="h-3.5 w-3.5" />
                          <span className="fleet-display text-base font-semibold tabular-nums text-foreground">
                            {summary.queued}
                          </span>
                          {t(($) => $.runtime.queued)}
                        </span>
                        <span
                          className="ml-auto flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-muted-foreground"
                          title={t(($) => $.hw.power)}
                        >
                          <Zap className="h-3.5 w-3.5 text-brand" />
                          {summary.systemPower.toFixed(0)} W
                        </span>
                      </div>
                    </div>

                    {/* Node activity heat-strip */}
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                        <Activity className="h-3.5 w-3.5 text-brand" />
                        <span className="fleet-display">{t(($) => $.vitals.activity)}</span>
                      </div>
                      <div className="flex h-20 items-end gap-1.5">
                        {devices.map((d) => {
                          // Heat = the hottest of its core metrics; offline = flat muted.
                          const heat = d.online
                            ? Math.max(d.cpu_percent, d.gpu_percent, d.mem_used_percent)
                            : 0;
                          const h = d.online ? Math.max(8, Math.min(100, heat)) : 6;
                          // Calm baseline = CPU identity hue; escalates to health tones
                          // (warning/destructive) only when the node is under pressure.
                          const tone = d.online
                            ? (healthTone(heat) ?? METRIC.cpu)
                            : "text-muted-foreground";
                          return (
                            <div
                              key={d.id}
                              className="group/cell flex h-full flex-1 flex-col items-center justify-end gap-1"
                              title={`${d.name} · ${Math.round(heat)}%`}
                            >
                              <span
                                className={cn(
                                  "fleet-cell-in w-full rounded-sm bg-current transition-[height] duration-700 ease-out",
                                  tone,
                                  !d.online && "opacity-40",
                                )}
                                style={{ height: `${h}%` }}
                              />
                              <StatusDot online={d.online} size="sm" />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </m.div>
              )}

              {/* Device grid */}
              {isLoading && devices.length === 0 ? (
                <m.div variants={riseVariants} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-64 rounded-xl" />
                  ))}
                </m.div>
              ) : devices.length === 0 ? (
                <m.div
                  variants={riseVariants}
                  className="rounded-2xl border border-dashed p-12 text-center text-sm text-muted-foreground"
                >
                  {t(($) => $.empty)}
                </m.div>
              ) : (
                <m.div variants={riseVariants} className="space-y-3">
                  <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                    <Server className="h-3.5 w-3.5 text-brand" />
                    <span className="fleet-display">{t(($) => $.nodes_title)}</span>
                    <span className="font-mono tabular-nums text-muted-foreground/70">
                      {summary.total}
                    </span>
                  </div>
                  <m.div
                    variants={gridVariants}
                    initial={initial}
                    animate="show"
                    className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
                  >
                    {devices.map((device) => (
                      <DeviceCard
                        key={device.id}
                        device={device}
                        history={history.devices[device.id]}
                        t={t}
                      />
                    ))}
                  </m.div>
                </m.div>
              )}
            </m.div>
          </div>
        </div>
      </div>
    </LazyMotion>
  );
}
