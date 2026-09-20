import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configStore } from "@multica/core/config";
import { renderWithI18n } from "../test/i18n";
import { LocalPathLink } from "./local-path-link";

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
  const EXPECTED_SMB = `smb://${HOST}/${encodeURIComponent("人机协作空间")}/${encodeURIComponent("AI医药联合创新平台")}/${encodeURIComponent("01高质量数据集")}`;

  beforeEach(() => {
    configStore.getState().setCollabSpaceHost(HOST);
  });

  // The point of the whole smb:// route: a browser cannot open a local
  // directory, but it can hand the OS a URL naming the same directory on the
  // file server it actually lives on, and macOS routes that to Finder.
  it("hands macOS an smb:// URL for the same directory", async () => {
    const { hrefs } = captureOSHandoff();
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(hrefs).toEqual([EXPECTED_SMB]);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Opening in Finder — the path is on your clipboard too, in case it doesn't",
    );
  });

  // Whether the OS took the URL is not observable, so a click that opened
  // nothing must still leave the reader something to act on.
  it("still puts the path on the clipboard as a safety net", async () => {
    captureOSHandoff();
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(mocks.copyText).toHaveBeenCalledWith(PATH);
  });

  // Windows registers no smb: handler, so the clipboard is the end of the
  // line — but the copied value now works when pasted, which the POSIX path
  // from somebody else's Mac never did.
  it("copies the UNC form for a Windows reader, not the stored path", async () => {
    setUserAgent(WINDOWS_UA);
    const { hrefs } = captureOSHandoff();
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(mocks.copyText).toHaveBeenCalledWith(
      "\\\\10.0.0.50\\人机协作空间\\AI医药联合创新平台\\01高质量数据集",
    );
    expect(hrefs).toEqual([]);
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Network path copied — paste it into the File Explorer address bar",
    );
  });

  // A Linux mount point is named by whoever wrote the fstab entry, so the
  // share cannot be derived. Guessing would produce an address that fails in
  // a way the reader cannot diagnose.
  it("falls back to the clipboard when the share cannot be identified", async () => {
    const { hrefs } = captureOSHandoff();
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path="/mnt/share/项目" />);

    await user.click(screen.getByRole("button", { name: "/mnt/share/项目" }));

    expect(hrefs).toEqual([]);
    expect(mocks.copyText).toHaveBeenCalledWith("/mnt/share/项目");
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Path copied — press ⇧⌘G in Finder and paste it",
    );
  });

  // The desktop bridge opens the real local mount; routing it through the file
  // server instead would be a slower path to the same folder, and would fail
  // on a machine that reaches the mount but not the server.
  it("prefers the desktop bridge over the smb:// route", async () => {
    const openLocalPath = vi.fn().mockResolvedValue({ ok: true, action: "opened" });
    installDesktopBridge(openLocalPath);
    const { hrefs } = captureOSHandoff();
    const user = userEvent.setup();
    renderWithI18n(<LocalPathLink path={PATH} />);

    await user.click(screen.getByRole("button", { name: PATH }));

    expect(openLocalPath).toHaveBeenCalledWith(PATH);
    expect(hrefs).toEqual([]);
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

  it("names the action in the tooltip when the path is fully visible", () => {
    renderWithI18n(<LocalPathLink path={PATH} />);

    expect(screen.getByRole("button", { name: PATH })).toHaveAttribute(
      "title",
      "Copy this path",
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
