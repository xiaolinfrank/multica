import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { normalizeWorkspaceStartPage, workspaceStartPath, WORKSPACE_START_COOKIE } from "@multica/core/paths/workspace-start";

export default async function WorkspaceStartPage({ params }: { params: Promise<{ workspaceSlug: string }> }) {
  const { workspaceSlug } = await params;
  const preference = (await cookies()).get(WORKSPACE_START_COOKIE)?.value;
  redirect(workspaceStartPath(workspaceSlug, normalizeWorkspaceStartPage(preference)));
}
