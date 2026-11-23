import type { IssueCreateShared } from "@multica/core/issues/stores/draft-store";
import type { IssueScopeValue } from "./issue-scope-picker";

/** The three levels of a filing, in the order a caller names them. */
const LEVELS = ["project_id", "module_id", "work_item_id"] as const;

type FilingDraft = Pick<IssueCreateShared, "projectId" | "moduleId" | "workItemId">;

/**
 * Where a create opens: the caller's filing, or the user's unfinished draft.
 *
 * A caller that names even one level names the filing — all three come from
 * the call, and a level it left out is empty rather than filled from the
 * draft. The draft outlives the board it was written against, so a level it
 * remembers may sit under a different module; blending the two would hand the
 * create a pair the server refuses (`ErrModuleNotInProject`), and the failure
 * would land on the user for a filing neither side chose.
 *
 * `project_id: null` is a named level too — it means "no project", not "not
 * given". With no level named at all, the whole draft is the answer, which is
 * what reopening an untouched draft means.
 */
export function seedIssueScope(
  data: Record<string, unknown> | null | undefined,
  shared: FilingDraft,
): IssueScopeValue {
  const named = data != null && LEVELS.some((level) => level in data);
  if (!named) {
    return {
      project_id: shared.projectId ?? null,
      module_id: shared.moduleId ?? null,
      work_item_id: shared.workItemId ?? null,
    };
  }
  const read = (level: (typeof LEVELS)[number]) => {
    const raw = (data as Record<string, unknown>)[level];
    return typeof raw === "string" && raw.length > 0 ? raw : null;
  };
  return {
    project_id: read("project_id"),
    module_id: read("module_id"),
    work_item_id: read("work_item_id"),
  };
}
