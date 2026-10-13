// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitMeetingStage, meetingInsideWindow, meetingStageDefaultView } from "./meeting-stage";

const NOON = new Date("2026-10-13T12:00:00");
const WINDOW = { meet_date: "2026-10-13", start_time: "11:00", end_time: "13:00" } as const;

describe("meeting stage projection", () => {
  it("projects preparation for a scheduled meeting outside its window", () => {
    expect(cockpitMeetingStage("unconfirmed", undefined, null, NOON)).toBe("preparation");
    expect(cockpitMeetingStage("scheduled", {}, WINDOW, new Date("2026-10-13T09:00:00"))).toBe("preparation");
    expect(cockpitMeetingStage("scheduled", {}, { meet_date: "2026-10-12", start_time: "11:00", end_time: null }, NOON)).toBe("preparation");
  });
  it("projects recording from the scheduled window — no start confirmation exists (R4 collapse)", () => {
    expect(cockpitMeetingStage("scheduled", {}, WINDOW, NOON)).toBe("recording");
    expect(cockpitMeetingStage("scheduled", {}, { meet_date: "2026-10-13", start_time: null, end_time: null }, NOON)).toBe("recording");
    expect(meetingInsideWindow(WINDOW, new Date("2026-10-13T13:30:00"))).toBe(false);
  });
  it("splits ended into minutes confirmation and follow-up by the published pointer", () => {
    expect(cockpitMeetingStage("ended", undefined, WINDOW, NOON)).toBe("minutes_review");
    expect(cockpitMeetingStage("ended", {}, WINDOW, NOON)).toBe("minutes_review");
    expect(cockpitMeetingStage("ended", { published_version_id: null }, WINDOW, NOON)).toBe("minutes_review");
    expect(cockpitMeetingStage("ended", { published_version_id: "v-1" }, WINDOW, NOON)).toBe("followup");
  });
  it("has no stage line for a cancelled meeting", () => {
    expect(cockpitMeetingStage("cancelled", { published_version_id: "v-1" }, WINDOW, NOON)).toBeNull();
  });
  it("lands each stage on its own working view", () => {
    expect(meetingStageDefaultView("ended", { published_version_id: "v-1" })).toBe("followup");
    expect(meetingStageDefaultView("ended", {})).toBe("minutes_review");
    expect(meetingStageDefaultView("scheduled", {}, WINDOW, NOON)).toBe("recording");
    expect(meetingStageDefaultView("scheduled", {})).toBe("preparation");
    expect(meetingStageDefaultView(undefined, undefined)).toBe("preparation");
  });
});
