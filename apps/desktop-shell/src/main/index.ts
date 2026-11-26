import { app, BrowserWindow, dialog, ipcMain, Menu } from "electron";
import path from "node:path";
import type {
  OpenLocalPathResult,
  ShellConfig,
  ShellInfo,
} from "../shared/types";
import {
  PROTOCOL_SCHEME,
  extractProtocolUrlFromArgv,
  parseBayclawOpenUrl,
} from "../shared/url-protocol";
import { coerceShellConfig, loadShellConfig, saveShellConfig } from "./config";
import { openNasPathSafely } from "./nas-path";
import { fetchCollabSpaceHost } from "./server-config";
import { writeSetupPageFile } from "./setup-page";
import {
  decideNavigation,
  isTrustedWebOrigin,
  openExternalSafely,
  shouldTrustCertificateError,
} from "./window-security";

const APP_NAME = "BayClaw";

let currentConfig: ShellConfig | null = null;
let collabSpaceHostCache = "";
let collabSpaceHostPromise: Promise<string> | null = null;
let mainWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
let ipcRegistered = false;
const pendingProtocolPaths: string[] = [];

function configPath(): string {
  return path.join(app.getPath("userData"), "shell-config.json");
}

function bundledDefaultsPath(): string {
  return path.join(process.resourcesPath, "shell-defaults.json");
}

function preloadPath(fileName: string): string {
  return path.join(__dirname, "..", "preload", fileName);
}

/**
 * Every window that can reach IPC or the network uses the same locked-down
 * web preferences: no Node, an isolated context, a Chromium sandbox, and no
 * insecure-content tolerance.
 */
function secureWebPreferences(preloadFile: string): Electron.WebPreferences {
  return {
    preload: preloadPath(preloadFile),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
  };
}

function effectiveCollabSpaceHost(): string {
  return currentConfig?.collabSpaceHostOverride?.trim() || collabSpaceHostCache;
}

/**
 * Discovers the NAS host lazily and caches it. A manual override always wins,
 * so an admin can pin the host without a reachable `/api/config`.
 */
function ensureCollabSpaceHost(force = false): Promise<string> {
  const config = currentConfig;
  if (!config) return Promise.resolve("");
  const override = config.collabSpaceHostOverride?.trim();
  if (override) return Promise.resolve(override);
  if (!force && collabSpaceHostCache) {
    return Promise.resolve(collabSpaceHostCache);
  }
  if (!collabSpaceHostPromise) {
    collabSpaceHostPromise = fetchCollabSpaceHost(config.serverUrl, {
      allowSelfSignedCert: config.allowSelfSignedCert,
    }).then((host) => {
      collabSpaceHostCache = host;
      collabSpaceHostPromise = null;
      return host;
    });
  }
  return collabSpaceHostPromise;
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function attachNavigationGuards(win: BrowserWindow): void {
  win.webContents.on("will-navigate", (event, targetUrl) => {
    const config = currentConfig;
    const decision = config ? decideNavigation(targetUrl, config.serverUrl) : "block";
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") void openExternalSafely(targetUrl);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    const config = currentConfig;
    const decision = config ? decideNavigation(url, config.serverUrl) : "block";
    if (decision === "allow") {
      createChildWindow(url);
    } else if (decision === "external") {
      void openExternalSafely(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
}

function reportLoadFailure(error: unknown, url: string): void {
  dialog.showErrorBox(
    `${APP_NAME} could not load the server`,
    `The window could not load ${url}.\n\n${error instanceof Error ? error.message : String(error)}\n\nOpen Server Settings from the ${APP_NAME} menu to check the address.`,
  );
}

function createMainWindow(config: ShellConfig): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: APP_NAME,
    backgroundColor: "#0b0f14",
    webPreferences: secureWebPreferences("index.js"),
  });

  mainWindow = win;
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  attachNavigationGuards(win);
  void win.loadURL(config.serverUrl).catch((error) => {
    if (!win.isDestroyed()) reportLoadFailure(error, config.serverUrl);
  });
  return win;
}

function createChildWindow(url: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: APP_NAME,
    backgroundColor: "#0b0f14",
    webPreferences: secureWebPreferences("index.js"),
  });
  attachNavigationGuards(win);
  void win.loadURL(url).catch(() => undefined);
  return win;
}

