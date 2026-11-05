// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isFloatingChatRouteSuppressed } from "./floating-chat-visibility";

describe("floating chat route suppression", () => {
  it("suppresses the overlay on the Chat tab and its sub-routes", () => {
    expect(isFloatingChatRouteSuppressed("/acme/chat", "/acme/chat")).toBe(true);
    expect(isFloatingChatRouteSuppressed("/acme/chat/session-1", "/acme/chat")).toBe(true);
  });

  it("keeps the overlay on every other route, including prefix look-alikes", () => {
    expect(isFloatingChatRouteSuppressed("/acme/issues", "/acme/chat")).toBe(false);
    // A sibling route that merely starts with the same characters is not the
    // Chat tab — matching on the bare prefix would hide chat from it.
    expect(isFloatingChatRouteSuppressed("/acme/chatter", "/acme/chat")).toBe(false);
    // Another workspace's chat tab is a different route too.
    expect(isFloatingChatRouteSuppressed("/other/chat", "/acme/chat")).toBe(false);
  });
});

it("suppresses the overlay only on the cockpit's full-page chat surface", () => {
  const cockpit = (search: string) => ({ pathname: "/acme/cockpit", search: new URLSearchParams(search) });
  // The cockpit home is the work overview (silver dashboard pass); only an
  // explicit chat tab or a session/agent deep link opens the full-page chat.
  for (const search of ["", "tab=work", "tab=meetings", "meeting=m1", "tab=plan", "tab=artifacts"]) {
    expect(isFloatingChatRouteSuppressed("/acme/cockpit", "/acme/chat", cockpit(search))).toBe(false);
  }
  for (const search of ["tab=chat", "session=s1", "agent=a1"]) {
    expect(isFloatingChatRouteSuppressed("/acme/cockpit", "/acme/chat", cockpit(search))).toBe(true);
  }
});
