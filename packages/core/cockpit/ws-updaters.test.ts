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

  it("does nothing when no board is cached yet", () => {
    const qc = new QueryClient();
    onCockpitChanged(qc, WS, { scope: "node", action: "updated", entity: { id: "n1" } });
    expect(qc.getQueryData(cockpitKeys.board(WS))).toBeUndefined();
  });
});
