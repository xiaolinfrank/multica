// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cockpitMeetingStage, meetingStageDefaultSection } from "./meeting-stage";

describe("meeting stage projection", () => {
  it("projects preparation before any confirmation", () => {
    expect(cockpitMeetingStage("unconfirmed", undefined)).toBe("preparation");
    expect(cockpitMeetingStage("scheduled", {})).toBe("preparation");
  });
  it("projects recording once the start is confirmed", () => {
    expect(cockpitMeetingStage("in_progress", {})).toBe("recording");
  });
  it("splits ended into minutes confirmation and follow-up by the published pointer", () => {
    expect(cockpitMeetingStage("ended", undefined)).toBe("minutes_review");
    expect(cockpitMeetingStage("ended", {})).toBe("minutes_review");
    expect(cockpitMeetingStage("ended", { published_version_id: null })).toBe("minutes_review");
    expect(cockpitMeetingStage("ended", { published_version_id: "v-1" })).toBe("followup");
  });
  it("has no stage line for a cancelled meeting", () => {
    expect(cockpitMeetingStage("cancelled", { published_version_id: "v-1" })).toBeNull();
  });
  it("lands ended meetings on minutes and the rest on the agenda", () => {
    expect(meetingStageDefaultSection("ended", { published_version_id: "v-1" })).toBe("workflow");
    expect(meetingStageDefaultSection("ended", {})).toBe("workflow");
    expect(meetingStageDefaultSection("scheduled", {})).toBe("agenda");
    expect(meetingStageDefaultSection(undefined, undefined)).toBe("agenda");
  });
});
