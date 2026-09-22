// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { CockpitBoard } from "../types";
import { cockpitKeys } from "./queries";
import { onCockpitChanged } from "./ws-updaters";

const WS = "ws-1";

function seedBoard(over?: Partial<CockpitBoard>): { qc: QueryClient; board: CockpitBoard } {
  const board: CockpitBoard = {
    cockpit: {
      id: "cp",
      workspace_id: WS,
      title: "Board",
      goal_title: "",
      goal_date: null,
      summary_overall: "",
      summary_next: "",
      summary_support: "",
      basis: "",
      meeting_assignee_type: "",
      meeting_assignee_id: null,
      meeting_project_id: null,
      meeting_module_id: null,
    meeting_node_id: null,
      meeting_dir: "",
      created_at: "",
      updated_at: "",
    },
    nodes: [
      {
        id: "n1",
        cockpit_id: "cp",
        parent_id: null,
        code: "L1-01",
        name: "Datasets",
        position: 0,
        color: "",
        owner: "",
        collaborators: "",
        start_date: null,
        end_date: null,
        status: "",
        progress: 0,
        deliverable: "",
        dependencies: "",
        note: "",
        current_progress: "",
        vendor: "",
        budget_category: "",
        budget_amount: null,
        exec_status: "",
        contract: "",
        source: "",
        updated_by_type: "",
        updated_by_id: null,
        created_at: "",
        updated_at: "",
      },
    ],
    payments: [{ id: "p1", node_id: "n1", label: "#1", pay_date: null, amount: 5, position: 0 }],
    issue_links: [
      {
        id: "l1",
        node_id: "n1",
        issue_id: "i1",
        issue_number: 1,
        issue_identifier: "BIO-1",
        issue_title: "One",
        issue_status: "todo",
        position: 0,
      },
    ],
    milestones: [],
    meetings: [],
    meeting_issues: [],
    meeting_nodes: [],
    ...over,
  };
  const qc = new QueryClient();
  qc.setQueryData(cockpitKeys.board(WS), board);
  return { qc, board };
}

function read(qc: QueryClient): CockpitBoard {
  return qc.getQueryData<CockpitBoard>(cockpitKeys.board(WS))!;
}

