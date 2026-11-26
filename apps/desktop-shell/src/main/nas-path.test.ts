// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { NasPathDeps } from "./nas-path";
import {
  buildRootSmbUrl,
  findRootShareMount,
  isBlockedTargetName,
  openNasPathSafely,
  parseSmbMounts,
} from "./nas-path";

const TRUSTED_HOST = "192.0.2.10";
const NAS_HOST = "nas.example.internal";

const ROOT_MOUNT_LIST = [
  "//user@192.0.2.10/Team%20Space on /Volumes/Team Space-1 (smbfs, nodev, nosuid, noowners, mounted by demo)",
  "//user@192.0.2.10/Share on /Volumes/Share (smbfs, nodev, nosuid, noowners)",
  "/dev/disk3s1 on / (apfs, sealed, local, read-only, journaled)",
].join("\n");

const LEAF_SUBMOUNT_LIST =
  "//user@192.0.2.10/Share/DeepSub on /Volumes/DeepSub (smbfs, nodev, nosuid, noowners)";

function makeDeps(overrides: Partial<NasPathDeps> = {}): NasPathDeps {
  return {
    platform: "darwin",
    listMounts: async () => "",
    mountSmbRoot: async () => undefined,
    realpath: async (targetPath) => targetPath,
    stat: async () => ({ isDirectory: () => true }),
    openPath: async () => "",
    showItemInFolder: () => undefined,
    sleep: async () => undefined,
    mountRetryCount: 3,
    mountRetryDelayMs: 0,
    ...overrides,
  };
}

