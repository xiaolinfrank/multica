// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CockpitDirectoryOperationHeader, CockpitDirectoryStepPage } from "../types/cockpit-meeting-directory";
import { cockpitDirectoryRepairSelection } from "./meeting-directory";

function fixture(base: string, names: string[]) {
  const header: Pick<CockpitDirectoryOperationHeader, "workspace_id" | "meeting_id" | "id" | "target"> = { workspace_id: "ws", meeting_id: "meeting", id: "plan",
    target: { root_id: "root", root_path: "/approved", prepare_subpath: ".", relative_directory: base, directory: `/approved/${base}`, target_hash: "a".repeat(64), root_config_hash: "b".repeat(64) } };
  const paths = [base, ...names.map((name) => base === "." ? name : `${base}/${name}`)];
  const page: CockpitDirectoryStepPage = { workspace_id: "ws", meeting_id: "meeting", operation_id: "plan", total: paths.length,
    counts: { total: paths.length, pending: 0, running: 0, retry_wait: 0, satisfied: paths.length, needs_attention: 0, abandoned: 0 },
    items: paths.map((relative_path, position) => ({ id: `step-${position}`, operation_id: "plan", position, kind: position === 0 ? "base" : "partition", label: "This label is not a path", relative_path,
      state: "satisfied", revision: 1, grant_command_key: "key", grant_revision: 1, attempt_count: 1, last_attempt_id: null, last_observed_at: null, outcome: "created", last_error_code: "", can_retry: false, blocked_reasons: [] })) };
  return { header, page };
}
describe("directory repair scope", () => {
  it("preserves the original single or custom partition and handles a root target without adding default folders", () => {
    for (const [base, names] of [["meeting/review", ["照片"]], ["meeting/review", ["custom-recordings", "原始资料"]], [".", ["raw-input"]], ["meeting/review", []]] as const) {
      const { header, page } = fixture(base, [...names]);
      expect(cockpitDirectoryRepairSelection(header, page)).toEqual({ rootId: "root", relativeDirectory: base, partitions: [...names] });
    }
  });
  it("refuses incomplete, cross-plan, nested, escaped or unknown step collections instead of guessing a repair scope", () => {
    const { header, page } = fixture("meeting/review", ["custom"]);
    for (const bad of [undefined, { ...page, total: 3 }, { ...page, operation_id: "other" }, { ...page, items: page.items.slice(1), total: 1, counts: { ...page.counts, total: 1 } },
      ...["meeting/review/custom/nested", "meeting/other/custom", "meeting/review/../outside", "meeting/review/custom\\nested"].map((relative_path) => ({ ...page, items: [page.items[0]!, { ...page.items[1]!, relative_path }] })),
      { ...page, items: [page.items[0]!, { ...page.items[1]!, kind: "future_kind" }] }]) expect(cockpitDirectoryRepairSelection(header, bad)).toBeNull();
  });
});