async function showSetupWindow(): Promise<void> {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }

  let pagePath: string;
  try {
    pagePath = await writeSetupPageFile(app.getPath("userData"));
  } catch (error) {
    dialog.showErrorBox(
      `${APP_NAME} setup failed`,
      `Could not create the settings page: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const win = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: `${APP_NAME} — Server Settings`,
    backgroundColor: "#0b0f14",
    webPreferences: secureWebPreferences("setup.js"),
  });

  setupWindow = win;
  win.on("closed", () => {
    if (setupWindow === win) setupWindow = null;
  });

  // The settings page is local and static: it may not navigate away or open
  // windows, even if its own markup were ever compromised.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  await win.loadFile(pagePath);
  if (!win.isDestroyed()) win.show();
}

function reportProtocolFailure(
  reason: string,
  targetPath: string,
  detail?: string,
): void {
  const guidance: Record<string, string> = {
    invalid:
      "This link does not name a NAS share path the desktop shell can open.",
    not_found:
      "The folder or file was not found. Check that the NAS is reachable.",
    untrusted_host:
      "The NAS host in this link is not configured. Open Server Settings and set the NAS host.",
    unsupported:
      "Opening NAS paths is not supported on this operating system.",
    error: "The operating system could not open this item.",
    untrusted_origin: "The request did not come from the configured BayClaw server.",
  };
  const message = guidance[reason] ?? guidance.error;
  dialog.showErrorBox(
    `${APP_NAME} could not open this folder`,
    `${message}\n\n${detail ? `${detail}\n\n` : ""}${targetPath}`,
  );
}

async function openProtocolPath(targetPath: string): Promise<void> {
  const config = currentConfig;
  if (!config) {
    pendingProtocolPaths.push(targetPath);
    return;
  }
  focusMainWindow();
  const trustedHost =
    config.collabSpaceHostOverride?.trim() || (await ensureCollabSpaceHost());
  const result = await openNasPathSafely(targetPath, {
    source: "protocol",
    trustedHost,
  });
  if (!result.ok) {
    reportProtocolFailure(result.reason, targetPath, result.error);
  }
}

function handleIncomingProtocolUrl(rawUrl: string): void {
  const parsed = parseBayclawOpenUrl(rawUrl);
  if (!parsed) return;
  if (!app.isReady() || !currentConfig) {
    pendingProtocolPaths.push(parsed.path);
    return;
  }
  void openProtocolPath(parsed.path);
}

function flushPendingProtocolPaths(): void {
  if (!currentConfig) return;
  const pending = pendingProtocolPaths.splice(0);
  for (const targetPath of pending) void openProtocolPath(targetPath);
}

function applyConfig(config: ShellConfig): void {
  currentConfig = config;
  collabSpaceHostCache = "";
  collabSpaceHostPromise = null;

  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
  setupWindow = null;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = null;

  createMainWindow(config);
  void ensureCollabSpaceHost();
  flushPendingProtocolPaths();
}

function registerIpcHandlers(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle(
    "shell:open-local-path",
    async (event, rawPath: unknown): Promise<OpenLocalPathResult> => {
      const config = currentConfig;
      if (!config || !isTrustedWebOrigin(event.senderFrame?.url, config.serverUrl)) {
        return { ok: false, reason: "untrusted_origin" };
      }
      const trustedHost =
        config.collabSpaceHostOverride?.trim() || (await ensureCollabSpaceHost());
      return openNasPathSafely(rawPath, { source: "ipc", trustedHost });
    },
  );

  ipcMain.handle(
    "shell:open-external",
    async (event, rawUrl: unknown): Promise<{ ok: boolean }> => {
      const config = currentConfig;
      if (!config || !isTrustedWebOrigin(event.senderFrame?.url, config.serverUrl)) {
        return { ok: false };
      }
      if (typeof rawUrl !== "string") return { ok: false };
      return { ok: await openExternalSafely(rawUrl) };
    },
  );

  ipcMain.handle("shell:get-info", (event): ShellInfo => {
    const config = currentConfig;
    const trusted =
      !!config && isTrustedWebOrigin(event.senderFrame?.url, config.serverUrl);
    return {
      name: "bayclaw-desktop-shell",
      version: app.getVersion(),
      platform: process.platform,
      serverUrl: trusted ? (config?.serverUrl ?? "") : "",
      collabSpaceHost: trusted ? effectiveCollabSpaceHost() : "",
    };
  });

  ipcMain.handle("shell:setup-get", (event): ShellConfig | null => {
    if (!setupWindow || event.sender !== setupWindow.webContents) return null;
    if (!currentConfig) return null;
    return { ...currentConfig };
  });

  ipcMain.handle(
    "shell:setup-save",
    async (event, payload: unknown): Promise<{ ok: boolean; error?: string }> => {
      if (!setupWindow || event.sender !== setupWindow.webContents) {
        return { ok: false, error: "This window may not change the configuration." };
      }
      const rawPayload =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : null;
      const candidate = coerceShellConfig(payload);
      if (!candidate) {
        return {
          ok: false,
          error:
            "Enter an https:// server URL. http:// is allowed only for localhost.",
        };
      }
      if (
        typeof rawPayload?.collabSpaceHostOverride === "string" &&
        rawPayload.collabSpaceHostOverride.trim() !== "" &&
        !candidate.collabSpaceHostOverride
      ) {
        return {
          ok: false,
          error: "Invalid NAS host override: expected a hostname or IP literal.",
        };
      }
      try {
        const saved = await saveShellConfig(configPath(), candidate);
        applyConfig(saved);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

function buildApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: APP_NAME,
      submenu: [
        {
          label: "Server Settings…",
          click: () => {
            void showSetupWindow();
          },
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        ...(isMac
          ? []
          : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerProtocolClient(): void {
  if (process.defaultApp && process.argv.length >= 2 && process.argv[1]) {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
    return;
  }
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

async function start(): Promise<void> {
  registerIpcHandlers();
  buildApplicationMenu();

  const loaded = await loadShellConfig({
    userConfigPath: configPath(),
    bundledDefaultsPath: bundledDefaultsPath(),
    env: process.env,
    argv: process.argv,
  });

  // Windows delivers a cold-start deep link through argv; capture it even
  // before first-run setup so it runs automatically once settings are saved.
  const coldStartUrl = extractProtocolUrlFromArgv(process.argv);
  if (coldStartUrl) handleIncomingProtocolUrl(coldStartUrl);

  if (loaded.config) {
    currentConfig = loaded.config;
    createMainWindow(loaded.config);
    void ensureCollabSpaceHost();
    flushPendingProtocolPaths();
    return;
  }

  await showSetupWindow();
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  registerProtocolClient();

  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleIncomingProtocolUrl(url);
  });

  app.on("second-instance", (_event, argv) => {
    const url = extractProtocolUrlFromArgv(argv);
    if (url) handleIncomingProtocolUrl(url);
    else focusMainWindow();
  });

  app.on(
    "certificate-error",
    (event, _webContents, url, _error, _certificate, callback) => {
      if (currentConfig && shouldTrustCertificateError(url, currentConfig)) {
        event.preventDefault();
        callback(true);
        return;
      }
      callback(false);
    },
  );

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (!mainWindow && !setupWindow) void start();
  });

  void app.whenReady().then(start);
}
