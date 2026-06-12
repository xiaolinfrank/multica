"use client";

import { useMemo } from "react";
import {
  Activity,
  Box,
  Clock,
  Cpu,
  HardDrive,
  MemoryStick,
  Server,
  TriangleAlert,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { fleetStatusOptions } from "@multica/core/fleet";
import type { FleetDevice, FleetDockerState } from "@multica/core/types";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { cn } from "@multica/ui/lib/utils";
import { PageHeader } from "../../layout/page-header";
import { useT } from "../../i18n";

type FleetT = ReturnType<typeof useT<"fleet">>["t"];

// Usage → semantic colour. Kept to three existing tokens so the palette stays
// consistent with the rest of the product (success / warning / destructive).
function usageTone(pct: number): { bar: string; text: string } {
  if (pct >= 85) return { bar: "bg-destructive", text: "text-destructive" };
  if (pct >= 60) return { bar: "bg-warning", text: "text-warning" };
  return { bar: "bg-success", text: "text-success" };
}

function clampPct(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return v > 100 ? 100 : v;
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

function StatusDot({ online }: { online: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5">
      {online && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
      )}
      <span
        className={cn(
          "relative inline-flex h-2.5 w-2.5 rounded-full",
          online ? "bg-success" : "bg-muted-foreground/40",
        )}
      />
    </span>
  );
}

function MetricBar({
  icon: Icon,
  label,
  percent,
}: {
  icon: typeof Cpu;
  label: string;
  percent: number;
}) {
  const tone = usageTone(percent);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="flex items-center gap-1 text-muted-foreground">
          <Icon className="h-3 w-3" />
          {label}
        </span>
        <span className={cn("font-mono tabular-nums", tone.text)}>
          {Math.round(percent)}%
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all duration-500", tone.bar)}
          style={{ width: `${clampPct(percent)}%` }}
        />
      </div>
    </div>
  );
}

function DeviceCard({ device, t }: { device: FleetDevice; t: FleetT }) {
  const online = device.online;
  const docker = dockerVisual(device.docker);

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card transition-colors",
        online ? "border-border hover:border-success/40" : "border-border/60 opacity-80",
      )}
    >
      {/* Top accent rail — the "online" glow that gives the grid its pulse. */}
      <div
        className={cn(
          "h-0.5 w-full",
          online
            ? "bg-gradient-to-r from-success/70 via-success/20 to-transparent"
            : "bg-gradient-to-r from-muted-foreground/30 to-transparent",
        )}
      />

      <div className="space-y-3 p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2">
              <StatusDot online={online} />
              <span className="truncate text-sm font-semibold">{device.name}</span>
              {device.local && (
                <span className="rounded border border-brand/30 bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-brand">
                  {t(($) => $.coordinator)}
                </span>
              )}
            </div>
            <div className="truncate pl-[18px] font-mono text-[11px] text-muted-foreground">
              {device.host}
              {device.os ? ` · macOS ${device.os}` : ""}
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

        {online ? (
          <>
            {/* Metric bars */}
            <div className="space-y-2.5">
              <MetricBar icon={Cpu} label={t(($) => $.metric.cpu)} percent={device.cpu_percent} />
              <MetricBar
                icon={MemoryStick}
                label={t(($) => $.metric.memory)}
                percent={device.mem_used_percent}
              />
              <MetricBar
                icon={HardDrive}
                label={t(($) => $.metric.disk)}
                percent={device.disk_used_percent}
              />
            </div>

            {/* Footer stats */}
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
            </div>
          </>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <div className="min-w-0">
              <div className="font-medium text-destructive">{t(($) => $.status.offline)}</div>
              {device.error && <div className="mt-0.5 break-words font-mono text-[10px]">{device.error}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className={cn("text-2xl font-semibold leading-none tabular-nums", accent)}>{value}</span>
    </div>
  );
}

export function FleetPage() {
  const { t } = useT("fleet");
  const { data, isLoading } = useQuery(fleetStatusOptions());

  const devices = data?.devices ?? [];

  const summary = useMemo(() => {
    const online = devices.filter((d) => d.online);
    const avg = (sel: (d: FleetDevice) => number) =>
      online.length ? online.reduce((s, d) => s + sel(d), 0) / online.length : 0;
    return {
      total: devices.length,
      online: online.length,
      avgCpu: avg((d) => d.cpu_percent),
      avgMem: avg((d) => d.mem_used_percent),
      containers: online.reduce((s, d) => s + (d.containers || 0), 0),
    };
  }, [devices]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader className="h-auto min-h-12">
        <div className="flex min-w-0 items-center gap-2">
          <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
          <h1 className="truncate text-sm font-medium">{t(($) => $.title)}</h1>
        </div>
        <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
          </span>
          {t(($) => $.live)}
        </div>
      </PageHeader>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-5 p-6">
          <div>
            <p className="text-sm text-muted-foreground">{t(($) => $.subtitle)}</p>
          </div>

          {/* Summary strip */}
          <div className="grid grid-cols-2 divide-x divide-y rounded-xl border bg-card sm:grid-cols-4 sm:divide-y-0 lg:grid-cols-5">
            <SummaryStat label={t(($) => $.summary.devices)} value={String(summary.total)} />
            <SummaryStat
              label={t(($) => $.summary.online)}
              value={`${summary.online}/${summary.total}`}
              accent={summary.online === summary.total ? "text-success" : "text-warning"}
            />
            <SummaryStat
              label={t(($) => $.summary.avg_cpu)}
              value={`${Math.round(summary.avgCpu)}%`}
              accent={usageTone(summary.avgCpu).text}
            />
            <SummaryStat
              label={t(($) => $.summary.avg_mem)}
              value={`${Math.round(summary.avgMem)}%`}
              accent={usageTone(summary.avgMem).text}
            />
            <SummaryStat
              label={t(($) => $.summary.containers)}
              value={String(summary.containers)}
            />
          </div>

          {/* Device grid */}
          {isLoading && devices.length === 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-44 rounded-xl" />
              ))}
            </div>
          ) : devices.length === 0 ? (
            <div className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">
              {t(($) => $.empty)}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {devices.map((device) => (
                <DeviceCard key={device.id} device={device} t={t} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
