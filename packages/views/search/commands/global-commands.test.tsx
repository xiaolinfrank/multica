import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multica/core/i18n/react";
import { RESOURCES } from "../../locales";
import { useGlobalCommands } from "./global-commands";

const h = vi.hoisted(() => ({
  pathname: "/acme/cockpit",
  searchParams: new URLSearchParams(),
  push: vi.fn(),
  chat: { floatingChatEnabled: true, setOpen: vi.fn() },
}));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    pathname: h.pathname,
    searchParams: h.searchParams,
    push: h.push,
  }),
}));

vi.mock("@multica/core/paths", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@multica/core/paths")>();
  return {
    ...actual,
    useWorkspacePaths: () => actual.paths.workspace("acme"),
  };
});

// Callable-store shape (selectorFn + getState) per the repo testing rules.
vi.mock("@multica/core/chat", () => ({
  useChatStore: Object.assign(
    (selector: (s: typeof h.chat) => unknown) => selector(h.chat),
    { getState: () => h.chat },
  ),
}));

vi.mock("@multica/core/shortcuts", () => ({ useShortcut: () => null }));
vi.mock("@multica/core/inbox/mutations", () => ({
  useMarkAllInboxRead: () => ({ mutateAsync: vi.fn() }),
  useArchiveAllReadInbox: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@multica/core/issues/stores", () => ({
  openCreateIssueWithPreference: vi.fn(),
}));
vi.mock("@multica/core/modals", () => ({
  useModalStore: { getState: () => ({ open: vi.fn() }) },
}));
vi.mock("../palette-context", () => ({
  usePalette: () => ({ openHostDialog: vi.fn() }),
}));

function Harness() {
  const commands = useGlobalCommands([]);
  return (
    <div>
      {commands.map((command) => (
        <button key={command.id} type="button" onClick={() => command.run?.()}>
          {command.id}
        </button>
      ))}
    </div>
  );
}

function runChatWithAgent() {
  render(
    <I18nProvider locale="en" resources={RESOURCES}>
      <Harness />
    </I18nProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "chat-with-agent" }));
}

describe("global chat-with-agent command", () => {
  beforeEach(() => {
    h.pathname = "/acme/cockpit";
    h.searchParams = new URLSearchParams();
    h.chat = { floatingChatEnabled: true, setOpen: vi.fn() };
    h.push.mockClear();
  });

  it("navigates to Chat instead of opening the floating window on cockpit chat", () => {
    // Cockpit Chat already owns the full-page conversation, so flipping the
    // overlay open here would read as a dead keypress and pop a window later.
    h.searchParams = new URLSearchParams("tab=chat");

    runChatWithAgent();

    expect(h.chat.setOpen).not.toHaveBeenCalled();
    expect(h.push).toHaveBeenCalledWith("/acme/chat");
  });

  it("still opens the floating window on other cockpit tabs", () => {
    h.searchParams = new URLSearchParams("tab=plan");

    runChatWithAgent();

    expect(h.chat.setOpen).toHaveBeenCalledWith(true);
    expect(h.push).not.toHaveBeenCalled();
  });
});
