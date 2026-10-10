export const WORKSPACE_START_PAGES = ["cockpit", "issues", "my-issues", "inbox"] as const;
export type WorkspaceStartPage = (typeof WORKSPACE_START_PAGES)[number];
export const WORKSPACE_START_COOKIE = "multica_workspace_start";
export function normalizeWorkspaceStartPage(value: unknown): WorkspaceStartPage {
  return value === "issues" || value === "my-issues" || value === "inbox" ? value : "cockpit";
}
export function workspaceStartPath(slug: string, page: WorkspaceStartPage = "cockpit"): string {
  return `/${encodeURIComponent(slug)}/${normalizeWorkspaceStartPage(page)}`;
}
