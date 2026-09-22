// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  CockpitMeeting,
  CockpitMeetingIssueLink,
  CockpitMeetingNodeLink,
  CockpitNode,
} from "../types";
import {
  COCKPIT_MEETING_KINDS,
  COCKPIT_MEETING_STATUSES,
  cockpitArchiveNodeOptions,
  cockpitMeetingPeopleOptions,
  cockpitNodeLabel,
  joinCockpitMeetingValues,
  splitCockpitMeetingPeople,
  cockpitMeetingFolderName,
  cockpitMeetingMinutes,
  cockpitMeetingSpan,
  cockpitMeetingVocabulary,
  cockpitMeetingsByDay,
  cockpitMonthGrid,
  cockpitWeekDays,
  cockpitWeekWindow,
  groupMeetingIssues,
  groupMeetingNodes,
  groupMeetingsByNode,
  nextCockpitMeetingCode,
  shiftMonthKey,
  sortCockpitMeetings,
  splitCockpitMeetings,
  splitCockpitMeetingParties,
} from "./model";

function meeting(over: Partial<CockpitMeeting> & { id: string }): CockpitMeeting {
  return {
    meet_date: null, time_range: "", start_time: null, end_time: null, title: "",
    code: "", kind: "", status: "", parties: "", organizer: "", location: "",
    attendees: "", meet_no: "", link: "", note: "", minutes: "", decisions: "", actions: "",
    nas_dir: "", detected: false, ...over,
  };
}

describe("meeting times", () => {
  it("reads a wall clock and refuses one that is not one", () => {
    expect(cockpitMeetingMinutes("10:30")).toBe(630);
    expect(cockpitMeetingMinutes("9:05")).toBe(545);
    expect(cockpitMeetingMinutes("24:00")).toBeNull();
    expect(cockpitMeetingMinutes("10:70")).toBeNull();
    expect(cockpitMeetingMinutes("")).toBeNull();
    expect(cockpitMeetingMinutes(null)).toBeNull();
  });

  it("prefers the structured span and falls back to the text the log recorded", () => {
    expect(cockpitMeetingSpan(meeting({ id: "a", start_time: "10:00", end_time: "11:00" })))
      .toBe("10:00–11:00");
    expect(cockpitMeetingSpan(meeting({ id: "b", start_time: "10:00" }))).toBe("10:00");
    // A row nobody has re-timed still reads out of the free text it was
    // written with, en dash and all.
    expect(cockpitMeetingSpan(meeting({ id: "c", time_range: "15:00–16:00" }))).toBe("15:00–16:00");
    expect(cockpitMeetingSpan(meeting({ id: "d" }))).toBe("");
  });
});

describe("ordering and bucketing", () => {
  const rows = [
    meeting({ id: "late", meet_date: "2026-09-21", start_time: "15:00", title: "Afternoon" }),
    meeting({ id: "early", meet_date: "2026-09-21", start_time: "09:00", title: "Morning" }),
    meeting({ id: "untimed", meet_date: "2026-09-21", title: "All day" }),
    meeting({ id: "yesterday", meet_date: "2026-09-20", title: "Yesterday" }),
    meeting({ id: "draft", title: "No date at all" }),
  ];

  it("sorts by day then hour, with the untimed meeting leading its day", () => {
    expect(sortCockpitMeetings(rows).map((m) => m.id)).toEqual([
      "yesterday", "untimed", "early", "late", "draft",
    ]);
  });

  it("buckets by day and keeps each day in time order", () => {
    const byDay = cockpitMeetingsByDay(rows);
    expect([...byDay.keys()]).toEqual(["2026-09-20", "2026-09-21"]);
    expect(byDay.get("2026-09-21")!.map((m) => m.id)).toEqual(["untimed", "early", "late"]);
    // An undated draft belongs to no day rather than to today.
    expect([...byDay.values()].flat().some((m) => m.id === "draft")).toBe(false);
  });

  it("splits into upcoming, held and unscheduled around today", () => {
    const split = splitCockpitMeetings(rows, "2026-09-21");
    expect(split.upcoming.map((m) => m.id)).toEqual(["untimed", "early", "late"]);
    expect(split.past.map((m) => m.id)).toEqual(["yesterday"]);
    expect(split.undated.map((m) => m.id)).toEqual(["draft"]);
  });

  it("puts the most recent meeting first in the held list", () => {
    const split = splitCockpitMeetings(
      [
        meeting({ id: "old", meet_date: "2026-08-01" }),
        meeting({ id: "recent", meet_date: "2026-09-01" }),
      ],
      "2026-09-21",
    );
    expect(split.past.map((m) => m.id)).toEqual(["recent", "old"]);
  });
});

