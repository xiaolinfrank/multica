import { useId, useMemo } from "react";
import { cn } from "@multica/ui/lib/utils";

/**
 * Sparkline — a lightweight, hand-rolled SVG area+line trend chart.
 *
 * Built for the fleet board's live rolling history: there can be dozens of
 * these (N nodes × multiple metrics) refreshing every 5s, so a heavy chart lib
 * (recharts via chart.tsx) is the wrong tool — this is a single memoised <path>
 * pair with no runtime deps and no per-frame JS animation.
 *
 * Colour comes entirely from `currentColor` (the host sets the metric identity
 * hue via a `.fleet-metric-*` class), so there are zero colour literals here.
 * The line uses currentColor solid; the area fades currentColor → transparent
 * via an SVG <linearGradient> using `stop-color="currentColor"`.
 *
 * Values are normalised to [min, max] of the buffer by default, or to a fixed
 * 0..100 range for percentage metrics (`range="percent"`) so the vertical scale
 * is comparable across cards. Renders gracefully with few points (a single
 * point draws a flat baseline; empty draws nothing but the baseline).
 */
export function Sparkline({
  data,
  width = 120,
  height = 32,
  range = "percent",
  strokeWidth = 1.5,
  className,
  muted = false,
  live = false,
}: {
  data: number[];
  width?: number;
  height?: number;
  /** "percent" pins the scale to 0..100; "auto" fits the buffer's own range. */
  range?: "percent" | "auto";
  strokeWidth?: number;
  className?: string;
  /** Greyed/flat presentation for offline or stale series. */
  muted?: boolean;
  /** Adds the subtle "streaming" sweep to the area fill. */
  live?: boolean;
}) {
  const gradientId = useId();

  const { linePath, areaPath, hasShape } = useMemo(() => {
    const pad = strokeWidth; // keep the stroke from clipping at the edges
    const w = width;
    const h = height;
    const usableH = h - pad * 2;

    const pts = data.filter((v) => Number.isFinite(v));
    if (pts.length === 0) {
      return { linePath: "", areaPath: "", hasShape: false };
    }

    let lo: number;
    let hi: number;
    if (range === "percent") {
      lo = 0;
      hi = 100;
    } else {
      lo = Math.min(...pts);
      hi = Math.max(...pts);
      if (hi - lo < 1e-6) {
        // Flat series: centre it so it doesn't hug an edge.
        lo -= 1;
        hi += 1;
      }
    }
    const span = hi - lo || 1;

    // With a single sample, draw a short flat segment across the width.
    const n = pts.length;
    const stepX = n > 1 ? w / (n - 1) : 0;

    const xy = pts.map((v, i) => {
      const x = n > 1 ? i * stepX : w / 2;
      const norm = Math.max(0, Math.min(1, (v - lo) / span));
      const y = pad + (1 - norm) * usableH;
      return [x, y] as const;
    });

    if (n === 1) {
      const [, y] = xy[0]!;
      const line = `M 0 ${y.toFixed(2)} L ${w} ${y.toFixed(2)}`;
      const area = `${line} L ${w} ${h} L 0 ${h} Z`;
      return { linePath: line, areaPath: area, hasShape: true };
    }

    // Smooth the line with a Catmull-Rom → cubic Bézier conversion. Cheap,
    // produces clean curves through every point without overshoot tuning.
    let line = `M ${xy[0]![0].toFixed(2)} ${xy[0]![1].toFixed(2)}`;
    for (let i = 0; i < xy.length - 1; i++) {
      const p0 = xy[i === 0 ? 0 : i - 1]!;
      const p1 = xy[i]!;
      const p2 = xy[i + 1]!;
      const p3 = xy[i + 2 < xy.length ? i + 2 : i + 1]!;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      line += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
    }
    const area = `${line} L ${w} ${h} L 0 ${h} Z`;
    return { linePath: line, areaPath: area, hasShape: true };
  }, [data, width, height, range, strokeWidth]);

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("overflow-visible", muted && "opacity-40", className)}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={muted ? 0.18 : 0.32} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      {hasShape && (
        <>
          <path
            d={areaPath}
            fill={`url(#${gradientId})`}
            className={cn(live && !muted && "fleet-spark-live")}
          />
          <path
            d={linePath}
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}