describe("onCockpitChanged", () => {
  it("patches a changed node in place instead of refetching the board", () => {
    const { qc } = seedBoard();
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    onCockpitChanged(qc, WS, {
      scope: "node",
      action: "updated",
      entity: { ...read(qc).nodes[0], name: "Renamed", progress: 60 },
    });

    expect(read(qc).nodes[0]!.name).toBe("Renamed");
    expect(read(qc).nodes[0]!.progress).toBe(60);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("appends a node created by someone else", () => {
    const { qc } = seedBoard();
    onCockpitChanged(qc, WS, {
      scope: "node",
      action: "created",
      entity: { ...read(qc).nodes[0], id: "n2", code: "L1-02" },
    });
    expect(read(qc).nodes.map((n) => n.id)).toEqual(["n1", "n2"]);
  });

  // The server drops a node's instalments and links with it; a client that
  // kept them would go on counting a task that no longer exists.
  it("takes a deleted node's payments and issue links with it", () => {
    const { qc } = seedBoard();
    onCockpitChanged(qc, WS, { scope: "node", action: "deleted", entity: { id: "n1" } });

    const board = read(qc);
    expect(board.nodes).toHaveLength(0);
    expect(board.payments).toHaveLength(0);
    expect(board.issue_links).toHaveLength(0);
  });

  it("replaces a node's whole link set when links are re-set", () => {
    const { qc } = seedBoard();
    onCockpitChanged(qc, WS, {
      scope: "issue_links",
      action: "replaced",
      entity: {
        node_id: "n1",
        links: [
          {
            id: "l2",
            node_id: "n1",
            issue_id: "i2",
            issue_number: 2,
            issue_identifier: "BIO-2",
            issue_title: "Two",
            issue_status: "todo",
            position: 0,
          },
        ],
      },
    });
    expect(read(qc).issue_links.map((l) => l.issue_id)).toEqual(["i2"]);
  });

  it("removes exactly the unlinked issue", () => {
    const { qc } = seedBoard();
    onCockpitChanged(qc, WS, {
      scope: "issue_links",
      action: "removed",
      entity: { node_id: "n1", issue_id: "i1" },
    });
    expect(read(qc).issue_links).toHaveLength(0);
  });

  it("re-reads after an import, which no payload could reconstruct", () => {
    const { qc } = seedBoard();
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    onCockpitChanged(qc, WS, { scope: "board", action: "imported", entity: { nodes: 217 } });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.board(WS) });
    // The import froze the outgoing board: history moved too.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.snapshots(WS) });
  });

  it("re-reads after a restore, which is an import of a frozen board", () => {
    const { qc } = seedBoard();
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    onCockpitChanged(qc, WS, { scope: "board", action: "restored", entity: { nodes: 217 } });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.board(WS) });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.snapshots(WS) });
  });

  it("refreshes only the version list when a snapshot was saved or deleted", () => {
    const { qc } = seedBoard();
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    onCockpitChanged(qc, WS, { scope: "snapshots", action: "created", entity: null });

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.snapshots(WS) });
  });

  it("refreshes only the review queue when a change is filed or decided", () => {
    const { qc } = seedBoard();
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    onCockpitChanged(qc, WS, { scope: "changes", action: "queued", entity: null });

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.changes(WS) });
  });

  it("re-reads on a scope this build does not know rather than guessing", () => {
    const { qc } = seedBoard();
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    onCockpitChanged(qc, WS, {
      scope: "something_new" as never,
      action: "updated",
      entity: { id: "x" },
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.board(WS) });
  });

  // A frame crossing a version boundary must never throw inside the socket
  // handler — that would take every later event down with it.
  it("ignores a frame whose entity carries no usable id", () => {
    const { qc } = seedBoard();
    expect(() =>
      onCockpitChanged(qc, WS, { scope: "node", action: "updated", entity: null }),
    ).not.toThrow();
    expect(() =>
      onCockpitChanged(qc, WS, { scope: "payment", action: "updated", entity: { id: 42 } }),
    ).not.toThrow();
    expect(() =>
      onCockpitChanged(qc, WS, { scope: "issue_links", action: "replaced", entity: { node_id: "n1" } }),
    ).not.toThrow();
    expect(read(qc).nodes).toHaveLength(1);
  });

  // A frame crosses a version boundary. A server that predates a column simply
  // leaves it out of the row, and the board promises every one of them is a
  // string — the register calls .trim() and .split() on them during render, so
  // a hole reaches the cache as a crash on the next keystroke, not as a
  // missing value. This is the pre-929 meeting row, verbatim.
  it("fills in the columns an older server's meeting frame does not carry", () => {
    const { qc } = seedBoard();

    onCockpitChanged(qc, WS, {
      scope: "meeting",
      action: "created",
      entity: {
        id: "m1", meet_date: "2026-09-21", time_range: "", title: "Kickoff",
        attendees: "", meet_no: "", link: "", note: "",
      },
    });

    const meeting = read(qc).meetings[0]!;
    expect(meeting.id).toBe("m1");
    expect(meeting.title).toBe("Kickoff");
    for (const field of ["code", "kind", "status", "parties", "organizer", "location", "nas_dir"] as const) {
      expect(meeting[field]).toBe("");
    }
    expect(meeting.start_time).toBeNull();
    expect(meeting.detected).toBe(false);
  });

  it("fills in the columns an older server's node frame does not carry", () => {
    const { qc } = seedBoard();

    onCockpitChanged(qc, WS, {
      scope: "node",
      action: "created",
      entity: { id: "n2", cockpit_id: "cp", code: "L1-02", name: "Platform" },
    });

    const node = read(qc).nodes.find((n) => n.id === "n2")!;
    expect(node.name).toBe("Platform");
    expect(node.owner).toBe("");
    expect(node.progress).toBe(0);
    expect(node.parent_id).toBeNull();
  });

  // Filling gaps must not overwrite: a field the frame does not mention is one
  // the sender had no opinion about, and the cache already holds the answer.
  it("keeps what the board knew about a field the frame leaves out", () => {
    const { qc } = seedBoard({
      meetings: [
        {
          id: "m1", meet_date: "2026-09-21", time_range: "", start_time: null, end_time: null,
          title: "Weekly", code: "20260921-01", kind: "例会", status: "已召开", parties: "复星医药",
          organizer: "杨涛", location: "大湾区", attendees: "杨涛、周洋", meet_no: "", link: "",
          note: "", minutes: "", decisions: "", actions: "", nas_dir: "", detected: false,
        },
      ],
    });

    onCockpitChanged(qc, WS, {
      scope: "meeting",
      action: "updated",
      entity: { id: "m1", meet_date: "2026-09-22", time_range: "", title: "Weekly", attendees: "杨涛、周洋", meet_no: "", link: "", note: "" },
    });

    const meeting = read(qc).meetings[0]!;
    expect(meeting.meet_date).toBe("2026-09-22");
    expect(meeting.kind).toBe("例会");
    expect(meeting.location).toBe("大湾区");
  });

  it("re-reads the board rather than caching a row it cannot make sense of", () => {
    const { qc } = seedBoard();
    const invalidate = vi.spyOn(qc, "invalidateQueries");

    onCockpitChanged(qc, WS, {
      scope: "meeting",
      action: "updated",
      entity: { id: "m1", title: 42 },
    });

    expect(read(qc).meetings).toHaveLength(0);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: cockpitKeys.board(WS) });
  });

  it("replaces a meeting's issue links and carries the meeting row provisioning moved", () => {
    const { qc } = seedBoard({
      meetings: [
        {
          id: "m1", meet_date: "2026-09-21", time_range: "", start_time: "10:00", end_time: "11:00",
          title: "Weekly", code: "20260921-01", kind: "", status: "", parties: "",
          organizer: "", location: "", attendees: "", meet_no: "", link: "", note: "",
          minutes: "", decisions: "", actions: "", nas_dir: "", detected: false,
        },
      ],
    });
    onCockpitChanged(qc, WS, {
      scope: "meeting_issues",
      action: "provisioned",
      entity: {
        meeting_id: "m1",
        // Provisioning creates the folder in the same breath as the task, so
        // the frame carries the meeting row too.
        meeting: {
          id: "m1", meet_date: "2026-09-21", time_range: "", start_time: "10:00", end_time: "11:00",
          title: "Weekly", code: "20260921-01", kind: "", status: "", parties: "",
          organizer: "", location: "", attendees: "", meet_no: "", link: "", note: "",
          minutes: "", decisions: "", actions: "", nas_dir: "/Volumes/share/20260921-01 Weekly",
        },
        links: [
          {
            meeting_id: "m1", issue_id: "i9", role: "task", issue_number: 9,
            issue_identifier: "BIO-9", issue_title: "Weekly", issue_status: "todo", position: -1,
          },
        ],
      },
    });

    const board = read(qc);
    expect(board.meeting_issues).toHaveLength(1);
    expect(board.meeting_issues[0]!.role).toBe("task");
    expect(board.meetings[0]!.nas_dir).toBe("/Volumes/share/20260921-01 Weekly");
  });

  it("removes one meeting link without touching the others", () => {
    const { qc } = seedBoard({
      meeting_issues: [
        { meeting_id: "m1", issue_id: "i1", role: "", issue_number: 1, issue_identifier: "BIO-1",
          issue_title: "One", issue_status: "todo", position: 0 },
        { meeting_id: "m2", issue_id: "i1", role: "", issue_number: 1, issue_identifier: "BIO-1",
          issue_title: "One", issue_status: "todo", position: 0 },
      ],
      meeting_nodes: [{ meeting_id: "m1", node_id: "n1", position: 0 }],
    });
    onCockpitChanged(qc, WS, {
      scope: "meeting_issues",
      action: "removed",
      entity: { meeting_id: "m1", issue_id: "i1" },
    });
    onCockpitChanged(qc, WS, {
      scope: "meeting_nodes",
      action: "removed",
      entity: { meeting_id: "m1", node_id: "n1" },
    });

    const board = read(qc);
    expect(board.meeting_issues.map((l) => l.meeting_id)).toEqual(["m2"]);
    expect(board.meeting_nodes).toHaveLength(0);
  });

  it("takes a deleted meeting's links with it, the way the server did", () => {
    const { qc } = seedBoard({
      meetings: [
        {
          id: "m1", meet_date: null, time_range: "", start_time: null, end_time: null,
          title: "Weekly", code: "", kind: "", status: "", parties: "",
          organizer: "", location: "", attendees: "", meet_no: "", link: "", note: "",
          minutes: "", decisions: "", actions: "", nas_dir: "", detected: false,
        },
      ],
      meeting_issues: [
        { meeting_id: "m1", issue_id: "i1", role: "task", issue_number: 1, issue_identifier: "BIO-1",
          issue_title: "One", issue_status: "todo", position: 0 },
      ],
      meeting_nodes: [{ meeting_id: "m1", node_id: "n1", position: 0 }],
    });
    onCockpitChanged(qc, WS, { scope: "meeting", action: "deleted", entity: { id: "m1" } });

    const board = read(qc);
    expect(board.meetings).toHaveLength(0);
    expect(board.meeting_issues).toHaveLength(0);
    expect(board.meeting_nodes).toHaveLength(0);
  });

  it("drops a deleted node's meeting links", () => {
    const { qc } = seedBoard({
      meeting_nodes: [
        { meeting_id: "m1", node_id: "n1", position: 0 },
        { meeting_id: "m1", node_id: "n2", position: 1 },
      ],
    });
    onCockpitChanged(qc, WS, { scope: "node", action: "deleted", entity: { id: "n1" } });
    expect(read(qc).meeting_nodes.map((l) => l.node_id)).toEqual(["n2"]);
  });

  it("does nothing when no board is cached yet", () => {
    const qc = new QueryClient();
    onCockpitChanged(qc, WS, { scope: "node", action: "updated", entity: { id: "n1" } });
    expect(qc.getQueryData(cockpitKeys.board(WS))).toBeUndefined();
  });
});