describe("calendar geometry", () => {
  it("anchors a week on Monday", () => {
    // 2026-09-21 is a Monday; a Sunday must resolve to the week that just ran,
    // not the one about to.
    expect(cockpitWeekWindow("2026-09-21")).toEqual(["2026-09-21", "2026-09-27"]);
    expect(cockpitWeekWindow("2026-09-27")).toEqual(["2026-09-21", "2026-09-27"]);
    expect(cockpitWeekDays("2026-09-23")).toEqual([
      "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27",
    ]);
  });

  it("pads a month to whole Monday-start weeks", () => {
    const grid = cockpitMonthGrid("2026-09");
    expect(grid.length % 7).toBe(0);
    // 2026-09-01 is a Tuesday, so the grid opens on the Monday before it.
    expect(grid[0]).toBe("2026-08-31");
    expect(grid).toContain("2026-09-30");
    expect(grid.filter((day) => day.startsWith("2026-09"))).toHaveLength(30);
  });

  it("steps months across a year boundary", () => {
    expect(shiftMonthKey("2026-12", 1)).toBe("2027-01");
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
  });
});

describe("the name the platform proposes", () => {
  it("numbers per day and continues where the day left off", () => {
    const rows = [
      meeting({ id: "a", code: "20260921-01" }),
      meeting({ id: "b", code: "20260921-02" }),
      meeting({ id: "c", code: "20260920-07" }),
    ];
    expect(nextCockpitMeetingCode(rows, "2026-09-21")).toBe("20260921-03");
    expect(nextCockpitMeetingCode(rows, "2026-09-22")).toBe("20260922-01");
    expect(nextCockpitMeetingCode([], "2026-09-21")).toBe("20260921-01");
  });

  it("ignores a number a human wrote in some other shape", () => {
    const rows = [meeting({ id: "a", code: "W38 例会" })];
    expect(nextCockpitMeetingCode(rows, "2026-09-21")).toBe("20260921-01");
  });

  it("splits parties on whichever separator was typed", () => {
    expect(splitCockpitMeetingParties("复星医药、华大基因")).toEqual(["复星医药", "华大基因"]);
    expect(splitCockpitMeetingParties("A × B / C")).toEqual(["A", "B", "C"]);
    expect(splitCockpitMeetingParties("  ")).toEqual([]);
  });
});

describe("the folder a meeting files its material in", () => {
  it("does not write the number twice when the name already carries it", () => {
    expect(
      cockpitMeetingFolderName({ code: "20260921-01", title: "20260921-01 复星医药×华大基因" }),
    ).toBe("20260921-01 复星医药×华大基因");
  });

  it("prefixes the number onto a name someone typed themselves", () => {
    expect(cockpitMeetingFolderName({ code: "20260921-01", title: "临时碰头" }))
      .toBe("20260921-01 临时碰头");
  });

  it("falls back to whichever half it has", () => {
    expect(cockpitMeetingFolderName({ code: "20260921-01", title: "" })).toBe("20260921-01");
    expect(cockpitMeetingFolderName({ code: "", title: "临时碰头" })).toBe("临时碰头");
    // A number that IS the whole name is not doubled either.
    expect(cockpitMeetingFolderName({ code: "20260921-01", title: "20260921-01" }))
      .toBe("20260921-01");
  });
});

