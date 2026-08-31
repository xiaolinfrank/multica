"use client";

import { use } from "react";
import { GraphPage } from "@multica/views/graph";

// Project-scoped graph: same shared page, pinned to one project's snapshot.
export default function ProjectGraphRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return <GraphPage projectId={id} />;
}
