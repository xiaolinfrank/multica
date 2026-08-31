import { GraphPage } from "@multica/views/graph";

// The workspace-level issue graph; shared view, no platform wiring needed.
export default function GraphRoute() {
  return <GraphPage />;
}