describe("links", () => {
  const issues: CockpitMeetingIssueLink[] = [
    { meeting_id: "m1", issue_id: "i2", role: "", issue_number: 2, issue_identifier: "BIO-2",
      issue_title: "Second", issue_status: "todo", position: 1 },
    { meeting_id: "m1", issue_id: "i1", role: "task", issue_number: 1, issue_identifier: "BIO-1",
      issue_title: "The meeting task", issue_status: "todo", position: -1 },
    { meeting_id: "m2", issue_id: "i3", role: "", issue_number: 3, issue_identifier: "BIO-3",
      issue_title: "Other", issue_status: "done", position: 0 },
  ];
  const nodeLinks: CockpitMeetingNodeLink[] = [
    { meeting_id: "m1", node_id: "n1", position: 0 },
    { meeting_id: "m2", node_id: "n1", position: 0 },
  ];

  it("groups a meeting's issues in position order, the meeting's own task first", () => {
    const grouped = groupMeetingIssues(issues);
    expect(grouped.get("m1")!.map((l) => l.issue_id)).toEqual(["i1", "i2"]);
    expect(grouped.get("m2")!).toHaveLength(1);
  });

  it("groups a meeting's work items", () => {
    expect(groupMeetingNodes(nodeLinks).get("m1")!.map((l) => l.node_id)).toEqual(["n1"]);
  });

  it("reads the other way round, newest meeting first, and drops links to meetings that are gone", () => {
    const meetings = [
      meeting({ id: "m1", meet_date: "2026-09-01", title: "First" }),
      meeting({ id: "m2", meet_date: "2026-09-15", title: "Second" }),
    ];
    const byNode = groupMeetingsByNode(meetings, [
      ...nodeLinks,
      { meeting_id: "deleted", node_id: "n1", position: 0 },
    ]);
    expect(byNode.get("n1")!.map((m) => m.id)).toEqual(["m2", "m1"]);
  });
});

describe("vocabulary", () => {
  const rows = [
    meeting({ id: "a", kind: "例会", status: "已召开",
      parties: "复星医药、华大基因", organizer: "杨涛", location: "大湾区",
      attendees: "杨涛、王工" }),
    meeting({ id: "b", kind: "研讨", parties: "复星医药、联通", organizer: "杨涛",
      attendees: "王工" }),
    meeting({ id: "c" }),
  ];

  it("offers the words the board already uses, multi-value fields split apart", () => {
    const vocabulary = cockpitMeetingVocabulary(rows);
    expect(vocabulary.parties).toContain("华大基因");
    expect(vocabulary.parties).toContain("联通");
    // "复星医药" appears in two meetings and must be offered once.
    expect(vocabulary.parties.filter((p) => p === "复星医药")).toHaveLength(1);
    // An empty field is not vocabulary.
    expect(vocabulary.locations).toEqual(["大湾区"]);
    expect(vocabulary.organizers).toEqual(["杨涛"]);
    expect(vocabulary.attendees).toEqual(["王工", "杨涛"].sort((a, b) => a.localeCompare(b)));
  });

  it("leads type and status with the programme's own words, then whatever else was typed", () => {
    const vocabulary = cockpitMeetingVocabulary(rows);
    // An empty board still opens on a vocabulary; "研讨" is not one of the
    // programme's words and follows them rather than replacing them.
    expect(vocabulary.kinds.slice(0, COCKPIT_MEETING_KINDS.length)).toEqual([
      ...COCKPIT_MEETING_KINDS,
    ]);
    expect(vocabulary.kinds).toContain("研讨");
    expect(vocabulary.kinds.filter((k) => k === "例会")).toHaveLength(1);
    expect(vocabulary.statuses[0]).toBe(COCKPIT_MEETING_STATUSES[0]);
    expect(vocabulary.statuses).toContain("已召开");
    expect(cockpitMeetingVocabulary([]).kinds).toEqual([...COCKPIT_MEETING_KINDS]);
  });
});

