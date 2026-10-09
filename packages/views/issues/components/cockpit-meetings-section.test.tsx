// @vitest-environment jsdom

import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CockpitBoard, CockpitMeeting, CockpitIssueActionSourcesPage } from "@multica/core/types";
import { WorkspaceSlugProvider } from "@multica/core/paths";
import { renderWithI18n } from "../../test/i18n";
import { NavigationProvider } from "../../navigation";
import type { NavigationAdapter } from "../../navigation/types";

const queryRef = vi.hoisted(() => ({
  current: { data: undefined as CockpitBoard | undefined, isLoading: false },
  sources: null as CockpitIssueActionSourcesPage | null,
}));

const mutRef = vi.hoisted(() => ({
  link: { mutate: vi.fn(), isPending: false },
  unlink: { mutate: vi.fn(), isPending: false },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query",
  );
  return { ...actual, useQuery: (options: { queryKey: readonly unknown[] }) => options.queryKey[2] === "issue-action-sources"
    ? { data: queryRef.sources ?? { issue_id: options.queryKey[3], items: [], total: 0, next_cursor: null }, isPending: false, isError: false } : queryRef.current };
});

vi.mock("@multica/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));

vi.mock("@multica/core/cockpit", async () => {
  const actual = await vi.importActual<typeof import("@multica/core/cockpit")>(
    "@multica/core/cockpit",
  );
  return {
    ...actual,
    useSetCockpitMeetingIssues: () => mutRef.link,
    useDeleteCockpitMeetingIssue: () => mutRef.unlink,
  };
});

// The picker is a portal-mounted popover with its own filtering; the stub
// surfaces what the section wired into it so both sides of the toggle stay
// testable without driving one.
vi.mock("../../cockpit/components/cockpit-meeting-picker", async () => {
  const actual = await vi.importActual<
    typeof import("../../cockpit/components/cockpit-meeting-picker")
  >("../../cockpit/components/cockpit-meeting-picker");
  return {
    ...actual,
    CockpitMeetingPicker: ({
      meetings,
      selectedIds,
      onToggle,
      label,
      disabled,
    }: {
      meetings: CockpitMeeting[];
      selectedIds: Set<string>;
      onToggle: (meetingId: string) => void;
      label: string;
      disabled?: boolean;
    }) => (
      <div>
        <span data-testid="picker-label">{label}</span>
        <span data-testid="picker-count">{meetings.length}</span>
        <span data-testid="picker-selected">{[...selectedIds].sort().join(",")}</span>
        <button
          type="button"
          data-testid="picker-toggle"
          disabled={disabled}
          onClick={() => onToggle("m3")}
        >
          toggle m3
        </button>
      </div>
    ),
  };
});

import { CockpitMeetingsSection } from "./cockpit-meetings-section";

const adapter: NavigationAdapter = {
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  pathname: "/",
  searchParams: new URLSearchParams(),
  hash: "",
  getShareableUrl: (p) => p,
};

function renderSection(ui: React.ReactElement) {
  return renderWithI18n(
    <WorkspaceSlugProvider slug="acme">
      <NavigationProvider value={adapter}>{ui}</NavigationProvider>
    </WorkspaceSlugProvider>,
  );
}

function meeting(partial: Partial<CockpitMeeting> & { id: string }): CockpitMeeting {
  return {
    meet_date: null,
    time_range: "",
    start_time: null,
    end_time: null,
    title: "",
    code: "",
    kind: "",
    status: "",
    parties: "",
    organizer: "",
    location: "",
    attendees: "",
    meet_no: "",
    link: "",
    note: "",
    minutes: "",
    decisions: "",
    actions: "",
    nas_dir: "",
    detected: false,
    track: "",
    ...partial,
  };
}

function link(meetingId: string, issueId: string, role = "") {
  return {
    meeting_id: meetingId,
    issue_id: issueId,
    role,
    roles: [],
    issue_number: 1,
    issue_identifier: "BIO-1",
    issue_title: "One",
    issue_status: "todo",
    position: 0,
  };
}

function makeBoard(partial: Partial<CockpitBoard> = {}): CockpitBoard {
  return {
    cockpit: {
      id: "board-1",
      workspace_id: "ws-1",
      title: "Programme",
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
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-01T00:00:00Z",
    },
    nodes: [],
    payments: [],
    issue_links: [],
    milestones: [],
    meetings: [
      meeting({ id: "m1", code: "20260921-01", title: "工作组周会", meet_date: "2026-09-21" }),
      meeting({ id: "m2", code: "20260918-01", title: "数据治理对接", meet_date: "2026-09-18" }),
      meeting({ id: "m3", code: "20260915-01", title: "启动会", meet_date: "2026-09-15" }),
    ],
    // m1 filed this issue (the meeting's own task); m2 was attached by hand.
    meeting_issues: [
      link("m1", "issue-1", "task"),
      link("m2", "issue-1"),
      link("m3", "issue-2"),
    ],
    meeting_nodes: [],
    ...partial,
  };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mutRef.link.isPending = false;
  mutRef.unlink.isPending = false;
  queryRef.current = { data: undefined, isLoading: false };
  queryRef.sources = null;
});

