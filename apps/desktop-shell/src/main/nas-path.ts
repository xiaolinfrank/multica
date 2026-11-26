import { execFile } from "node:child_process";
import { realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { posix as posixPath, win32 as win32Path } from "node:path";
import type { OpenLocalPathResult, OpenPathSource } from "../shared/types";

/** Matches the server's collab_path ceiling; a longer string is not a path a human typed. */
const MAX_PATH_BYTES = 1024;

const CONTROL_CHARACTERS = /\p{Cc}/u;

/** macOS packages: directories LaunchServices treats as a single openable item. */
const MAC_BUNDLE_EXTENSIONS = [
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
];

/** Windows executables and shortcuts: opening one runs or activates something. */
const WINDOWS_EXECUTABLE_EXTENSIONS = [
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
];

const BLOCKED_EXTENSIONS = new Set<string>([
  ...MAC_BUNDLE_EXTENSIONS,
  ...WINDOWS_EXECUTABLE_EXTENSIONS,
]);

export interface SmbMountEntry {
  /** Raw source field, e.g. `//user@192.0.2.10/Team%20Space`. */
  source: string;
  host: string;
  user?: string;
  /** Decoded share path without a leading slash, e.g. `Team Space` or `Share/Sub`. */
  sharePath: string;
  mountPoint: string;
  fstype: string;
  /** False for a leaf submount (`//host/share/sub`): such a mount is never reused. */
  isRootShare: boolean;
}

/** Everything the NAS opener touches, injectable so both OS branches are testable. */
export interface NasPathDeps {
  platform: NodeJS.Platform;
  listMounts: () => Promise<string>;
  mountSmbRoot: (smbUrl: string) => Promise<void>;
  realpath: (targetPath: string) => Promise<string>;
  stat: (targetPath: string) => Promise<{ isDirectory(): boolean }>;
  openPath: (targetPath: string) => Promise<string>;
  showItemInFolder: (targetPath: string) => void;
  sleep: (ms: number) => Promise<void>;
  mountRetryCount: number;
  mountRetryDelayMs: number;
}

export interface OpenNasPathOptions {
  /** Denormalized trusted NAS host; the only host a mount or UNC open may name. */
  trustedHost: string;
  /** `ipc` from the authenticated UI, `protocol` from an external deep link. */
  source: OpenPathSource;
}

type TargetKind = "volumes" | "unc" | "windows" | "posix";

interface ParsedTarget {
  kind: TargetKind;
  host?: string;
  share?: string;
  subSegments: string[];
  path: string;
}

const DEFAULT_MOUNT_RETRY_COUNT = 10;
const DEFAULT_MOUNT_RETRY_DELAY_MS = 250;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runFile(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function electronShell(): typeof import("electron").shell {
  // Required lazily: tests inject every dependency, so no test ever loads the
  // Electron package, and the module stays importable in a plain Node process.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require("electron") as typeof import("electron");
  return electron.shell;
}

function createDefaultDeps(): NasPathDeps {
  return {
    platform: process.platform,
    listMounts: () => runFile("/sbin/mount", []),
    mountSmbRoot: async (smbUrl) => {
      await runFile("/usr/bin/osascript", [
        "-e",
        "on run argv",
        "-e",
        "mount volume (item 1 of argv)",
        "-e",
        "end run",
        smbUrl,
      ]);
    },
    realpath: (targetPath) => fsRealpath(targetPath),
    stat: (targetPath) => fsStat(targetPath),
    openPath: (targetPath) => electronShell().openPath(targetPath),
    showItemInFolder: (targetPath) => {
      electronShell().showItemInFolder(targetPath);
    },
    sleep: defaultSleep,
    mountRetryCount: DEFAULT_MOUNT_RETRY_COUNT,
    mountRetryDelayMs: DEFAULT_MOUNT_RETRY_DELAY_MS,
  };
}

function unescapeMountField(value: string): string {
  return value
    .replace(/\\134/g, "\\")
    .replace(/\\040/g, " ")
    .replace(/\\011/g, "\t")
    .replace(/\\012/g, "\n");
}

function decodeSharePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Parses `/sbin/mount` output, keeping only `//` (SMB) source lines. */
export function parseSmbMounts(mountOutput: string): SmbMountEntry[] {
  if (typeof mountOutput !== "string" || !mountOutput) return [];

  const entries: SmbMountEntry[] = [];
  for (const rawLine of mountOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("//")) continue;

    const match = /^(\/\/\S+) on (.+) \(([^()]*)\)$/.exec(line);
    if (!match) continue;

    const source = match[1] ?? "";
    const mountPoint = unescapeMountField(match[2] ?? "");
    const fstype = (match[3] ?? "").split(",")[0]?.trim() ?? "";

    const withoutLeadingSlashes = source.slice(2);
    const slashIndex = withoutLeadingSlashes.indexOf("/");
    if (slashIndex <= 0) continue;

    const authority = withoutLeadingSlashes.slice(0, slashIndex);
    const encodedSharePath = withoutLeadingSlashes.slice(slashIndex + 1);
    if (!authority || !encodedSharePath) continue;

    const atIndex = authority.lastIndexOf("@");
    const user = atIndex > 0 ? authority.slice(0, atIndex) : undefined;
    const host = atIndex >= 0 ? authority.slice(atIndex + 1) : authority;
    if (!host) continue;

    const sharePath = decodeSharePath(
      unescapeMountField(encodedSharePath),
    ).replace(/\/+$/, "");

    entries.push({
      source,
      host,
      user,
      sharePath,
      mountPoint,
      fstype,
      isRootShare: sharePath.length > 0 && !sharePath.includes("/"),
    });
  }
  return entries;
}

function normalizeShareName(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/**
 * Finds an existing ROOT-share mount. Leaf submounts (`//host/share/sub`) are
 * ignored even when their mount point looks like the right share, because
 * opening through one leaves an orphaned mount behind.
 */
export function findRootShareMount(
  mounts: readonly SmbMountEntry[],
  trustedHost: string,
  shareName: string,
): SmbMountEntry | null {
  const host = trustedHost.trim().toLowerCase();
  const share = normalizeShareName(shareName);
  if (!host || !share) return null;

  for (const mount of mounts) {
    if (mount.fstype.toLowerCase() !== "smbfs") continue;
    if (!mount.isRootShare) continue;
    if (mount.host.toLowerCase() !== host) continue;
    if (normalizeShareName(mount.sharePath) !== share) continue;
    return mount;
  }
  return null;
}

/** Root-only SMB URL: a subpath would create a leaf submount. */
export function buildRootSmbUrl(host: string, shareName: string): string {
  const trimmedHost = host.trim();
  const authority =
    trimmedHost.includes(":") && !trimmedHost.startsWith("[")
      ? `[${trimmedHost}]`
      : trimmedHost;
  return `smb://${authority}/${encodeURIComponent(shareName)}`;
}

/** True when the final path segment is a macOS bundle or a Windows executable/shortcut. */
export function isBlockedTargetName(targetPath: string): boolean {
  if (typeof targetPath !== "string") return false;
  const trimmed = targetPath.trim().replace(/[\\/]+$/, "");
  const name = trimmed.split(/[\\/]+/).pop() ?? "";
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return false;
  return BLOCKED_EXTENSIONS.has(lower.slice(dot));
}

function parseAbsoluteTargetPath(targetPath: string): ParsedTarget | null {
  if (targetPath.startsWith("\\\\")) {
    const match = /^\\\\+([^\\/]+)[\\/]+(.*)$/.exec(targetPath);
    if (!match) return null;
    const host = match[1] ?? "";
    const segments = (match[2] ?? "").split(/[\\/]+/).filter(Boolean);
    const share = segments[0];
    if (!host || !share) return null;
    return {
      kind: "unc",
      host,
      share,
      subSegments: segments.slice(1),
      path: targetPath,
    };
  }

  if (/^[A-Za-z]:[\\/]/.test(targetPath)) {
    return { kind: "windows", subSegments: [], path: targetPath };
  }

  if (targetPath.startsWith("/")) {
    const segments = targetPath.split("/").filter(Boolean);
    if (segments[0] === "Volumes" && segments.length >= 2) {
      return {
        kind: "volumes",
        share: segments[1] ?? "",
        subSegments: segments.slice(2),
        path: targetPath,
      };
    }
    return { kind: "posix", subSegments: [], path: targetPath };
  }

  return null;
}

function validateInput(
  rawPath: unknown,
): { ok: true; target: ParsedTarget } | { ok: false; result: OpenLocalPathResult } {
  if (typeof rawPath !== "string") return { ok: false, result: { ok: false, reason: "invalid" } };
  const path = rawPath.trim();
  if (!path) return { ok: false, result: { ok: false, reason: "invalid" } };
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) {
    return { ok: false, result: { ok: false, reason: "invalid" } };
  }
  if (CONTROL_CHARACTERS.test(path)) {
    return { ok: false, result: { ok: false, reason: "invalid" } };
  }
  if (!path.startsWith("/") && !path.startsWith("\\\\") && !/^[A-Za-z]:[\\/]/.test(path)) {
    return { ok: false, result: { ok: false, reason: "invalid" } };
  }
  if (path.split(/[\\/]+/).includes("..")) {
    return { ok: false, result: { ok: false, reason: "invalid" } };
  }

  const target = parseAbsoluteTargetPath(path);
  if (!target) return { ok: false, result: { ok: false, reason: "invalid" } };
  return { ok: true, target };
}

async function safeListMounts(deps: NasPathDeps): Promise<string> {
  try {
    return await deps.listMounts();
  } catch {
    return "";
  }
}

async function waitForRootShareMount(
  deps: NasPathDeps,
  trustedHost: string,
  shareName: string,
): Promise<SmbMountEntry | null> {
  const attempts = Math.max(1, deps.mountRetryCount);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const mounts = parseSmbMounts(await safeListMounts(deps));
    const found = findRootShareMount(mounts, trustedHost, shareName);
    if (found) return found;
    if (attempt < attempts - 1) await deps.sleep(deps.mountRetryDelayMs);
  }
  return null;
}

