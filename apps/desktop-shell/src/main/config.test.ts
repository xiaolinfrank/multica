// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ShellConfig } from "../shared/types";
import {
  coerceShellConfig,
  isValidCollabHost,
  loadShellConfig,
  saveShellConfig,
} from "./config";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "bayclaw-shell-config-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const userConfigPath = (): string => join(workDir, "userData", "shell-config.json");
const bundledConfigPath = (): string => join(workDir, "resources", "shell-defaults.json");

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

describe("loadShellConfig", () => {
  it("prefers the CLI flag over the environment and persisted files", async () => {
    await writeJson(userConfigPath(), {
      serverUrl: "https://persisted.example.com",
      allowSelfSignedCert: false,
    });

    const loaded = await loadShellConfig({
      userConfigPath: userConfigPath(),
      env: {
        BAYCLAW_SHELL_URL: "https://env.example.com",
        BAYCLAW_ALLOW_SELF_SIGNED_CERT: "1",
        BAYCLAW_COLLAB_SPACE_HOST: "cli-nas.example.internal",
      },
      argv: ["electron", ".", "--url=http://localhost:13000/"],
    });

    expect(loaded.source).toBe("cli");
    expect(loaded.config).toEqual({
      serverUrl: "http://localhost:13000",
      allowSelfSignedCert: true,
      collabSpaceHostOverride: "cli-nas.example.internal",
    });
  });

  it("falls back to the environment when no CLI flag is present", async () => {
    const loaded = await loadShellConfig({
      userConfigPath: userConfigPath(),
      env: { BAYCLAW_SHELL_URL: "https://env.example.com/" },
      argv: [],
    });

    expect(loaded.source).toBe("cli");
    expect(loaded.config?.serverUrl).toBe("https://env.example.com");
    expect(loaded.config?.allowSelfSignedCert).toBe(false);
  });

  it("ignores an invalid CLI URL and uses the persisted config", async () => {
    await writeJson(userConfigPath(), {
      serverUrl: "https://persisted.example.com/",
      allowSelfSignedCert: true,
    });

    const loaded = await loadShellConfig({
      userConfigPath: userConfigPath(),
      env: {},
      argv: ["electron", ".", "--url=http://persisted.example.com"],
    });

    expect(loaded.source).toBe("user");
    expect(loaded.config).toEqual({
      serverUrl: "https://persisted.example.com",
      allowSelfSignedCert: true,
    });
  });

  it("reads the persisted user config before bundled defaults", async () => {
    await writeJson(userConfigPath(), {
      serverUrl: "https://persisted.example.com",
      allowSelfSignedCert: false,
      collabSpaceHostOverride: "nas.example.internal",
    });
    await writeJson(bundledConfigPath(), {
      serverUrl: "https://bundled.example.com",
      allowSelfSignedCert: false,
    });

    const loaded = await loadShellConfig({
      userConfigPath: userConfigPath(),
      bundledDefaultsPath: bundledConfigPath(),
      env: {},
      argv: [],
    });

    expect(loaded.source).toBe("user");
    expect(loaded.config?.serverUrl).toBe("https://persisted.example.com");
    expect(loaded.config?.collabSpaceHostOverride).toBe("nas.example.internal");
  });

  it("uses bundled defaults when nothing else exists", async () => {
    await writeJson(bundledConfigPath(), {
      serverUrl: "https://bundled.example.com/",
      allowSelfSignedCert: true,
    });

    const loaded = await loadShellConfig({
      userConfigPath: userConfigPath(),
      bundledDefaultsPath: bundledConfigPath(),
      env: {},
      argv: [],
    });

    expect(loaded.source).toBe("bundled");
    expect(loaded.config?.serverUrl).toBe("https://bundled.example.com");
    expect(loaded.config?.allowSelfSignedCert).toBe(true);
  });

  it("falls back to bundled defaults when the user file is not JSON", async () => {
    await mkdir(join(workDir, "userData"), { recursive: true });
    await writeFile(userConfigPath(), "{not json", "utf8");
    await writeJson(bundledConfigPath(), {
      serverUrl: "https://bundled.example.com",
      allowSelfSignedCert: false,
    });

    const loaded = await loadShellConfig({
      userConfigPath: userConfigPath(),
      bundledDefaultsPath: bundledConfigPath(),
      env: {},
      argv: [],
    });

    expect(loaded.source).toBe("bundled");
  });

  it("falls back to bundled defaults when the user file fails validation", async () => {
    await writeJson(userConfigPath(), {
      serverUrl: "http://remote.example.com",
      allowSelfSignedCert: false,
    });
    await writeJson(bundledConfigPath(), {
      serverUrl: "https://bundled.example.com",
      allowSelfSignedCert: false,
    });

    const loaded = await loadShellConfig({
      userConfigPath: userConfigPath(),
      bundledDefaultsPath: bundledConfigPath(),
      env: {},
      argv: [],
    });

    expect(loaded.source).toBe("bundled");
  });

  it("returns none and null when no configuration exists", async () => {
    const loaded = await loadShellConfig({
      userConfigPath: userConfigPath(),
      env: {},
      argv: [],
    });
    expect(loaded).toEqual({ config: null, source: "none" });
  });

  it("drops an invalid NAS override from a persisted file", async () => {
    await writeJson(userConfigPath(), {
      serverUrl: "https://persisted.example.com",
      allowSelfSignedCert: false,
      collabSpaceHostOverride: "nas host/with slash",
    });

    const loaded = await loadShellConfig({
      userConfigPath: userConfigPath(),
      env: {},
      argv: [],
    });

    expect(loaded.config?.collabSpaceHostOverride).toBeUndefined();
  });
});

