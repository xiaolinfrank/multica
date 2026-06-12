# Fleet management — source map

Every claim in `SKILL.md` traces to a line below. Re-derive against the current
tree before trusting any path; the behavior is the contract, the path is a
pointer.

## Inventory & config

- `deploy/fleet/devices.json` — the editable inventory (coordinator + 6 workers).
- `server/internal/fleet/config.go`:
  - `Device` struct — JSON shape (`id, name, host, user, port, local, labels`).
  - `LoadDevices()` — reads `FLEET_DEVICES_FILE` (env `EnvDevicesFile`) or the
    default path `deploy/fleet/devices.json`; falls back to `defaultDevices` on
    any read/parse failure.
  - `defaultDevices` — the built-in copy that mirrors `devices.json`.

## Live status

- `server/internal/fleet/collector.go`:
  - `metricsScript` — the macOS probe (CPU/mem/disk/load/uptime/docker) emitting
    `key=value` lines.
  - `Collect()` — concurrent (errgroup, limit 8) probe with a 5s in-process cache.
  - `execRemote()` — `ssh -o BatchMode=yes -o ConnectTimeout=5 -o
    StrictHostKeyChecking=accept-new … bash -s`; `execLocal()` for the coordinator.
  - `applyMetrics()` — parses probe output; partial output leaves zero values
    (fail-closed), offline nodes carry `Error`.
- `server/internal/handler/fleet.go` — `GetFleetStatus`: workspace-member gate,
  then `Collect`, returns `{ devices, collected_at }` (snake_case JSON).
- `server/cmd/server/router.go` — `r.Get("/api/fleet/status", h.GetFleetStatus)`
  inside the `RequireWorkspaceMember` group; `h.Fleet = fleet.New(fleet.LoadDevices())`.

## Frontend

- `packages/core/api/client.ts` — `getFleetStatus()` via `parseWithFallback`.
- `packages/core/api/schemas.ts` — `FleetStatusSchema` (`.loose()`, all-optional).
- `packages/core/fleet/queries.ts` — `fleetStatusOptions()` (`refetchInterval: 5000`).
- `packages/views/fleet/components/fleet-page.tsx` — the dashboard UI.
- `packages/core/paths/paths.ts` — `fleet: () => \`${ws}/fleet\``.
- `packages/views/layout/app-sidebar.tsx` — nav entry `{ key: "fleet", icon: Server }`.
- Routes: `apps/web/app/[workspaceSlug]/(dashboard)/fleet/page.tsx`,
  `apps/desktop/src/renderer/src/routes.tsx` (`path: "fleet"`).

## Ops scripts

- `deploy/fleet/provision.sh` — Homebrew -> Colima + Docker -> Colima via a
  per-user LaunchAgent (`com.bayclaw.fleet.colima`, vmnet `--network-address`,
  retrying start) -> `docker run hello-world`; per-node, idempotent, pilot-first.
  `FLEET_PROXY` routes the Homebrew/image fetch through the coordinator proxy.
  Requires NOPASSWD sudo (Homebrew dir + vmnet). The remote script is written to
  a temp file (not a `$()`-captured heredoc) and is pure ASCII so it parses
  under the macOS bash 3.2 baseline.
- `deploy/fleet/health-check.sh` — read-only reachability + docker status table;
  its probe prepends `/opt/homebrew/bin` to PATH (non-login SSH shells lack it).
- Persistence/runtime artifacts on each node: `~/.bayclaw-colima-start.sh`
  (wrapper), `~/Library/LaunchAgents/com.bayclaw.fleet.colima.plist`,
  `/tmp/bayclaw-colima.log`.