async function finishOpen(
  targetPath: string,
  deps: NasPathDeps,
): Promise<OpenLocalPathResult> {
  let resolved: string;
  let stats: { isDirectory(): boolean };
  try {
    resolved = await deps.realpath(targetPath);
    stats = await deps.stat(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, reason: "not_found" };
    }
    return { ok: false, reason: "error", error: errorMessage(error) };
  }

  // Both names are tested: the resolved one catches a symlink into a bundle,
  // the clicked one catches a path whose own name ends in a bundle extension.
  const blocked =
    isBlockedTargetName(targetPath) || isBlockedTargetName(resolved);

  if (!stats.isDirectory() || blocked) {
    try {
      deps.showItemInFolder(targetPath);
      return { ok: true, action: "revealed" };
    } catch (error) {
      return { ok: false, reason: "error", error: errorMessage(error) };
    }
  }

  try {
    const error = await deps.openPath(resolved);
    if (!error) return { ok: true, action: "opened" };
    return { ok: false, reason: "error", error: error || "open_failed" };
  } catch (error) {
    return { ok: false, reason: "error", error: errorMessage(error) };
  }
}

async function openOnDarwin(
  target: ParsedTarget,
  trustedHost: string,
  deps: NasPathDeps,
): Promise<OpenLocalPathResult> {
  if (target.kind === "posix") return finishOpen(target.path, deps);
  if (target.kind === "windows") return { ok: false, reason: "invalid" };

  const share = target.share ?? "";
  const subSegments = target.subSegments;

  const existingRoot = findRootShareMount(
    parseSmbMounts(await safeListMounts(deps)),
    trustedHost,
    share,
  );
  if (existingRoot) {
    return finishOpen(posixPath.join(existingRoot.mountPoint, ...subSegments), deps);
  }

  if (trustedHost) {
    let mountError: unknown = null;
    try {
      await deps.mountSmbRoot(buildRootSmbUrl(trustedHost, share));
    } catch (error) {
      mountError = error;
    }

    const mountedRoot = await waitForRootShareMount(deps, trustedHost, share);
    if (mountedRoot) {
      return finishOpen(posixPath.join(mountedRoot.mountPoint, ...subSegments), deps);
    }
    if (mountError) {
      return { ok: false, reason: "error", error: errorMessage(mountError) };
    }
    if (target.kind === "unc") {
      return { ok: false, reason: "not_found" };
    }
  }

  // No root mount and no host to mount from: fall through to a local volume
  // (an external disk mounted at /Volumes/<share>) and let realpath decide.
  return finishOpen(posixPath.join("/Volumes", share, ...subSegments), deps);
}

