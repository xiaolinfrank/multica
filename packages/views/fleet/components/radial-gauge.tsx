import { cn } from "@multica/ui/lib/utils";

/**
 * RadialGauge — a compact SVG arc gauge for a single 0-100 metric.
 *
 * Pure presentational: the consumer passes the percentage, a semantic tone
 * class (e.g. "text-success") and a short label. The track + value arc are
 * drawn with `stroke="currentColor"` so colour comes entirely from Tailwind
 * tokens applied via `className` — no hardcoded colours. The value arc is
 * rendered as a stroke-dashoffset sweep so it animates smoothly when the
 * 5s refetch updates the number.
 *
 * Variants:
 *  - default: full ring, big centered value, label below (used in the per-node
 *    telemetry triad).
 *  - "hero": larger ring with a soft inner halo + secondary readout, used for
 *    the headline GPU meter so it visually leads the card.
 */
export function RadialGauge({
  value,
  toneClass,
  label,
  Icon,
  size = 60,
  stroke = 5,
  unit,
  sub,
  hero = false,
}: {
  value: number;
  toneClass: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  /** Diameter in px. */
  size?: number;
  /** Stroke width in px. */
  stroke?: number;
  /** Optional unit glyph rendered after the value (e.g. "%"). */
  unit?: string;
  /** Optional secondary readout under the value (e.g. "8.2 W"). */
  sub?: string;
  hero?: boolean;
}) {
  const pct = clamp(value);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);

  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative" style={{ width: size, height: size }}>
        {hero && (
          // Soft token-tinted halo behind the hero ring; depth without a hex.
          <div
            className={cn(
              "pointer-events-none absolute inset-1.5 rounded-full opacity-20 blur-md",
              toneClass,
            )}
            style={{ background: "currentColor" }}
            aria-hidden
          />
        )}
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          {/* Track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            className="text-muted"
            stroke="currentColor"
          />
          {/* Value arc */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={c}
            strokeDashoffset={offset}
            className={cn("transition-[stroke-dashoffset] duration-700 ease-out", toneClass)}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className={cn(
              "flex items-baseline font-mono font-semibold tabular-nums leading-none",
              hero ? "text-2xl" : "text-sm",
              toneClass,
            )}
          >
            {Math.round(pct)}
            {unit && (
              <span className={cn("font-medium", hero ? "ml-0.5 text-sm" : "text-[10px]")}>
                {unit}
              </span>
            )}
          </span>
          {sub && (
            <span className="mt-0.5 font-mono text-[10px] tabular-nums text-muted-foreground">
              {sub}
            </span>
          )}
        </div>
      </div>
      <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </span>
    </div>
  );
}

function clamp(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  return v > 100 ? 100 : v;
}
