"use client";

// Floating legend over the graph canvas: explains the edge styles shown right
// now and the color buckets of the active color dimension. Purely presentational.

import { useT } from "../../i18n";
import type { Project } from "@multica/core/types";
import { projectColorIndex } from "@multica/core/graph/build-graph-model";
import type { ColorDimension, EdgeGroupToggles } from "./graph-toolbar";

// Edge sample lines mirror the canvas: one hue per relation group (tokens from
// tokens.css), plus the dash pattern the canvas draws for that group.
const EDGE_STYLES: Array<{
  kind: keyof EdgeGroupToggles;
  className: string;
  color: string;
}> = [
  { kind: "child", className: "", color: "var(--graph-edge-child)" },
  { kind: "dependency", className: "", color: "var(--graph-edge-dependency)" },
  { kind: "mention", className: "border-t border-dashed", color: "var(--graph-edge-mention)" },
];

const CHART_COLOR_VARS = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
];

export function GraphLegend(props: {
  colorBy: ColorDimension;
  projects: Project[];
  edgeGroups: EdgeGroupToggles;
}) {
  const { t } = useT("graph");

  const visibleEdges = EDGE_STYLES.filter((e) => props.edgeGroups[e.kind]);

  const colorRows: Array<{ key: string; label: string; dot: string }> =
    props.colorBy === "project"
      ? props.projects.slice(0, 5).map((p) => ({
          key: p.id,
          label: p.icon ? `${p.icon} ${p.title}` : p.title,
          dot:
            CHART_COLOR_VARS[projectColorIndex(p.id, props.projects.map((x) => x.id)) % 5] ??
            "bg-muted-foreground",
        }))
      : [
          { key: "in_progress", label: "In Progress", dot: "bg-warning" },
          { key: "in_review", label: "In Review", dot: "bg-success" },
          { key: "done", label: "Done", dot: "bg-info" },
          { key: "blocked", label: "Blocked", dot: "bg-destructive" },
          { key: "other", label: t(($) => $.legend.status_misc), dot: "bg-muted-foreground" },
        ];

  return (
    <div
      className="pointer-events-none absolute left-3 top-3 z-10 rounded-lg border bg-background/90 p-2.5 text-caption text-muted-foreground backdrop-blur"
      data-testid="graph-legend"
    >
      {visibleEdges.length > 0 ? (
        <ul className="mb-2 space-y-1.5">
          {visibleEdges.map((edge) => (
            <li key={edge.kind} className="flex items-center gap-2">
              <span
                className={`inline-block h-0 w-6 border-t-2 ${edge.className}`}
                style={{ borderTopColor: edge.color }}
                aria-hidden
              />
              {t(($) =>
                edge.kind === "child"
                  ? $.filter.edge_group_child
                  : edge.kind === "dependency"
                    ? $.filter.edge_group_dependency
                    : $.filter.edge_group_mention,
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {props.colorBy === "project" && props.projects.length > 5 ? (
        <div className="text-micro">{t(($) => $.legend.more_projects, { count: props.projects.length - 5 })}</div>
      ) : null}
      <ul className="flex flex-wrap gap-x-3 gap-y-1 max-w-56">
        {colorRows.map((row) => (
          <li key={row.key} className="flex items-center gap-1.5">
            <span className={`inline-block size-2.5 rounded-full ${row.dot}`} aria-hidden />
            <span className="max-w-32 truncate">{row.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
