# BayClaw Fleet — 算力池

The BayClaw 大湾区 compute pool: the coordinator host (where the Multica server
runs) plus a set of LAN Mac workers. This directory holds the inventory, the
provisioning/health scripts, and the agent skill for operating it.

## Devices

Accounts equal device names; SSH keys are pre-installed on the coordinator, so
`ssh <name>@<ip>` works passwordless.

| id            | host          | account       | role        |
| ------------- | ------------- | ------------- | ----------- |
| local         | localhost     | —             | coordinator |
| fosun_agent_1 | 10.35.182.4   | fosun_agent_1 | worker      |
| fosun_agent_2 | 10.35.182.31  | fosun_agent_2 | worker      |
| fosun_agent_3 | 10.35.182.39  | fosun_agent_3 | worker      |
| fosun_agent_4 | 10.35.182.34  | fosun_agent_4 | worker      |
| fosun_agent_5 | 10.35.182.25  | fosun_agent_5 | worker      |
| fosun_agent_6 | 10.35.182.29  | fosun_agent_6 | worker      |

The list lives in [`devices.json`](./devices.json). The Go backend reads the
same file (`FLEET_DEVICES_FILE`, default `deploy/fleet/devices.json`) and falls
back to a built-in copy in `server/internal/fleet/config.go` — keep both in sync.

## Files

| File | Purpose |
| --- | --- |
| `devices.json` | Inventory consumed by the backend and the scripts. |
| `provision.sh` | Idempotent baseline: Homebrew + Colima + Docker, verified. |
| `health-check.sh` | Read-only reachability + Docker status table. |
| `SKILL.md` | Agent skill — how to operate the pool. |
| `references/fleet-source-map.md` | Traces the skill's claims to source. |

## Prerequisite for provisioning

Worker accounts need **passwordless sudo** (`NOPASSWD`). Two steps require it:

- first-time **Homebrew** install creates `/opt/homebrew` (root-owned dir), and
- **Colima with vmnet** (`--network-address`, see *Networking* below) sets up the
  bridge as root.

`provision.sh` detects a missing Homebrew + no-sudo case and exits with guidance.
Grant `NOPASSWD` to the worker accounts (drop a line in `/etc/sudoers.d/`), or
have an admin run the Homebrew install once per node first.

## Quick start

```bash
cd deploy/fleet

# See where everything stands (read-only):
./health-check.sh

# Provision a clean Docker baseline — PILOT one node first:
./provision.sh fosun_agent_1
./health-check.sh            # confirm fosun_agent_1 → docker=running

# Roll out to the rest once the pilot is green:
./provision.sh all
```

Colima sizing overrides: `COLIMA_CPU=4 COLIMA_MEM=8 COLIMA_DISK=60 ./provision.sh all`.

**Behind a restricted network?** The Homebrew install and the Colima VM image both
fetch from GitHub, which the corporate LAN may reset. Route egress through the
coordinator's proxy with `FLEET_PROXY`:

```bash
FLEET_PROXY=http://10.35.182.19:7897 ./provision.sh all
```

## Networking & persistence

- **vmnet** — `provision.sh` starts Colima with `--network-address`, giving each
  VM a real LAN IP (e.g. `192.168.64.x`) instead of Colima's default gvisor
  user-mode net. gvisor would let the VM reach the internet but **not** other LAN
  hosts, so it could not use the coordinator proxy directly. With vmnet the VM is
  a first-class LAN peer and the **same** `FLEET_PROXY` serves both the host-side
  image download and the in-VM docker daemon — one clean `colima start`.
- **persistence** — Colima is started by a per-user LaunchAgent
  (`com.bayclaw.fleet.colima`, runs `~/.bayclaw-colima-start.sh`), so the VM
  survives SSH disconnects and restarts on boot. Logs at `/tmp/bayclaw-colima.log`.

## Dashboard

The live view is in-app: left sidebar → **算力池 / Fleet** (`/<workspace>/fleet`).
It calls `GET /api/fleet/status`, which SSH-probes every node from the **server
host** (not the browser) and caches the snapshot ~5s. Offline nodes still render,
greyed, with their SSH error.

## Why Colima

Headless, license-free, and scriptable — the right Docker runtime for unattended
worker Macs, versus the GUI-bound Docker Desktop.

## Dispatching jobs

Use copy-in / copy-out (`docker create` → `docker cp` → `docker start -a` →
`docker cp` out → `docker rm`), never bind-mounts. See `SKILL.md` for the full
pattern.
