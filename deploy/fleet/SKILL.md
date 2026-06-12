---
name: bayclaw-fleet-management
description: "Use when operating the BayClaw 大湾区 compute pool — the coordinator host plus the fosun_agent_1..6 LAN Macs. Covers inventory, live status (dashboard + /api/fleet/status + health-check.sh), provisioning a clean Docker/Colima baseline (pilot one node first), dispatching containerized jobs via docker create/cp/start, and adding/removing nodes."
user-invocable: false
allowed-tools: Bash(ssh *), Bash(scp *), Bash(docker *), Bash(./provision.sh *), Bash(./health-check.sh *)
---

# BayClaw Fleet Management

The compute pool is the coordinator host (where the Multica server runs) plus a
set of LAN Mac workers. Accounts equal device names; SSH keys are pre-installed
on the coordinator, so `ssh <name>@<ip>` works with no password.

## Inventory — the one source of truth

`deploy/fleet/devices.json` (override with `FLEET_DEVICES_FILE`). The Go backend
loads the same list (`server/internal/fleet/config.go`); if the file is missing
it falls back to a built-in copy. Keep the two in sync — edit the JSON, don't
hardcode hosts elsewhere.

| id            | host          | role        |
| ------------- | ------------- | ----------- |
| local         | localhost     | coordinator |
| fosun_agent_1 | 10.35.182.4   | worker      |
| fosun_agent_2 | 10.35.182.31  | worker      |
| fosun_agent_3 | 10.35.182.39  | worker      |
| fosun_agent_4 | 10.35.182.34  | worker      |
| fosun_agent_5 | 10.35.182.25  | worker      |
| fosun_agent_6 | 10.35.182.29  | worker      |

## Check status first (read-only)

```bash
# Shell, all nodes at a glance:
deploy/fleet/health-check.sh

# Or hit the API the dashboard uses (workspace member auth required):
curl -s "$API/api/fleet/status" -H "Authorization: Bearer $JWT" -H "X-Workspace-ID: $WS" | jq
```

The Fleet page (left sidebar → 算力池 / Fleet) renders this live, 5s refresh.
A node that fails its probe stays visible as **offline** with the SSH error —
do not assume "missing card = healthy".

## Provision a clean, uniform baseline

Brings a node to: Homebrew + Colima + Docker CLI, a started Colima VM, verified
`docker run hello-world`, and a `~/bayclaw/work` dir. Idempotent.

**Always pilot ONE node, verify, then roll out.**

```bash
cd deploy/fleet
./provision.sh fosun_agent_1          # pilot
./health-check.sh                     # confirm: fosun_agent_1 docker=running
# only after the pilot is green:
./provision.sh all                    # remaining workers
```

Sizing overrides: `COLIMA_CPU=4 COLIMA_MEM=8 COLIMA_DISK=60 ./provision.sh all`.
Restricted network: prefix `FLEET_PROXY=http://10.35.182.19:7897` to route the
Homebrew install and the Colima image download through the coordinator proxy.

Why Colima (not Docker Desktop): headless, license-free, scriptable, the right
fit for unattended worker Macs.

What `provision.sh` sets up on each node:

- **NOPASSWD sudo** is required (Homebrew dir creation + vmnet need root).
- **vmnet** (`colima start --network-address`): the VM gets a real LAN IP, so the
  coordinator proxy works for both the host image download and the VM docker
  daemon in one start — no host-side forwarder, no gateway hop.
- **persistence**: Colima runs under a per-user LaunchAgent
  (`com.bayclaw.fleet.colima` → `~/.bayclaw-colima-start.sh`), so the VM survives
  SSH disconnects and reboots. Logs: `/tmp/bayclaw-colima.log`.

## Dispatch a containerized job to a worker

Use the **copy-in / copy-out** pattern — never bind-mount (`-v`) host paths;
the worker's filesystem layout is not guaranteed and mounts leak host state.

```bash
NODE=fosun_agent_2@10.35.182.31
ssh $NODE 'docker create --name job1 -w /work python:3.11 python /work/run.py'
ssh $NODE 'mkdir -p ~/bayclaw/work/job1'      # stage inputs under the standard dir
scp ./run.py $NODE:~/bayclaw/work/job1/
ssh $NODE 'docker cp ~/bayclaw/work/job1/. job1:/work/'
ssh $NODE 'docker start -a job1'              # -a streams logs back
ssh $NODE 'docker cp job1:/work/out ~/bayclaw/work/job1/out'
scp -r $NODE:~/bayclaw/work/job1/out ./out
ssh $NODE 'docker rm -f job1'                 # always clean up
```

## Add / remove a node

1. Add the public key to the new Mac's `~/.ssh/authorized_keys` (account = device name).
2. Append an entry to `deploy/fleet/devices.json` AND `defaultDevices` in
   `server/internal/fleet/config.go` (keep them mirrored).
3. `./provision.sh <new-id>`; confirm with `./health-check.sh`.
4. The dashboard picks it up on the next refresh — no rebuild needed if the JSON
   file is what the server reads.

## Common wrong assumptions

- **"The dashboard SSHes from my browser."** No — the Go backend SSHes; the
  browser only calls `/api/fleet/status`. Network/key issues live on the server host.
- **"Provisioning is safe to run on everything at once."** Run a pilot first; a
  bad Homebrew/Colima state is far cheaper to debug on one node.
- **"Bind-mounts are fine."** Use `docker cp`. See the dispatch pattern above.
- **"Editing only devices.json updates the API."** True only if the server reads
  that file (default path / `FLEET_DEVICES_FILE`). Otherwise it uses the built-in
  list in `config.go` — keep both in sync.
- **"Offline = removed."** Offline nodes still render (greyed, with the error).

## References

`references/fleet-source-map.md` traces every claim to source.
