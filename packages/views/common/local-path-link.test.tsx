import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configStore } from "@multica/core/config";
import { renderWithI18n } from "../test/i18n";
import { DESKTOP_SHELL_HANDOFF_TIMEOUT_MS, LocalPathLink } from "./local-path-link";

const mocks = vi.hoisted(() => ({
  copyText: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@multica/ui/lib/clipboard", () => ({ copyText: mocks.copyText }));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

const PATH = "/Volumes/人机协作空间/AI医药联合创新平台/01高质量数据集";

/** A UNC path naming a server the deployment did not configure. */
const UNTRUSTED_UNC = "\\\\evil.example.com\\pwn\\share";

const MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function setUserAgent(value: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value,
    configurable: true,
  });
}

/** Install the preload bridge a desktop build exposes. Absent = a browser,
 *  which is what `canOpenLocalPath` probes for. */
function installDesktopBridge(
  openLocalPath: ReturnType<typeof vi.fn>,
): void {
  (window as unknown as { desktopAPI?: unknown }).desktopAPI = { openLocalPath };
}

beforeEach(() => {
  mocks.copyText.mockReset().mockResolvedValue(true);
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  setUserAgent(MAC_UA);
  // Default: a deployment with no shared storage configured.
  configStore.getState().setCollabSpaceHost("");
});

afterEach(() => {
  delete (window as unknown as { desktopAPI?: unknown }).desktopAPI;
  configStore.getState().setCollabSpaceHost("");
  vi.restoreAllMocks();
});

/** Capture what the component hands to the OS. jsdom cannot follow a custom
 *  scheme, and the outcome is not observable from script in a real browser
 *  either — the href is the whole contract. */
function captureOSHandoff(): { hrefs: string[] } {
  const hrefs: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
    function (this: HTMLAnchorElement) {
      hrefs.push(this.getAttribute("href") ?? "");
    },
  );
  return { hrefs };
}

describe("LocalPathLink in a browser", () => {
  // A page served over http(s) may not navigate to file://, in any browser.
  // The clipboard is the entire available action, so the click has to perform
  // it rather than attempt something that silently fails.
  it("copies the path and names where to paste it", async () => {
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(mocks.copyText).toHaveBeenCalledWith(PATH);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Path copied — press ⇧⌘G in Finder and paste it",
    );
  });

  it("names File Explorer for a Windows reader", async () => {
    setUserAgent(WINDOWS_UA);
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Path copied — paste it into the File Explorer address bar",
    );
  });

  // copyText returns false in an insecure context instead of throwing, so
  // claiming success is the failure mode to guard against.
  it("reports a failed copy instead of claiming success", async () => {
    mocks.copyText.mockResolvedValue(false);
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't copy the path");
  });
});