describe("saveShellConfig", () => {
  const baseConfig: ShellConfig = {
    serverUrl: "https://bayclaw.example.com/",
    allowSelfSignedCert: false,
  };

  it("writes a normalized config that reloads identically", async () => {
    const saved = await saveShellConfig(userConfigPath(), baseConfig);
    expect(saved.serverUrl).toBe("https://bayclaw.example.com");

    const loaded = await loadShellConfig({
      userConfigPath: userConfigPath(),
      env: {},
      argv: [],
    });

    expect(loaded.source).toBe("user");
    expect(loaded.config).toEqual(saved);
  });

  it("writes the file with 0600 permissions", async () => {
    await saveShellConfig(userConfigPath(), baseConfig);
    const info = await stat(userConfigPath());
    expect(info.mode & 0o777).toBe(0o600);
  });

  it("persists the self-signed flag and a valid override", async () => {
    const saved = await saveShellConfig(userConfigPath(), {
      serverUrl: "https://bayclaw.example.com",
      allowSelfSignedCert: true,
      collabSpaceHostOverride: "nas.example.internal",
    });

    expect(saved).toEqual({
      serverUrl: "https://bayclaw.example.com",
      allowSelfSignedCert: true,
      collabSpaceHostOverride: "nas.example.internal",
    });
    expect(JSON.parse(await readFile(userConfigPath(), "utf8"))).toEqual(saved);
  });

  it("rejects an invalid or insecure server URL", async () => {
    await expect(
      saveShellConfig(userConfigPath(), {
        serverUrl: "http://remote.example.com",
        allowSelfSignedCert: false,
      }),
    ).rejects.toThrow(/Invalid server URL/);
    await expect(
      saveShellConfig(userConfigPath(), {
        serverUrl: "https://user:pass@bayclaw.example.com",
        allowSelfSignedCert: false,
      }),
    ).rejects.toThrow(/Invalid server URL/);
  });

  it("rejects an invalid NAS override", async () => {
    await expect(
      saveShellConfig(userConfigPath(), {
        serverUrl: "https://bayclaw.example.com",
        allowSelfSignedCert: false,
        collabSpaceHostOverride: "nas host",
      }),
    ).rejects.toThrow(/Invalid NAS host override/);
  });
});

describe("coerceShellConfig", () => {
  it("rejects non-objects and arrays", () => {
    expect(coerceShellConfig(null)).toBeNull();
    expect(coerceShellConfig("https://bayclaw.example.com")).toBeNull();
    expect(coerceShellConfig([])).toBeNull();
  });

  it("defaults allowSelfSignedCert to false unless strictly true", () => {
    expect(
      coerceShellConfig({
        serverUrl: "https://bayclaw.example.com",
        allowSelfSignedCert: "yes",
      }),
    ).toEqual({
      serverUrl: "https://bayclaw.example.com",
      allowSelfSignedCert: false,
    });
  });
});

describe("isValidCollabHost", () => {
  it("accepts hostnames and IP literals", () => {
    expect(isValidCollabHost("nas.example.internal")).toBe(true);
    expect(isValidCollabHost("192.0.2.10")).toBe(true);
    expect(isValidCollabHost("2001:db8::10")).toBe(true);
    expect(isValidCollabHost("[2001:db8::10]")).toBe(true);
    expect(isValidCollabHost("team-nas")).toBe(true);
  });

  it("rejects slashes, whitespace, credentials, control characters, and empties", () => {
    expect(isValidCollabHost("")).toBe(false);
    expect(isValidCollabHost("   ")).toBe(false);
    expect(isValidCollabHost(" nas.example.internal")).toBe(false);
    expect(isValidCollabHost("nas.example.internal ")).toBe(false);
    expect(isValidCollabHost("nas host")).toBe(false);
    expect(isValidCollabHost("nas/example")).toBe(false);
    expect(isValidCollabHost("nas\\example")).toBe(false);
    expect(isValidCollabHost("user@nas.example.internal")).toBe(false);
    expect(isValidCollabHost("nas.example.internal?x=1")).toBe(false);
    expect(isValidCollabHost("nas.example.internal\u0000")).toBe(false);
  });

  it("rejects malformed DNS labels", () => {
    expect(isValidCollabHost(".nas.example.internal")).toBe(false);
    expect(isValidCollabHost("nas..example.internal")).toBe(false);
    expect(isValidCollabHost(`${"a".repeat(64)}.example.internal`)).toBe(false);
    expect(isValidCollabHost("nas example.internal")).toBe(false);
  });
});