async function openOnWindows(
  target: ParsedTarget,
  trustedHost: string,
  deps: NasPathDeps,
): Promise<OpenLocalPathResult> {
  if (target.kind === "windows") {
    return finishOpen(win32Path.normalize(target.path), deps);
  }
  if (target.kind === "volumes") {
    if (!trustedHost) return { ok: false, reason: "untrusted_host" };
    const root = `\\\\${trustedHost}\\${target.share ?? ""}`;
    return finishOpen(win32Path.join(root, ...target.subSegments), deps);
  }
  if (target.kind === "unc") {
    if (!target.host || !target.share) return { ok: false, reason: "invalid" };
    const root = `\\\\${target.host}\\${target.share}`;
    return finishOpen(win32Path.join(root, ...target.subSegments), deps);
  }
  return { ok: false, reason: "invalid" };
}

/**
 * Opens a NAS share (or, for `ipc`, a plain local directory) with the native
 * file manager. Validation and the host whitelist always run first; the
 * platform branches only ever see an absolute path naming the trusted host.
 */
export async function openNasPathSafely(
  rawPath: unknown,
  options: OpenNasPathOptions,
  depsOverride: Partial<NasPathDeps> = {},
): Promise<OpenLocalPathResult> {
  const validated = validateInput(rawPath);
  if (!validated.ok) return validated.result;
  const target = validated.target;

  const source: OpenPathSource = options?.source === "protocol" ? "protocol" : "ipc";
  const trustedHost =
    typeof options?.trustedHost === "string" ? options.trustedHost.trim() : "";
  const deps: NasPathDeps = { ...createDefaultDeps(), ...depsOverride };
  const platform = deps.platform;

  // Host whitelist lock: nothing below this line may see an untrusted host.
  if (target.kind === "unc") {
    if (!trustedHost || (target.host ?? "").toLowerCase() !== trustedHost.toLowerCase()) {
      return { ok: false, reason: "untrusted_host" };
    }
  }
  if (target.kind === "volumes") {
    if (source === "protocol" && !trustedHost) {
      return { ok: false, reason: "untrusted_host" };
    }
    if (platform === "win32" && !trustedHost) {
      return { ok: false, reason: "untrusted_host" };
    }
  }
  if (target.kind === "windows" && source === "protocol") {
    return { ok: false, reason: "invalid" };
  }
  if (target.kind === "posix") {
    if (source === "protocol") return { ok: false, reason: "invalid" };
    if (platform === "win32") return { ok: false, reason: "invalid" };
  }

  if (platform === "darwin") return openOnDarwin(target, trustedHost, deps);
  if (platform === "win32") return openOnWindows(target, trustedHost, deps);
  return { ok: false, reason: "unsupported" };
}