describe("LocalPathLink in a browser with shared storage configured", () => {
  const HOST = "10.0.0.50";
  const EXPECTED_SHELL_URL = `bayclaw-open://open?path=${encodeURIComponent(PATH)}`;
  const EXPECTED_UNC =
    "\\\\10.0.0.50\\人机协作空间\\AI医药联合创新平台\\01高质量数据集";

  beforeEach(() => {
    configStore.getState().setCollabSpaceHost(HOST);
    // Every path here waits on the handoff timer, so the clock has to be ours.
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (document as unknown as { visibilityState?: unknown })
      .visibilityState;
  });

  /** Click without waiting on userEvent's own delays: against a faked clock it
   *  cannot advance them, and everything the component does happens after the
   *  handler returns anyway. */
  function clickPath(path: string) {
    fireEvent.click(screen.getByRole("button", { name: path }));
  }

  // The point of the whole handoff: a browser cannot open a local directory,
  // and no smb:// route knows whether the reader's shell is installed. A custom
  // scheme the local shell registered is the one address that opens the folder
  // natively — with a blur as the only proof it was taken.
  it("fires the desktop shell URL and treats blur as the shell taking over", async () => {
    const { hrefs } = captureOSHandoff();
    renderWithI18n(<LocalPathLink path={PATH} />);

    clickPath(PATH);
    expect(hrefs).toEqual([EXPECTED_SHELL_URL]);

    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.copyText).toHaveBeenCalledWith(PATH);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Opening in BayClaw Desktop Shell...",
    );

    // The timer must have been cleaned up with the listeners; otherwise a stale
    // install-guidance toast would land on top of an opened window.
    await vi.advanceTimersByTimeAsync(DESKTOP_SHELL_HANDOFF_TIMEOUT_MS + 100);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  // Some shells come forward without blurring the page; a hidden document is
  // the same signal.
  it("treats a hidden document as the shell taking over", async () => {
    const { hrefs } = captureOSHandoff();
    renderWithI18n(<LocalPathLink path={PATH} />);

    clickPath(PATH);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);

    expect(hrefs).toEqual([EXPECTED_SHELL_URL]);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Opening in BayClaw Desktop Shell...",
    );
    await vi.advanceTimersByTimeAsync(DESKTOP_SHELL_HANDOFF_TIMEOUT_MS + 100);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  // A `visibilitychange` that leaves the page visible must not settle the
  // attempt — that would swallow the install guidance on a tab switch.
  it("ignores a visibility change that keeps the page visible", async () => {
    captureOSHandoff();
    renderWithI18n(<LocalPathLink path={PATH} />);

    clickPath(PATH);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DESKTOP_SHELL_HANDOFF_TIMEOUT_MS);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  // Unregistered schemes are declined silently — the OS never reports back. So
  // a wait that expires is the only evidence the shell is missing, and the
  // reader still needs a working address on the clipboard.
  it("copies the POSIX path with install guidance when macOS has no shell", async () => {
    const { hrefs } = captureOSHandoff();
    renderWithI18n(<LocalPathLink path={PATH} />);

    clickPath(PATH);
    expect(hrefs).toEqual([EXPECTED_SHELL_URL]);
    expect(mocks.copyText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DESKTOP_SHELL_HANDOFF_TIMEOUT_MS);

    expect(mocks.copyText).toHaveBeenCalledWith(PATH);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Path copied — press ⇧⌘G in Finder to paste, or install BayClaw Desktop Shell for one-click opening",
    );
  });

  // Windows has no Finder, and a POSIX path pasted there resolves against the
  // current drive. The UNC form is the one its file manager accepts.
  it("copies the UNC path with install guidance when Windows has no shell", async () => {
    setUserAgent(WINDOWS_UA);
    const { hrefs } = captureOSHandoff();
    renderWithI18n(<LocalPathLink path={PATH} />);

    clickPath(PATH);
    expect(hrefs).toEqual([EXPECTED_SHELL_URL]);

    await vi.advanceTimersByTimeAsync(DESKTOP_SHELL_HANDOFF_TIMEOUT_MS);

    expect(mocks.copyText).toHaveBeenCalledWith(EXPECTED_UNC);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Network path copied — paste it into File Explorer, or install BayClaw Desktop Shell for one-click opening",
    );
  });

  it("reports a failed copy instead of promising an install-less fallback", async () => {
    mocks.copyText.mockResolvedValue(false);
    captureOSHandoff();
    renderWithI18n(<LocalPathLink path={PATH} />);

    clickPath(PATH);
    await vi.advanceTimersByTimeAsync(DESKTOP_SHELL_HANDOFF_TIMEOUT_MS);

    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't copy the path");
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  // A double click must not stack listeners or leave a timer behind: the second
  // attempt supersedes the first, and exactly one fallback runs.
  it("keeps a single handoff in flight across rapid clicks", async () => {
    const { hrefs } = captureOSHandoff();
    renderWithI18n(<LocalPathLink path={PATH} />);

    clickPath(PATH);
    clickPath(PATH);

    await vi.advanceTimersByTimeAsync(DESKTOP_SHELL_HANDOFF_TIMEOUT_MS);

    expect(hrefs).toEqual([EXPECTED_SHELL_URL, EXPECTED_SHELL_URL]);
    expect(mocks.copyText).toHaveBeenCalledTimes(1);
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  // A Linux mount point is named by whoever wrote the fstab entry, so the
  // share cannot be derived. Guessing would hand the shell a path it has no
  // reason to trust, and produce an address that fails undiagnosably.
  it("falls back to the clipboard when the share cannot be identified", async () => {
    const { hrefs } = captureOSHandoff();
    renderWithI18n(<LocalPathLink path="/mnt/share/项目" />);

    clickPath("/mnt/share/项目");
    await vi.advanceTimersByTimeAsync(DESKTOP_SHELL_HANDOFF_TIMEOUT_MS);

    expect(hrefs).toEqual([]);
    expect(mocks.copyText).toHaveBeenCalledWith("/mnt/share/项目");
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Path copied — press ⇧⌘G in Finder and paste it",
    );
  });

  // SECURITY. A UNC path names its own server, and content authors write these.
  // Launching a scheme that makes the shell authenticate against an arbitrary
  // host is exactly the one-click credential prompt the whitelist exists to
  // prevent, so the handoff is never attempted.
  it("never hands an untrusted UNC host to the shell", async () => {
    const { hrefs } = captureOSHandoff();
    renderWithI18n(<LocalPathLink path={UNTRUSTED_UNC} />);

    clickPath(UNTRUSTED_UNC);
    await vi.advanceTimersByTimeAsync(DESKTOP_SHELL_HANDOFF_TIMEOUT_MS);

    expect(hrefs).toEqual([]);
    expect(mocks.copyText).toHaveBeenCalledWith(UNTRUSTED_UNC);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Path copied — press ⇧⌘G in Finder and paste it",
    );
  });

  // The desktop bridge opens the real local mount; routing it through the file
  // server instead would be a slower path to the same folder, and would fail
  // on a machine that reaches the mount but not the server.
  it("prefers the desktop bridge over the protocol handoff", async () => {
    const openLocalPath = vi.fn().mockResolvedValue({ ok: true, action: "opened" });
    installDesktopBridge(openLocalPath);
    const { hrefs } = captureOSHandoff();
    renderWithI18n(<LocalPathLink path={PATH} />);

    clickPath(PATH);
    await vi.advanceTimersByTimeAsync(DESKTOP_SHELL_HANDOFF_TIMEOUT_MS);

    expect(openLocalPath).toHaveBeenCalledWith(PATH);
    expect(hrefs).toEqual([]);
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.copyText).not.toHaveBeenCalled();
  });
});