function fileStat(): { isDirectory(): boolean } {
  return { isDirectory: () => false };
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe("openNasPathSafely input validation", () => {
  const deps = makeDeps();

  it("rejects non-strings, empty values, and whitespace", async () => {
    for (const value of [42, null, undefined, {}, [], "", "   "]) {
      await expect(
        openNasPathSafely(value, { source: "ipc", trustedHost: TRUSTED_HOST }, deps),
      ).resolves.toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("rejects paths longer than 1024 UTF-8 bytes", async () => {
    const tooLong = `/${"a".repeat(1024)}`;
    await expect(
      openNasPathSafely(tooLong, { source: "ipc", trustedHost: TRUSTED_HOST }, deps),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects control characters", async () => {
    await expect(
      openNasPathSafely(
        "/Volumes/Share/\u0000secret",
        { source: "ipc", trustedHost: TRUSTED_HOST },
        deps,
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects relative paths", async () => {
    for (const value of ["Volumes/Share", "docs/report", "./report"]) {
      await expect(
        openNasPathSafely(value, { source: "ipc", trustedHost: TRUSTED_HOST }, deps),
      ).resolves.toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("rejects parent traversal segments", async () => {
    await expect(
      openNasPathSafely(
        "/Volumes/Share/../Secret",
        { source: "ipc", trustedHost: TRUSTED_HOST },
        deps,
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(
      openNasPathSafely(
        "C:\\Users\\..\\Windows",
        { source: "ipc", trustedHost: TRUSTED_HOST },
        makeDeps({ platform: "win32" }),
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses arbitrary local paths from an external deep link", async () => {
    for (const value of ["/etc/passwd", "C:\\Windows", "/Users/demo/project"]) {
      await expect(
        openNasPathSafely(
          value,
          { source: "protocol", trustedHost: TRUSTED_HOST },
          makeDeps({ platform: "win32" }),
        ),
      ).resolves.toEqual({ ok: false, reason: "invalid" });
    }
    await expect(
      openNasPathSafely(
        "/etc/passwd",
        { source: "protocol", trustedHost: TRUSTED_HOST },
        makeDeps(),
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("reports unsupported on other platforms", async () => {
    await expect(
      openNasPathSafely(
        "/Volumes/Share",
        { source: "ipc", trustedHost: TRUSTED_HOST },
        makeDeps({ platform: "linux" }),
      ),
    ).resolves.toEqual({ ok: false, reason: "unsupported" });
  });
});

describe("openNasPathSafely host whitelist lock", () => {
  it("rejects an untrusted UNC host without touching the system", async () => {
    const listMounts = vi.fn(async () => ROOT_MOUNT_LIST);
    const realpath = vi.fn(async (value: string) => value);
    const openPath = vi.fn(async () => "");
    const mountSmbRoot = vi.fn(async () => undefined);

    const result = await openNasPathSafely(
      "\\\\evil.example.com\\Share\\Docs",
      { source: "ipc", trustedHost: TRUSTED_HOST },
      makeDeps({ listMounts, realpath, openPath, mountSmbRoot }),
    );

    expect(result).toEqual({ ok: false, reason: "untrusted_host" });
    expect(listMounts).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
    expect(mountSmbRoot).not.toHaveBeenCalled();
  });

  it("rejects a deep link to /Volumes when no NAS host is configured", async () => {
    const realpath = vi.fn(async (value: string) => value);
    await expect(
      openNasPathSafely(
        "/Volumes/Share/Docs",
        { source: "protocol", trustedHost: "" },
        makeDeps({ realpath }),
      ),
    ).resolves.toEqual({ ok: false, reason: "untrusted_host" });
    expect(realpath).not.toHaveBeenCalled();
  });

  it("rejects /Volumes on Windows when no NAS host is configured", async () => {
    const realpath = vi.fn(async (value: string) => value);
    await expect(
      openNasPathSafely(
        "/Volumes/Share/Docs",
        { source: "ipc", trustedHost: "" },
        makeDeps({ platform: "win32", realpath }),
      ),
    ).resolves.toEqual({ ok: false, reason: "untrusted_host" });
    expect(realpath).not.toHaveBeenCalled();
  });

  it("rejects a UNC path to another host even with a trusted host configured", async () => {
    await expect(
      openNasPathSafely(
        "\\\\other.example.com\\Share",
        { source: "ipc", trustedHost: NAS_HOST },
        makeDeps(),
      ),
    ).resolves.toEqual({ ok: false, reason: "untrusted_host" });
  });

  it("matches the trusted host case-insensitively", async () => {
    const openPath = vi.fn(async () => "");
    const result = await openNasPathSafely(
      "\\\\192.0.2.10\\Share\\Docs",
      { source: "ipc", trustedHost: "192.0.2.10" },
      makeDeps({ listMounts: async () => ROOT_MOUNT_LIST, openPath }),
    );
    expect(result).toEqual({ ok: true, action: "opened" });
    expect(openPath).toHaveBeenCalledWith("/Volumes/Share/Docs");
  });
});

describe("macOS root-share mounts", () => {
  it("opens under an existing suffixed mount point without mounting again", async () => {
    const openPath = vi.fn(async () => "");
    const mountSmbRoot = vi.fn(async () => undefined);

    const result = await openNasPathSafely(
      "/Volumes/Team Space/Sub/Docs",
      { source: "ipc", trustedHost: TRUSTED_HOST },
      makeDeps({ listMounts: async () => ROOT_MOUNT_LIST, openPath, mountSmbRoot }),
    );

    expect(result).toEqual({ ok: true, action: "opened" });
    expect(openPath).toHaveBeenCalledWith("/Volumes/Team Space-1/Sub/Docs");
    expect(mountSmbRoot).not.toHaveBeenCalled();
  });

  it("handles a CJK share name with encoded mount output", async () => {
    const mountList =
      "//user@nas.example.internal/%E5%9B%A2%E9%98%9F%20%E7%A9%BA%E9%97%B4 on /Volumes/团队 空间-1 (smbfs, nodev)";
    const openPath = vi.fn(async () => "");

    const result = await openNasPathSafely(
      "/Volumes/团队 空间/子目录",
      { source: "ipc", trustedHost: NAS_HOST },
      makeDeps({ listMounts: async () => mountList, openPath }),
    );

    expect(result).toEqual({ ok: true, action: "opened" });
    expect(openPath).toHaveBeenCalledWith("/Volumes/团队 空间-1/子目录");
  });

  it("ignores a leaf submount, mounts the root share only, then re-scans", async () => {
    const mountUrls: string[] = [];
    const openPath = vi.fn(async () => "");
    let listCalls = 0;

    const result = await openNasPathSafely(
      "/Volumes/Share/DeepSub",
      { source: "ipc", trustedHost: TRUSTED_HOST },
      makeDeps({
        listMounts: async () => {
          listCalls += 1;
          return listCalls === 1
            ? LEAF_SUBMOUNT_LIST
            : "//user@192.0.2.10/Share on /Volumes/Share (smbfs, nodev)";
        },
        mountSmbRoot: async (url) => {
          mountUrls.push(url);
        },
        openPath,
      }),
    );

    expect(result).toEqual({ ok: true, action: "opened" });
    expect(mountUrls).toEqual(["smb://192.0.2.10/Share"]);
    expect(mountUrls[0]).not.toContain("DeepSub");
    expect(openPath).toHaveBeenCalledWith("/Volumes/Share/DeepSub");
    expect(listCalls).toBe(2);
  });

  it("converts a UNC path on a trusted host into a root-share open", async () => {
    const openPath = vi.fn(async () => "");
    const result = await openNasPathSafely(
      "\\\\192.0.2.10\\Share\\Sub",
      { source: "ipc", trustedHost: TRUSTED_HOST },
      makeDeps({ listMounts: async () => ROOT_MOUNT_LIST, openPath }),
    );

    expect(result).toEqual({ ok: true, action: "opened" });
    expect(openPath).toHaveBeenCalledWith("/Volumes/Share/Sub");
  });

  it("reveals instead of opening a symlink that resolves into an app bundle", async () => {
    const openPath = vi.fn(async () => "");
    const showItemInFolder = vi.fn();

    const result = await openNasPathSafely(
      "/Volumes/Share/MyAlias",
      { source: "ipc", trustedHost: TRUSTED_HOST },
      makeDeps({
        listMounts: async () => ROOT_MOUNT_LIST,
        realpath: async () => "/Applications/Tool.app",
        openPath,
        showItemInFolder,
      }),
    );

    expect(result).toEqual({ ok: true, action: "revealed" });
    expect(showItemInFolder).toHaveBeenCalledWith("/Volumes/Share/MyAlias");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("reveals instead of opening an app bundle clicked directly", async () => {
    const openPath = vi.fn(async () => "");
    const showItemInFolder = vi.fn();

    const result = await openNasPathSafely(
      "/Volumes/Share/Tool.app",
      { source: "ipc", trustedHost: TRUSTED_HOST },
      makeDeps({ listMounts: async () => ROOT_MOUNT_LIST, openPath, showItemInFolder }),
    );

    expect(result).toEqual({ ok: true, action: "revealed" });
    expect(showItemInFolder).toHaveBeenCalledWith("/Volumes/Share/Tool.app");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("reveals a plain file instead of opening it", async () => {
    const openPath = vi.fn(async () => "");
    const showItemInFolder = vi.fn();

    const result = await openNasPathSafely(
      "/Volumes/Share/notes.txt",
      { source: "ipc", trustedHost: TRUSTED_HOST },
      makeDeps({
        listMounts: async () => ROOT_MOUNT_LIST,
        stat: async () => fileStat(),
        openPath,
        showItemInFolder,
      }),
    );

    expect(result).toEqual({ ok: true, action: "revealed" });
    expect(showItemInFolder).toHaveBeenCalledWith("/Volumes/Share/notes.txt");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("maps ENOENT to not_found", async () => {
    await expect(
      openNasPathSafely(
        "/Volumes/Share/Missing",
        { source: "ipc", trustedHost: TRUSTED_HOST },
        makeDeps({
          listMounts: async () => ROOT_MOUNT_LIST,
          realpath: async () => {
            throw errnoError("ENOENT");
          },
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("maps ENOTDIR to not_found", async () => {
    await expect(
      openNasPathSafely(
        "/Volumes/Share/File/Deeper",
        { source: "ipc", trustedHost: TRUSTED_HOST },
        makeDeps({
          listMounts: async () => ROOT_MOUNT_LIST,
          realpath: async () => {
            throw errnoError("ENOTDIR");
          },
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("maps other filesystem failures to error", async () => {
    await expect(
      openNasPathSafely(
        "/Volumes/Share/Docs",
        { source: "ipc", trustedHost: TRUSTED_HOST },
        makeDeps({
          listMounts: async () => ROOT_MOUNT_LIST,
          realpath: async () => {
            throw errnoError("EACCES");
          },
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "error", error: "EACCES" });
  });

  it("retries the mount scan with backoff before giving up", async () => {
    const sleep = vi.fn(async () => undefined);
    const mountSmbRoot = vi.fn(async () => undefined);
    let listCalls = 0;

    const result = await openNasPathSafely(
      "/Volumes/Share/Docs",
      { source: "ipc", trustedHost: TRUSTED_HOST },
      makeDeps({
        mountRetryCount: 3,
        listMounts: async () => {
          listCalls += 1;
          return LEAF_SUBMOUNT_LIST;
        },
        mountSmbRoot,
        sleep,
        realpath: async () => {
          throw errnoError("ENOENT");
        },
      }),
    );

    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(mountSmbRoot).toHaveBeenCalledWith("smb://192.0.2.10/Share");
    expect(listCalls).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("reports a mount failure when no root mount appears", async () => {
    const result = await openNasPathSafely(
      "/Volumes/Share/Docs",
      { source: "ipc", trustedHost: TRUSTED_HOST },
      makeDeps({
        mountRetryCount: 2,
        listMounts: async () => "",
        mountSmbRoot: async () => {
          throw new Error("mount volume failed");
        },
      }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "error",
      error: "mount volume failed",
    });
  });

  it("falls back to a local volume when no host is configured", async () => {
    const openPath = vi.fn(async () => "");
    const mountSmbRoot = vi.fn(async () => undefined);

    const result = await openNasPathSafely(
      "/Volumes/External/Photos",
      { source: "ipc", trustedHost: "" },
      makeDeps({ openPath, mountSmbRoot }),
    );

    expect(result).toEqual({ ok: true, action: "opened" });
    expect(openPath).toHaveBeenCalledWith("/Volumes/External/Photos");
    expect(mountSmbRoot).not.toHaveBeenCalled();
  });

  it("opens a plain local directory for a trusted IPC caller", async () => {
    const openPath = vi.fn(async () => "");
    const result = await openNasPathSafely(
      "/Users/demo/project",
      { source: "ipc", trustedHost: "" },
      makeDeps({ openPath }),
    );

    expect(result).toEqual({ ok: true, action: "opened" });
    expect(openPath).toHaveBeenCalledWith("/Users/demo/project");
  });

  it("reports a failed openPath result", async () => {
    await expect(
      openNasPathSafely(
        "/Volumes/Share/Docs",
        { source: "ipc", trustedHost: TRUSTED_HOST },
        makeDeps({
          listMounts: async () => ROOT_MOUNT_LIST,
          openPath: async () => "no application can open this",
        }),
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      error: "no application can open this",
    });
  });
});

describe("Windows behavior", () => {
  const winDeps = (overrides: Partial<NasPathDeps> = {}): NasPathDeps =>
    makeDeps({ platform: "win32", ...overrides });

  it("converts /Volumes/<share>/<sub> to a trusted UNC path and opens it", async () => {
    const openPath = vi.fn(async () => "");
    const result = await openNasPathSafely(
      "/Volumes/Share/Sub/子目录",
      { source: "ipc", trustedHost: NAS_HOST },
      winDeps({ openPath }),
    );

    expect(result).toEqual({ ok: true, action: "opened" });
    expect(openPath).toHaveBeenCalledWith(
      "\\\\nas.example.internal\\Share\\Sub\\子目录",
    );
  });

  it("opens a whitelisted UNC path", async () => {
    const openPath = vi.fn(async () => "");
    const result = await openNasPathSafely(
      "\\\\nas.example.internal\\Share\\Sub",
      { source: "ipc", trustedHost: NAS_HOST },
      winDeps({ openPath }),
    );

    expect(result).toEqual({ ok: true, action: "opened" });
    expect(openPath).toHaveBeenCalledWith("\\\\nas.example.internal\\Share\\Sub");
  });

  it("normalizes forward slashes in a UNC path", async () => {
    const openPath = vi.fn(async () => "");
    const result = await openNasPathSafely(
      "\\\\nas.example.internal/Share/Sub",
      { source: "ipc", trustedHost: NAS_HOST },
      winDeps({ openPath }),
    );

    expect(result).toEqual({ ok: true, action: "opened" });
    expect(openPath).toHaveBeenCalledWith("\\\\nas.example.internal\\Share\\Sub");
  });

  it("reveals executables and shortcuts instead of running them", async () => {
    for (const extension of [".exe", ".bat", ".cmd", ".ps1", ".lnk", ".url", ".msi", ".vbs"]) {
      const openPath = vi.fn(async () => "");
      const showItemInFolder = vi.fn();
      const filePath = `\\\\nas.example.internal\\Share\\tool${extension}`;

      const result = await openNasPathSafely(
        filePath,
        { source: "ipc", trustedHost: NAS_HOST },
        winDeps({ stat: async () => fileStat(), openPath, showItemInFolder }),
      );

      expect(result, extension).toEqual({ ok: true, action: "revealed" });
      expect(showItemInFolder, extension).toHaveBeenCalledWith(filePath);
      expect(openPath, extension).not.toHaveBeenCalled();
    }
  });

  it("reveals a directory whose name ends in an executable extension", async () => {
    const openPath = vi.fn(async () => "");
    const showItemInFolder = vi.fn();

    const result = await openNasPathSafely(
      "/Volumes/Share/Installer.msi",
      { source: "ipc", trustedHost: NAS_HOST },
      winDeps({ openPath, showItemInFolder }),
    );

    expect(result).toEqual({ ok: true, action: "revealed" });
    expect(openPath).not.toHaveBeenCalled();
  });

  it("allows an IPC local drive path", async () => {
    const openPath = vi.fn(async () => "");
    const result = await openNasPathSafely(
      "C:\\Users\\demo\\docs",
      { source: "ipc", trustedHost: "" },
      winDeps({ openPath }),
    );

    expect(result).toEqual({ ok: true, action: "opened" });
    expect(openPath).toHaveBeenCalledWith("C:\\Users\\demo\\docs");
  });

  it("normalizes forward slashes in an IPC drive path", async () => {
    const openPath = vi.fn(async () => "");
    const result = await openNasPathSafely(
      "C:/Users/demo/docs",
      { source: "ipc", trustedHost: "" },
      winDeps({ openPath }),
    );

    expect(result).toEqual({ ok: true, action: "opened" });
    expect(openPath).toHaveBeenCalledWith("C:\\Users\\demo\\docs");
  });

  it("refuses a drive path from an external deep link", async () => {
    const realpath = vi.fn(async (value: string) => value);
    await expect(
      openNasPathSafely(
        "C:\\Windows",
        { source: "protocol", trustedHost: NAS_HOST },
        winDeps({ realpath }),
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(realpath).not.toHaveBeenCalled();
  });

  it("refuses a POSIX path on Windows", async () => {
    await expect(
      openNasPathSafely(
        "/tmp/anything",
        { source: "ipc", trustedHost: NAS_HOST },
        winDeps(),
      ),
    ).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("maps ENOENT to not_found on Windows too", async () => {
    await expect(
      openNasPathSafely(
        "\\\\nas.example.internal\\Share\\Missing",
        { source: "ipc", trustedHost: NAS_HOST },
        winDeps({
          realpath: async () => {
            throw errnoError("ENOENT");
          },
        }),
      ),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
  });
});

describe("parseSmbMounts", () => {
  it("parses an authenticated mount with an encoded space", () => {
    const entries = parseSmbMounts(
      "//user@192.0.2.10/Team%20Space on /Volumes/Team Space-1 (smbfs, nodev, nosuid, noowners)",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      host: "192.0.2.10",
      user: "user",
      sharePath: "Team Space",
      mountPoint: "/Volumes/Team Space-1",
      fstype: "smbfs",
      isRootShare: true,
    });
  });

  it("parses an unauthenticated mount", () => {
    const entries = parseSmbMounts(
      "//192.0.2.10/Share on /Volumes/Share (smbfs, nodev)",
    );
    expect(entries[0]).toMatchObject({ host: "192.0.2.10", sharePath: "Share" });
    expect(entries[0]?.user).toBeUndefined();
  });

  it("parses an IPv6 host and a dotted user name", () => {
    const entries = parseSmbMounts(
      "//first.last@[2001:db8::10]/Share on /Volumes/Share (smbfs, nodev)",
    );
    expect(entries[0]).toMatchObject({
      host: "[2001:db8::10]",
      user: "first.last",
      sharePath: "Share",
    });
  });

  it("marks a leaf submount as not a root share", () => {
    const entries = parseSmbMounts(
      "//user@192.0.2.10/Share/DeepSub on /Volumes/DeepSub (smbfs, nodev)",
    );
    expect(entries[0]?.isRootShare).toBe(false);
    expect(entries[0]?.sharePath).toBe("Share/DeepSub");
  });

  it("ignores non-SMB lines, malformed lines, and missing shares", () => {
    const entries = parseSmbMounts(
      [
        "/dev/disk3s1 on / (apfs, sealed, local, read-only)",
        "//host-only-no-share on /Volumes/x (smbfs)",
        "garbage",
        "",
      ].join("\n"),
    );
    expect(entries).toEqual([]);
  });

  it("decodes octal-escaped mount points", () => {
    const entries = parseSmbMounts(
      "//user@192.0.2.10/Share on /Volumes/My\\040Share (smbfs, nodev)",
    );
    expect(entries[0]?.mountPoint).toBe("/Volumes/My Share");
  });

  it("tolerates malformed percent encoding in a share path", () => {
    const entries = parseSmbMounts(
      "//user@192.0.2.10/100% on /Volumes/100% (smbfs, nodev)",
    );
    expect(entries[0]?.sharePath).toBe("100%");
  });

  it("returns an empty array for non-string input", () => {
    expect(parseSmbMounts(undefined as unknown as string)).toEqual([]);
    expect(parseSmbMounts("")).toEqual([]);
  });
});

describe("findRootShareMount", () => {
  const mounts = parseSmbMounts(
    [
      "//user@192.0.2.10/Team%20Space on /Volumes/Team Space-1 (smbfs, nodev)",
      "//user@nas.example.internal/Shared on /Volumes/Shared (smbfs, nodev)",
      "//user@192.0.2.10/Shared/Deep on /Volumes/Deep (smbfs, nodev)",
    ].join("\n"),
  );

  it("matches the host and share case-insensitively", () => {
    expect(findRootShareMount(mounts, "192.0.2.10", "team space")?.mountPoint).toBe(
      "/Volumes/Team Space-1",
    );
    expect(findRootShareMount(mounts, "NAS.EXAMPLE.INTERNAL", "shared")?.mountPoint).toBe(
      "/Volumes/Shared",
    );
  });

  it("never matches a leaf submount of the right share", () => {
    expect(findRootShareMount(mounts, "192.0.2.10", "Deep")).toBeNull();
    expect(findRootShareMount(mounts, "192.0.2.10", "Shared")).toBeNull();
  });

  it("rejects a wrong host, a wrong share, or an empty host", () => {
    expect(findRootShareMount(mounts, "198.51.100.7", "Shared")).toBeNull();
    expect(findRootShareMount(mounts, "192.0.2.10", "Missing")).toBeNull();
    expect(findRootShareMount(mounts, "", "Shared")).toBeNull();
  });

  it("ignores non-smbfs entries", () => {
    const notSmb = [
      {
        source: "//host/Share",
        host: "host",
        sharePath: "Share",
        mountPoint: "/Volumes/Share",
        fstype: "afpfs",
        isRootShare: true,
      },
    ];
    expect(findRootShareMount(notSmb, "host", "Share")).toBeNull();
  });
});

describe("buildRootSmbUrl", () => {
  it("encodes the share and never appends a subpath", () => {
    expect(buildRootSmbUrl("192.0.2.10", "Team Space")).toBe(
      "smb://192.0.2.10/Team%20Space",
    );
    expect(buildRootSmbUrl("nas.example.internal", "Share")).toBe(
      "smb://nas.example.internal/Share",
    );
  });

  it("brackets an IPv6 literal", () => {
    expect(buildRootSmbUrl("2001:db8::10", "Share")).toBe(
      "smb://[2001:db8::10]/Share",
    );
    expect(buildRootSmbUrl("[2001:db8::10]", "Share")).toBe(
      "smb://[2001:db8::10]/Share",
    );
  });
});

describe("isBlockedTargetName", () => {
  it("blocks every macOS bundle extension", () => {
    for (const extension of [
      ".app",
      ".pkg",
      ".mpkg",
      ".bundle",
      ".plugin",
      ".kext",
      ".framework",
      ".prefpane",
      ".qlgenerator",
      ".saver",
      ".component",
      ".service",
      ".workflow",
      ".action",
      ".wdgt",
      ".scptd",
      ".appex",
    ]) {
      expect(isBlockedTargetName(`/Volumes/Share/Tool${extension}`), extension).toBe(
        true,
      );
      expect(isBlockedTargetName(`/Volumes/Share/Tool${extension}/`), extension).toBe(
        true,
      );
      expect(
        isBlockedTargetName(`\\\\nas.example.internal\\Share\\Tool${extension}`),
        extension,
      ).toBe(true);
    }
  });

  it("blocks every Windows executable and shortcut extension", () => {
    for (const extension of [
      ".exe",
      ".bat",
      ".cmd",
      ".com",
      ".ps1",
      ".vbs",
      ".vbe",
      ".js",
      ".jse",
      ".wsf",
      ".wsh",
      ".msi",
      ".msp",
      ".scr",
      ".pif",
      ".lnk",
      ".url",
      ".hta",
      ".reg",
      ".msc",
      ".cpl",
    ]) {
      expect(isBlockedTargetName(`C:\\Share\\tool${extension}`), extension).toBe(true);
    }
  });

  it("is case-insensitive and ignores trailing separators", () => {
    expect(isBlockedTargetName("/Volumes/Share/TOOL.APP")).toBe(true);
    expect(isBlockedTargetName("C:\\Share\\SETUP.EXE\\")).toBe(true);
  });

  it("does not block ordinary names or lookalike extensions", () => {
    expect(isBlockedTargetName("/Volumes/Share/reports")).toBe(false);
    expect(isBlockedTargetName("/Volumes/Share/notes.txt")).toBe(false);
    expect(isBlockedTargetName("/Volumes/Share/tool.appx")).toBe(false);
    expect(isBlockedTargetName("/Volumes/Share/.app")).toBe(false);
    expect(isBlockedTargetName("")).toBe(false);
  });
});