describe("CockpitMeetingsSection", () => {
  it("shows an accepted action source independently of editable reference meetings", () => {
    queryRef.sources = { issue_id: "issue-1", total: 1, next_cursor: null, items: [{ id: "action-1", meeting_id: "meeting-1", meeting_code: "M-01", meeting_title: "Delivery review", version_id: "v1", version_number: 1, title: "Verify interface" }] };
    renderSection(<CockpitMeetingsSection issueId="issue-1" />);
    const sources = screen.getByRole("region", { name: "Meeting action sources" });
    expect(within(sources).getByRole("link", { name: "M-01 Delivery review" })).toHaveAttribute("href", "/acme/cockpit?meeting=meeting-1&action=action-1");
    expect(within(sources).queryByRole("button", { name: /Unlink/ })).toBeNull();
    expect(sources).toHaveTextContent("Minutes v1 · Verify interface");
  });
  it("renders nothing while the board loads or the programme keeps no register", () => {
    queryRef.current = { data: undefined, isLoading: true };
    expect(
      renderSection(<CockpitMeetingsSection issueId="issue-1" />).container,
    ).toBeEmptyDOMElement();

    queryRef.current = { data: makeBoard({ meetings: [], meeting_issues: [] }), isLoading: false };
    expect(
      renderSection(<CockpitMeetingsSection issueId="issue-1" />).container,
    ).toBeEmptyDOMElement();
  });

  it("lists this issue's meetings in register order, the filing one included", () => {
    queryRef.current = { data: makeBoard(), isLoading: false };
    renderSection(<CockpitMeetingsSection issueId="issue-1" />);

    // The meeting that opened this task is a link like any other, so a task
    // filed by provisioning shows where it came from without being wired up.
    const first = screen.getByRole("link", { name: "20260921-01 工作组周会" });
    expect(first).toHaveAttribute("href", "/acme/cockpit?meeting=m1");
    expect(screen.getByRole("link", { name: "20260918-01 数据治理对接" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /启动会/ })).toBeNull();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByTestId("picker-count").textContent).toBe("3");
    expect(screen.getByTestId("picker-selected").textContent).toBe("m1,m2");
  });

  it("opens the exact meeting through the workspace adapter with an encoded identity", () => {
    const meetingId = "会议/1?scope=a&b";
    queryRef.current = {
      data: makeBoard({
        meetings: [meeting({ id: meetingId, title: "Review" })],
        meeting_issues: [link(meetingId, "issue-1")],
      }),
      isLoading: false,
    };
    renderSection(<CockpitMeetingsSection issueId="issue-1" />);

    const target = `/acme/cockpit?meeting=${encodeURIComponent(meetingId)}`;
    const row = screen.getByRole("link", { name: "Review" });
    expect(row).toHaveAttribute("href", target);
    fireEvent.click(row);
    expect(adapter.push).toHaveBeenCalledWith(target);
  });

  it("keeps unavailable meeting relations visible without sending users to the cockpit root", () => {
    queryRef.current = {
      data: makeBoard({ meetings: [], meeting_issues: [link("missing", "issue-1")] }),
      isLoading: false,
    };
    renderSection(<CockpitMeetingsSection issueId="issue-1" />);

    expect(screen.getByText("Meeting unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByText("No meetings linked.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unlink Meeting unavailable" }));
    expect(mutRef.unlink.mutate).toHaveBeenCalledWith(
      { meetingId: "missing", issueId: "issue-1" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("gives an unnamed meeting an accessible label and preserves its destination", () => {
    queryRef.current = {
      data: makeBoard({ meetings: [meeting({ id: "m1" })], meeting_issues: [link("m1", "issue-1")] }),
      isLoading: false,
    };
    renderSection(<CockpitMeetingsSection issueId="issue-1" />);

    expect(screen.getByRole("link", { name: "Untitled meeting" })).toHaveAttribute(
      "href", "/acme/cockpit?meeting=m1",
    );
  });

  it("shows the purposes for the linked meeting, including a newer server role", () => {
    queryRef.current = {
      data: makeBoard({
        meeting_issues: [{ ...link("m1", "issue-1"), roles: ["preparation", "future_role"] }],
      }),
      isLoading: false,
    };
    renderSection(<CockpitMeetingsSection issueId="issue-1" />);

    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Preparation")).toBeInTheDocument();
    expect(within(row).getByText("Other: future_role")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "20260921-01 工作组周会" })).toHaveAttribute(
      "href", "/acme/cockpit?meeting=m1",
    );
  });

  it("shows the empty state and the picker when nothing is linked yet", () => {
    queryRef.current = { data: makeBoard(), isLoading: false };
    renderSection(<CockpitMeetingsSection issueId="issue-9" />);

    expect(screen.getByText("No meetings linked.")).toBeInTheDocument();
    expect(screen.getByTestId("picker-selected").textContent).toBe("");
    expect(screen.getByTestId("picker-label").textContent).toBe("Add meeting");
  });

  it("unlinks through the row button and appends through the picker toggle", () => {
    queryRef.current = { data: makeBoard(), isLoading: false };
    renderSection(<CockpitMeetingsSection issueId="issue-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Unlink 20260918-01 数据治理对接" }));
    expect(mutRef.unlink.mutate).toHaveBeenCalledWith(
      { meetingId: "m2", issueId: "issue-1" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    // m3 already carries another issue's link. This end sends only its own —
    // replacing the set from here would drop links it cannot see, and the
    // server keeps each surviving pair's role.
    fireEvent.click(screen.getByTestId("picker-toggle"));
    expect(mutRef.link.mutate).toHaveBeenCalledWith(
      { meetingId: "m3", issueIds: ["issue-1"] },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it("collapses and re-expands its body from the header", () => {
    queryRef.current = { data: makeBoard(), isLoading: false };
    renderSection(<CockpitMeetingsSection issueId="issue-1" />);

    fireEvent.click(screen.getByRole("button", { name: /Meetings/ }));
    expect(screen.queryByRole("link")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Meetings/ }));
    expect(screen.getByRole("link", { name: "20260921-01 工作组周会" })).toBeInTheDocument();
  });

  it("disables editing while a link mutation is in flight", () => {
    mutRef.link.isPending = true;
    queryRef.current = { data: makeBoard(), isLoading: false };
    renderSection(<CockpitMeetingsSection issueId="issue-1" />);

    expect(screen.getByTestId("picker-toggle")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unlink 20260921-01 工作组周会" })).toBeDisabled();
  });
});