describe("LocalPathLink in the desktop shell", () => {
  it("opens the directory instead of copying it", async () => {
    const openLocalPath = vi.fn().mockResolvedValue({ ok: true, action: "opened" });
    installDesktopBridge(openLocalPath);
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(openLocalPath).toHaveBeenCalledWith(PATH);
    expect(mocks.copyText).not.toHaveBeenCalled();
    // A file-manager window is on screen; a toast would be noise on top of it.
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  // The path is correct on the machine that wrote it — this one has not
  // mounted the share. Saying "not found" alone would read as a typo.
  it("blames the unmounted volume and leaves the path on the clipboard", async () => {
    const openLocalPath = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "not_found" });
    installDesktopBridge(openLocalPath);
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(mocks.copyText).toHaveBeenCalledWith(PATH);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "This machine can't reach that path. The shared volume is probably not mounted — the path is on your clipboard.",
    );
  });

  // The shell refuses a host its own whitelist does not know. That is a
  // security decision, not a transient failure, and the wording has to say so
  // while leaving the path actionable.
  it("reports a blocked file server host and leaves the path on the clipboard", async () => {
    const openLocalPath = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "untrusted_host" });
    installDesktopBridge(openLocalPath);
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={UNTRUSTED_UNC} />);

    await user.click(screen.getByRole("button", { name: UNTRUSTED_UNC }));

    expect(mocks.copyText).toHaveBeenCalledWith(UNTRUSTED_UNC);
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Blocked opening an untrusted file server host — the path is on your clipboard",
    );
  });

  // A desktop build older than this feature runs the same renderer but has no
  // such channel in its preload, so it must take the browser fallback rather
  // than invoke something main never registered.
  it("falls back to copying when the shell predates the bridge", async () => {
    (window as unknown as { desktopAPI?: unknown }).desktopAPI = {};
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(mocks.copyText).toHaveBeenCalledWith(PATH);
    expect(mocks.toastSuccess).toHaveBeenCalled();
  });

  it("reports a path the shell rejected outright without claiming it opened", async () => {
    const openLocalPath = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "error", error: "EPERM" });
    installDesktopBridge(openLocalPath);
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't open that path");
    expect(mocks.copyText).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  // An IPC call from a page the shell does not trust is refused by design; the
  // reader gets the same dead-end wording as any other rejection.
  it("reports an untrusted origin as a failure", async () => {
    const openLocalPath = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: "untrusted_origin" });
    installDesktopBridge(openLocalPath);
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't open that path");
    expect(mocks.copyText).not.toHaveBeenCalled();
  });
});

describe("LocalPathLink rendering", () => {
  // The markdown label may be shorter than the path it links; the action still
  // has to use the full value.
  it("acts on the path even when it renders a different label", async () => {
    const openLocalPath = vi.fn().mockResolvedValue({ ok: true, action: "opened" });
    installDesktopBridge(openLocalPath);
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH}>报告目录</LocalPathLink>);

    await user.click(screen.getByRole("button", { name: "报告目录" }));

    expect(openLocalPath).toHaveBeenCalledWith(PATH);
  });

  // Truncation is visual, so the tooltip is the only place a clipped path stays
  // readable — the property sidebar depends on it.
  it("puts the whole path in the tooltip when it is truncated", () => {
    renderWithI18n(<LocalPathLink path={PATH} wrap="truncate" />);

    expect(screen.getByRole("button", { name: PATH })).toHaveAttribute(
      "title",
      PATH,
    );
  });

  it("names the copy action in the tooltip when no shell or share can open it", () => {
    renderWithI18n(<LocalPathLink path={PATH} />);

    expect(screen.getByRole("button", { name: PATH })).toHaveAttribute(
      "title",
      "Copy this path",
    );
  });

  // A share address is a real action even in a plain browser: the shell opens
  // it, or the click ends with the path copied and install guidance. Calling
  // that "copy this path" would undersell the click.
  it("names the open action in the tooltip when a share address exists", () => {
    configStore.getState().setCollabSpaceHost("10.0.0.50");
    renderWithI18n(<LocalPathLink path={PATH} />);

    expect(screen.getByRole("button", { name: PATH })).toHaveAttribute(
      "title",
      "Open in the file manager",
    );
  });

  // Segments are frequently Chinese, and the bidi algorithm reorders the
  // separators around a CJK run without an explicit direction — producing a
  // path that reads correctly character by character but names another
  // directory.
  it("forces the path into a single left-to-right run", () => {
    renderWithI18n(<LocalPathLink path={PATH} />);

    expect(screen.getByRole("button", { name: PATH })).toHaveAttribute("dir", "ltr");
  });
});
