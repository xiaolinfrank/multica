import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isIP } from "node:net";
import type { ShellConfig } from "../shared/types";
import { normalizeServerUrl } from "../shared/url-protocol";

/** Filesystem surface used by the loader/saver; injectable for tests. */
export interface ShellConfigIo {
  readFile(path: string): Promise<string>;
  mkdir(path: string, options: { recursive: boolean; mode?: number }): Promise<unknown>;
  writeFile(path: string, data: string, options: { mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const defaultIo: ShellConfigIo = {
  readFile: (path) => readFile(path, "utf8"),
  mkdir: (path, options) => mkdir(path, options),
  writeFile: (path, data, options) => writeFile(path, data, options),
  rename: (oldPath, newPath) => rename(oldPath, newPath),
  unlink: (path) => unlink(path),
};

export interface LoadShellConfigOptions {
  /** `path.join(app.getPath("userData"), "shell-config.json")` */
  userConfigPath: string;
  /** Optional IT default shipped next to the app resources. */
  bundledDefaultsPath?: string | null;
  env?: Record<string, string | undefined>;
  argv?: readonly string[];
  io?: Partial<ShellConfigIo>;
}

export type ShellConfigSource = "cli" | "user" | "bundled" | "none";

export interface LoadedShellConfig {
  config: ShellConfig | null;
  source: ShellConfigSource;
}

const CONTROL_CHARACTERS = /\p{Cc}/u;
const MAX_HOST_LENGTH = 255;
const HOST_LABEL = /^[A-Za-z0-9_-]+$/;

/**
 * A NAS host is a hostname or an IP literal. Anything else — a slash, a
 * whitespace, an `@`, a control character, or a URL fragment — is refused
 * before it can be interpolated into a mount command.
 */
export function isValidCollabHost(host: string): boolean {
  if (typeof host !== "string") return false;
  const value = host.trim();
  if (!value || value !== host) return false;
  if (value.length > MAX_HOST_LENGTH) return false;
  if (CONTROL_CHARACTERS.test(value)) return false;
  if (/[\s/@\\?#]/.test(value)) return false;

  if (value.startsWith("[") && value.endsWith("]")) {
    return isIP(value.slice(1, -1)) === 6;
  }
  if (isIP(value) !== 0) return true;

  if (value.startsWith(".") || value.endsWith(".") || value.includes("..")) {
    return false;
  }
  const labels = value.split(".");
  return labels.every((label) => label.length > 0 && label.length <= 63 && HOST_LABEL.test(label));
}

function isTruthyEnv(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function readCliUrl(argv: readonly string[]): string | null {
  if (!Array.isArray(argv)) return null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== "string") continue;
    if (arg.startsWith("--url=")) {
      const value = arg.slice("--url=".length).trim();
      if (value) return value;
    }
    if (arg === "--url") {
      const next = argv[index + 1];
      if (typeof next === "string" && next.trim()) return next.trim();
    }
  }
  return null;
}

/** Coerces untrusted JSON into a config, or null when it is unusable. */
export function coerceShellConfig(value: unknown): ShellConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawUrl = typeof record.serverUrl === "string" ? record.serverUrl : "";
  const serverUrl = normalizeServerUrl(rawUrl);
  if (!serverUrl) return null;

  const config: ShellConfig = {
    serverUrl,
    allowSelfSignedCert: record.allowSelfSignedCert === true,
  };
  const rawOverride =
    typeof record.collabSpaceHostOverride === "string"
      ? record.collabSpaceHostOverride.trim()
      : "";
  if (rawOverride && isValidCollabHost(rawOverride)) {
    config.collabSpaceHostOverride = rawOverride;
  }
  return config;
}

async function readConfigFile(
  path: string,
  io: ShellConfigIo,
): Promise<ShellConfig | null> {
  let raw: string;
  try {
    raw = await io.readFile(path);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return coerceShellConfig(parsed);
}

/**
 * Resolution priority: CLI flag / environment, then the user's persisted
 * config, then an IT-provided bundled default, then first-run setup.
 */
export async function loadShellConfig(
  options: LoadShellConfigOptions,
): Promise<LoadedShellConfig> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const io: ShellConfigIo = { ...defaultIo, ...options.io };

  const cliUrl = readCliUrl(argv);
  const envUrl =
    typeof env.BAYCLAW_SHELL_URL === "string" ? env.BAYCLAW_SHELL_URL : "";
  const rawUrl = cliUrl ?? envUrl;
  if (rawUrl) {
    const serverUrl = normalizeServerUrl(rawUrl);
    // An unusable override is ignored rather than fatal: the next source may
    // still be a correct persisted config.
    if (serverUrl) {
      const config: ShellConfig = {
        serverUrl,
        allowSelfSignedCert: isTruthyEnv(env.BAYCLAW_ALLOW_SELF_SIGNED_CERT),
      };
      const override = (env.BAYCLAW_COLLAB_SPACE_HOST ?? "").trim();
      if (override && isValidCollabHost(override)) {
        config.collabSpaceHostOverride = override;
      }
      return { config, source: "cli" };
    }
  }

  const userConfig = await readConfigFile(options.userConfigPath, io);
  if (userConfig) return { config: userConfig, source: "user" };

  if (options.bundledDefaultsPath) {
    const bundled = await readConfigFile(options.bundledDefaultsPath, io);
    if (bundled) return { config: bundled, source: "bundled" };
  }

  return { config: null, source: "none" };
}

/**
 * Validates and persists the config. The write is atomic: a sibling temp file
 * with 0600 permissions is renamed over the destination, so a crash never
 * leaves a half-written JSON file behind.
 */
export async function saveShellConfig(
  userConfigPath: string,
  config: ShellConfig,
  ioOverride?: Partial<ShellConfigIo>,
): Promise<ShellConfig> {
  const io: ShellConfigIo = { ...defaultIo, ...ioOverride };
  const serverUrl = normalizeServerUrl(
    typeof config?.serverUrl === "string" ? config.serverUrl : "",
  );
  if (!serverUrl) {
    throw new Error(
      "Invalid server URL: use https:// for a remote host, or http://localhost only for local development.",
    );
  }

  const override =
    typeof config.collabSpaceHostOverride === "string"
      ? config.collabSpaceHostOverride.trim()
      : "";
  if (override && !isValidCollabHost(override)) {
    throw new Error("Invalid NAS host override: expected a hostname or IP literal.");
  }

  const normalized: ShellConfig = {
    serverUrl,
    allowSelfSignedCert: config.allowSelfSignedCert === true,
  };
  if (override) normalized.collabSpaceHostOverride = override;

  await io.mkdir(dirname(userConfigPath), { recursive: true, mode: 0o700 });

  const tempPath = `${userConfigPath}.${process.pid}.${Date.now()}.tmp`;
  await io.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    mode: 0o600,
  });

  try {
    await io.rename(tempPath, userConfigPath);
  } catch (error) {
    // Windows refuses to rename over an existing file. Falling back to a
    // replace is still safe: the temp file was fully written first.
    try {
      await io.unlink(userConfigPath);
      await io.rename(tempPath, userConfigPath);
    } catch {
      await io.unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  return normalized;
}
