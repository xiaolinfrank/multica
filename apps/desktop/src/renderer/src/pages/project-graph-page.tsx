import { useParams } from "react-router-dom";
import { GraphPage } from "@multica/views/graph";

export function ProjectGraphRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;
  return <GraphPage projectId={id} />;
}
