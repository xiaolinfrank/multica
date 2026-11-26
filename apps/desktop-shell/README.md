# BayClaw Desktop Shell

A small Electron shell that loads the live BayClaw web UI directly from your
server and adds one native capability a browser cannot provide: opening NAS
folders in Finder (macOS) or Explorer (Windows) with the correct parent volume
mounted.

It contains **no frontend bundle**. A web deploy is picked up on the next
reload; shipping a new desktop build is only needed when the shell itself
changes.

## Why a separate package

`apps/desktop/` is the full Multica desktop client: React, the shared views,
bundled daemons, and a local renderer build. This package is deliberately the
opposite — two preload scripts, a handful of main-process modules, and `tsc`.
It exists as `apps/desktop-shell/` so upstream desktop work can merge cleanly.

## Architecture

```text
apps/desktop-shell/
  src/shared/url-protocol.ts   URL normalization + bayclaw-open:// parsing
  src/main/config.ts           CLI/env > user config > bundled defaults
  src/main/server-config.ts    Reads collab_space_host from /api/config
  src/main/window-security.ts  Navigation, origin, certificate, and URL guards
  src/main/nas-path.ts         macOS mount/stat and Windows UNC handling
  src/main/setup-page.ts       Self-contained first-run settings screen
  src/main/index.ts            Lifecycle, protocol registration, IPC, menus
  src/preload/index.ts         window.desktopAPI for the remote web UI
  src/preload/setup.ts         window.shellSetupAPI for the local settings page
```

- The main window loads `serverUrl` with `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, and `webSecurity: true`.
- The remote page receives exactly three IPC calls, and the main process
  re-checks the caller's origin against `serverUrl` on every one.
- The settings page is a local `file://` document with a strict CSP. Only that
  window gets the settings preload; a served page can never rewrite the server
  URL or turn on certificate trust.

## Local development

Start the web app (default port `13000`) and point the shell at it:

```bash
pnpm dev:shell -- --url=http://localhost:13000
```

Or use the environment variable:

```bash
BAYCLAW_SHELL_URL=http://localhost:13000 pnpm dev:shell
```

`http://` is accepted only for `localhost`, `127.0.0.1`, and `[::1]`. Everything
else must be `https://`.

Other environment variables:

| Variable | Effect |
| --- | --- |
| `BAYCLAW_SHELL_URL` | Server URL override (same as `--url=`). |
| `BAYCLAW_ALLOW_SELF_SIGNED_CERT` | `1` / `true` trusts a self-signed certificate for that host only. |
| `BAYCLAW_COLLAB_SPACE_HOST` | Pins the trusted NAS host instead of discovering it. |

Command-line and environment values are not persisted. Clearing them returns
the shell to the saved configuration.

## Configuration

Resolution order:

1. `--url=<url>` or `BAYCLAW_SHELL_URL` (plus the two optional variables above)
2. `shell-config.json` in the app's per-user data directory
3. A bundled `shell-defaults.json` in the app resources directory
4. The first-run settings screen

The saved file looks like this:

```json
{
  "serverUrl": "https://bayclaw.example.com",
  "allowSelfSignedCert": false,
  "collabSpaceHostOverride": "nas.example.internal"
}
```

It is written atomically with `0600` permissions.

### IT preconfiguration

To ship an organization default, copy
[`shell-defaults.example.json`](./shell-defaults.example.json) to
`shell-defaults.json`, fill in the real server and NAS host, and place it in the
packaged app's resources directory (`BayClaw.app/Contents/Resources/` on macOS,
`resources/` next to `BayClaw.exe` on Windows). The file is only read; the user's
saved config always wins. Never commit a real internal URL or host.

The NAS host is normally discovered from `${serverUrl}/api/config`
(`collab_space_host`). The override exists for deployments that expose it at a
different address or block the discovery request.

## Packaging

```bash
pnpm --filter @bayclaw/desktop-shell build
pnpm --filter @bayclaw/desktop-shell package:mac
pnpm --filter @bayclaw/desktop-shell package:win
```

Artifacts land in `release/`. `notarize: false` in `electron-builder.yml` keeps
local builds unsigned; release pipelines can override it through the usual
electron-builder environment variables.

## `bayclaw-open://` protocol

```text
bayclaw-open://open?path=<encodeURIComponent(path)>
```

Examples:

```text
bayclaw-open://open?path=%2FVolumes%2FTeam%20Space%2FDesign
bayclaw-open://open?path=%5C%5Cnas.example.internal%5CShare%5CDesign
```

Rules:

- Only the `open` action and the `path` parameter are read. A `host` or any
  other parameter in the URL is ignored; the trusted host always comes from
  configuration.
- Paths are limited to 1024 UTF-8 bytes, must be absolute, and may not contain
  control characters or `..` segments.
- A deep link is stricter than an in-app click: it may only name
  `/Volumes/<share>/...` or a UNC path on the configured host. Arbitrary local
  paths and drive letters are refused.

## Security model

- **Host whitelist.** UNC paths are compared case-insensitively against the
  configured NAS host before any mount, stat, or open. An unconfigured host
  returns `untrusted_host` and touches nothing.
- **Root-share mounts only.** macOS reuses an existing `smbfs` mount of the
  share root, and mounts `smb://host/<share>` when none exists. Leaf submounts
  (`//host/share/sub`) are ignored so no orphaned volume is created. The SMB URL
  is passed to `osascript` through `argv`; there is no shell interpolation.
- **No executable launches.** `shell.openPath` is called only for a real
  directory that is not a macOS bundle and does not end in a Windows
  executable/shortcut extension. Both the clicked path and the `realpath`
  result are checked. Files, bundles, symlinks into bundles, `.app`, `.pkg`,
  `.exe`, `.lnk`, `.ps1`, and similar are revealed in the file manager instead.
- **Same-origin IPC.** Every IPC handler checks the sender frame's origin
  against `serverUrl` first. A foreign frame gets `untrusted_origin`.
- **Navigation guard.** Same-origin navigation stays in the window; other
  `http:`/`https:` URLs go to the default browser; `file:`, `smb:`,
  `javascript:`, `data:`, and `bayclaw-open:` are blocked.
- **Scoped certificate trust.** The self-signed opt-in applies only when the
  failing URL's host equals the configured server host, and only for the
  `/api/config` request. `NODE_TLS_REJECT_UNAUTHORIZED` is never modified.
- **Single instance.** A second launch forwards its deep link to the running
  window instead of starting a second shell.

## Tests

```bash
pnpm --filter @bayclaw/desktop-shell build
pnpm --filter @bayclaw/desktop-shell typecheck
pnpm --filter @bayclaw/desktop-shell lint
pnpm --filter @bayclaw/desktop-shell test
```

The NAS module takes its filesystem, command, and Electron access through
dependency injection, so both the macOS and Windows branches run deterministically
on any operating system without mounting a real share.
