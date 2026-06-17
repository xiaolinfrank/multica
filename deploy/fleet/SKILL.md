---
name: bayclaw-fleet-management
description: "Use when operating the BayClaw 大湾区 compute pool — the coordinator host plus the fosun_agent_1..6 LAN Macs. Covers inventory, live status (dashboard + /api/fleet/status + health-check.sh), provisioning a clean Docker/Colima baseline (pilot one node first), dispatching containerized jobs via docker create/cp/start, and adding/removing nodes."
user-invocable: false
allowed-tools: Bash(ssh *), Bash(scp *), Bash(docker *), Bash(./provision.sh *), Bash(./health-check.sh *), Bash(./enroll-daemon.sh *), Bash(launchctl *)
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

## Enroll a node as an agent worker (daemon + Hermes/Kimi)

This is what makes a node actually *do work*: it runs a `multica daemon` that
registers an **agent runtime** and executes tasks with the **Hermes** agent
backed by the Fosun OpenAI gateway (model `Kimi-K2.6`). Idempotent:

```bash
deploy/fleet/enroll-daemon.sh fosun_agent_2     # one node
deploy/fleet/enroll-daemon.sh all               # every worker
deploy/fleet/enroll-daemon.sh restart fosun_agent_2
```

Per node it ships the `multica` binary, rsyncs the Hermes repo to
`~/var/hermes-agent`, installs uv + `uv sync --extra acp` (via `FLEET_PROXY`),
writes `~/.hermes/config.yaml` (named custom provider `fosun` → gateway, key from
`$OPENAI_API_KEY`) and `~/.multica/config.json` (server_url → coordinator
`10.35.182.19:18080`, token copied from the `bayclaw-bio` runner profile), then
installs a **system LaunchDaemon running as root**.

- **Why root LaunchDaemon, not a user LaunchAgent**: macOS Local Network privacy
  blocks a user-agent daemon from reaching the LAN → `no route to host`. A root
  system daemon is exempt. Needs NOPASSWD sudo (already set on the nodes).
- The gateway **bearer token never lands on the node** — it lives only in the
  multica agent's `custom_env` (`OPENAI_API_KEY`) and is injected per task.
- Each node's daemon registers with `--device-name=fosun_agent_N`, which the
  Fleet control plane uses to correlate the runtime back to the device card.

After enrolling, bind an agent: create one Hermes agent per node bound to that
node's `hermes` runtime (`multica agent create --runtime-id <id> --custom-env-stdin`
with `{"OPENAI_API_KEY":"…"}`, no `--model` → uses config.yaml default).

The Fleet page now overlays per-device **runtime status** (`runtime_online`,
distinct from SSH `online`), the agent **providers**, and live
**running/queued** task counts.

> **Pool limitation (current):** each agent is pinned to exactly one runtime —
> tasks for it run only on that node. There is no automatic cross-node load
> balancing yet; spread work by assigning to different per-node agents (or a
> squad). True pool binding (dynamic claim across idle nodes) is a planned
> backend change.

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
- **"SSH offline means the node can't run agents."** No — `runtime_online` is
  separate from SSH `online`. A node whose metrics probe fails can still have a
  healthy daemon executing tasks (e.g. fosun_agent_1's flaky SSH).
- **"Enrolling daemons load-balances a busy agent across the pool."** Not yet —
  an agent is pinned to one runtime. See the pool-limitation note above.
- **"A user LaunchAgent will keep the daemon alive."** It starts but can't reach
  the LAN (Local Network privacy) — use the root system LaunchDaemon.

## References

`references/fleet-source-map.md` traces every claim to source.