describe("multi-value meeting fields", () => {
  it("splits people on list punctuation but not on the marks that join parties", () => {
    expect(splitCockpitMeetingPeople("杨涛、王工，李博")).toEqual(["杨涛", "王工", "李博"]);
    // "×" joins two SIDES of a meeting and "/" turns up inside a job title;
    // neither splits a list of names.
    expect(splitCockpitMeetingPeople("杨涛（研发/数据）")).toEqual(["杨涛（研发/数据）"]);
    expect(splitCockpitMeetingPeople("  ")).toEqual([]);
  });

  it("keeps a separator inside brackets out of it", () => {
    // Real board data: one way of describing a group, not two people.
    expect(splitCockpitMeetingPeople("项目组全体（各领导、老师）"))
      .toEqual(["项目组全体（各领导、老师）"]);
    expect(splitCockpitMeetingPeople("杨涛、项目组全体（各领导、老师）、王工"))
      .toEqual(["杨涛", "项目组全体（各领导、老师）", "王工"]);
    expect(splitCockpitMeetingParties("复星医药（大湾区、上海）、华大基因"))
      .toEqual(["复星医药（大湾区、上海）", "华大基因"]);
    // An unclosed bracket must not swallow the rest of the list.
    expect(splitCockpitMeetingPeople("杨涛（研发、王工")).toEqual(["杨涛（研发、王工"]);
  });

  it("writes a multi-value field back with one separator and no repeats", () => {
    expect(joinCockpitMeetingValues(["复星医药", "华大基因", "复星医药", " "]))
      .toBe("复星医药、华大基因");
    expect(joinCockpitMeetingValues([])).toBe("");
  });

  it("offers workspace members first and the board's other names after them", () => {
    expect(cockpitMeetingPeopleOptions(["杨涛", "李博"], ["王工", "杨涛"]))
      .toEqual(["杨涛", "李博", "王工"]);
  });
});

describe("the sub-item a meeting is archived under", () => {
  const nodes = [
    { id: "n6", parent_id: null, code: "06", name: "项目管理与规划" },
    { id: "n66", parent_id: "n6", code: "06.06", name: "多方协同与会议" },
    { id: "n6601", parent_id: "n66", code: "06.06.01", name: "协作方名录与协议" },
    { id: "n6603", parent_id: "n66", code: "06.06.03", name: "会议纪要与素材" },
    { id: "n67", parent_id: "n6", code: "06.07", name: "别的模块" },
  ].map((node) => ({ ...node, position: 0, color: "", owner: "" }) as unknown as CockpitNode);

  it("offers the children of the node the module answers to, spacing and all", () => {
    // The platform writes the module with a space and the tree without one.
    expect(cockpitArchiveNodeOptions(nodes, "06.06 多方协同与会议").map((n) => n.id))
      .toEqual(["n6601", "n6603"]);
    expect(cockpitArchiveNodeOptions(nodes, "06.06多方协同与会议").map((n) => n.id))
      .toEqual(["n6601", "n6603"]);
  });

  it("matches on the number first, so a rename of either side still resolves", () => {
    expect(cockpitArchiveNodeOptions(nodes, "06.06 会议与协同（改过名）").map((n) => n.id))
      .toEqual(["n6601", "n6603"]);
  });

  it("falls back to the whole title for a module that carries no number", () => {
    const unnumbered = nodes.map((node) =>
      node.code === "06.06" ? ({ ...node, code: "" } as CockpitNode) : node,
    );
    expect(cockpitArchiveNodeOptions(unnumbered, "多方协同与会议").map((n) => n.id))
      .toEqual(["n6601", "n6603"]);
  });

  it("offers nothing when no node answers to the module", () => {
    expect(cockpitArchiveNodeOptions(nodes, "09 某个模块")).toEqual([]);
    expect(cockpitArchiveNodeOptions(nodes, "")).toEqual([]);
  });

  it("keeps a node the board already chose, even from under another module", () => {
    // Silently dropping the board's own setting would change it the next
    // time anyone pressed save.
    expect(cockpitArchiveNodeOptions(nodes, "06.07 别的模块", "n6603").map((n) => n.id))
      .toEqual(["n6603"]);
    expect(cockpitArchiveNodeOptions(nodes, "06.06 多方协同与会议", "n6603").map((n) => n.id))
      .toEqual(["n6601", "n6603"]);
  });

  it("reads a node the way a picker shows it", () => {
    expect(cockpitNodeLabel(nodes[3]!)).toBe("06.06.03 会议纪要与素材");
  });
});
