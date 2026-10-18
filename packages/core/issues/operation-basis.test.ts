// @vitest-environment node
import { describe, expect, it } from "vitest";
import { operationBasisFixture } from "./operation-basis-test-fixtures";
import { issueOperationAllowed, issueStatusOperationAllowed, issueUpdateOperationAllowed, issueOperationBasisOptions, issueOperationPages } from "./operation-basis";
import { OperationBasisReadQueue } from "./operation-basis-queue";

describe("operation decisions", () => {
  it("checks only submitted fields without mistaking a repairable parent relation for a permanent scope lock", () => {
    const basis = operationBasisFixture("i", { scope: { state: "allowed", reason_codes: ["parent_scope_requires_detach"] },
      assignee: { state: "blocked", reason_codes: ["formal_reviewer_binding"] } });
    expect(issueUpdateOperationAllowed(basis, { module_id: "new", parent_issue_id: null })).toBe(true);
    expect(issueUpdateOperationAllowed(basis, { priority: "high" })).toBe(true);
    expect(issueUpdateOperationAllowed(basis, { assignee_id: null })).toBe(false);
    expect(issueUpdateOperationAllowed({ ...basis, scope: { state: "blocked", reason_codes: ["retained_artifact_scope"] } }, { module_id: "new", parent_issue_id: null })).toBe(false);
  });
  it("keeps status categories and unknown basis distinct from an ordinary permitted edit", () => {
    const basis = operationBasisFixture("i", { status: { state: "allowed", reason_codes: ["formal_review_status"], allowed_categories: ["unstarted", "started"] } });
    expect(issueStatusOperationAllowed(basis, "started")).toBe(true);
    expect(issueStatusOperationAllowed(basis, "done")).toBe(false);
    expect(issueStatusOperationAllowed(basis, "future")).toBe(false);
    expect(issueUpdateOperationAllowed(basis, { status: "working" }, () => "started")).toBe(true);
    expect(issueUpdateOperationAllowed(basis, { status: "working" })).toBe(false);
    expect(issueUpdateOperationAllowed(basis, { duplicate_of_issue_id: "target" })).toBe(false);
    expect(issueUpdateOperationAllowed(operationBasisFixture(), { duplicate_of_issue_id: "target" })).toBe(true);
    expect(issueUpdateOperationAllowed(operationBasisFixture(), { duplicate_of_issue_id: "target", status: "done" }, () => "done")).toBe(false);
    expect(issueOperationAllowed(undefined, "delete")).toBe(false);
    expect(issueUpdateOperationAllowed(undefined, { priority: "high" })).toBe(true);
    expect(issueUpdateOperationAllowed(undefined, { status: "working" }, () => "started")).toBe(false);
    expect(issueUpdateOperationAllowed({ ...basis, availability: "unavailable" }, { title: "Changed" })).toBe(false);
    expect(issueOperationAllowed({ ...basis, availability: "unknown" }, "delete")).toBe(false);
  });
  it("shares identical ID sets but never crosses workspaces", () => {
    const left = issueOperationBasisOptions("ws", ["b", "a", "b"]);
    expect(left.queryKey).toEqual(issueOperationBasisOptions("ws", ["a", "b"]).queryKey);
    expect(left.queryKey).not.toEqual(issueOperationBasisOptions("another", ["a", "b"]).queryKey);
    expect(issueOperationBasisOptions("ws", []).enabled).toBe(false);
  });
});

describe("bounded operation reads", () => {
  it("keeps completed page queries stable when newly loaded IDs sort before earlier rows", () => {
    const original = Array.from({ length: 250 }, (_, index) => `z-${index}`);
    const appended = Array.from({ length: 150 }, (_, index) => `a-${index}`);
    const before = issueOperationPages(original);
    const after = issueOperationPages([...original, ...appended, original[0]!]);
    expect(after).toHaveLength(4);
    expect(after.flat()).toEqual([...original, ...appended]);
    for (const page of [0, 1]) {
      expect(issueOperationBasisOptions("ws", after[page]!).queryKey).toEqual(issueOperationBasisOptions("ws", before[page]!).queryKey);
    }
    expect(after.every((page) => page.length <= 100)).toBe(true);
    expect(issueOperationPages([])).toEqual([]);
    expect(() => issueOperationPages(["valid", ""])).toThrow(RangeError);
  });
  it("limits concurrent pages and removes cancelled queued work without losing the rest", async () => {
    const queue = new OperationBasisReadQueue(2), signals = Array.from({ length: 8 }, () => new AbortController());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered: number[] = [];
    let active = 0, maximum = 0;
    const jobs = signals.map((controller, index) => queue.run(controller.signal, async () => {
      entered.push(index); active++; maximum = Math.max(active, maximum);
      await gate; active--; return index;
    }).then((value) => ({ value }), (error: Error) => ({ error: error.name })));
    signals[3]!.abort();
    await Promise.resolve();
    expect(entered).toEqual([0, 1]);
    release();
    const results = await Promise.all(jobs);
    expect(maximum).toBe(2);
    expect(entered).toEqual([0, 1, 2, 4, 5, 6, 7]);
    expect(results[3]).toEqual({ error: "AbortError" });
    expect(results[7]).toEqual({ value: 7 });
  });
  it("releases a slot after failure", async () => {
    const queue = new OperationBasisReadQueue(1), signal = new AbortController().signal;
    const bad = queue.run(signal, async () => { throw new Error("read failed"); });
    const next = queue.run(signal, async () => "next page");
    await expect(bad).rejects.toThrow("read failed");
    await expect(next).resolves.toBe("next page");
  });
});
