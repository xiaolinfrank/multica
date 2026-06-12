#!/usr/bin/env bash
#
# provision.sh -- bring a BayClaw compute-pool Mac node to a clean, uniform
# baseline: Homebrew + Colima + Docker CLI, a started Colima VM with standard
# resources, and a verified `docker run hello-world`. Idempotent -- re-running
# skips anything already in place.
#
# Usage:
#   ./provision.sh                 # provision ALL worker nodes in devices.json
#   ./provision.sh fosun_agent_1   # provision a single node by id (pilot first!)
#   ./provision.sh all
#
# Tuning (env overrides):
#   COLIMA_CPU=4 COLIMA_MEM=8 COLIMA_DISK=60   # VM sizing (cores / GiB / GiB)
#   FLEET_DEVICES_FILE=/path/devices.json      # alternate inventory
#
# The coordinator (local) node is skipped -- it runs the server, not workloads.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVENTORY="${FLEET_DEVICES_FILE:-$SCRIPT_DIR/devices.json}"
TARGET="${1:-all}"

COLIMA_CPU="${COLIMA_CPU:-4}"
COLIMA_MEM="${COLIMA_MEM:-8}"
COLIMA_DISK="${COLIMA_DISK:-60}"

# Optional egress proxy for nodes that cannot reach GitHub/ghcr directly (the
# Homebrew install and the Colima VM image both fetch from GitHub). On the
# BayClaw LAN the coordinator's proxy is reachable, e.g.
#   FLEET_PROXY=http://10.35.182.19:7897 ./provision.sh all
FLEET_PROXY="${FLEET_PROXY:-}"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR)

# Remote bootstrap -- written to a temp file via a top-level single-quoted
# heredoc (NOT command substitution, which mis-parses heredocs under macOS's
# bash 3.2). Nothing expands locally; the node runs it via `bash -s` with sizing
# in C_CPU/C_MEM/C_DISK and the optional proxy in PROXY.
REMOTE_FILE="$(mktemp -t bayclaw-provision)"
trap 'rm -f "$REMOTE_FILE"' EXIT
cat > "$REMOTE_FILE" <<'REMOTE_EOF'
set -u
say() { printf '    %s\n' "$*"; }

# Route all egress through the proxy when one was provided.
if [ -n "${PROXY:-}" ]; then
  export http_proxy="$PROXY" https_proxy="$PROXY" HTTP_PROXY="$PROXY" HTTPS_PROXY="$PROXY"
  say "using proxy $PROXY"
fi

# Locate Homebrew (Apple Silicon -> /opt/homebrew, Intel -> /usr/local).
load_brew() {
  if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)";
  elif [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
}
load_brew

if ! command -v brew >/dev/null 2>&1; then
  # First-time Homebrew install creates /opt/homebrew, which needs sudo. If this
  # account has no passwordless sudo, the installer cannot proceed unattended --
  # fail with an actionable message instead of a confusing mid-install abort.
  if [ ! -d /opt/homebrew ] && [ ! -x /usr/local/bin/brew ] && ! sudo -n true 2>/dev/null; then
    echo "ERROR: Homebrew is absent and creating /opt/homebrew needs sudo, but this"
    echo "       account has no passwordless sudo. Resolve one of:"
    echo "         - grant NOPASSWD sudo to this worker account, then re-run; or"
    echo "         - have an admin run the Homebrew install once, then re-run (the"
    echo "           Colima/Docker steps below do NOT need sudo)."
    exit 3
  fi
  say "installing Homebrew (non-interactive)..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
    || { echo "ERROR: Homebrew install failed"; exit 1; }
  load_brew
fi
command -v brew >/dev/null 2>&1 || { echo "ERROR: brew not on PATH after install"; exit 1; }

for pkg in colima docker docker-compose; do
  if brew list "$pkg" >/dev/null 2>&1; then
    say "$pkg already installed"
  else
    say "installing $pkg..."
    brew install "$pkg" || { echo "ERROR: brew install $pkg failed"; exit 1; }
  fi
done

# Networking model: give the VM its own LAN IP via vmnet (--network-address)
# instead of colima's default gvisor user-mode net. gvisor lets the VM reach the
# internet and the host but NOT other LAN hosts -- so it cannot use a LAN proxy
# (the coordinator) directly, forcing an awkward host-side forwarder. With vmnet
# the VM is a first-class LAN peer: the SAME coordinator proxy works for both the
# host-side image download and the in-VM docker daemon, in a single start.
# vmnet needs root; the worker accounts have NOPASSWD sudo so colima does it
# non-interactively.
NET_OPTS="--network-address"

# Persistence wrapper used by the LaunchAgent (boot restart). It carries PATH +
# proxy so launchd's non-login context can find brew and reach the network.
if [ -n "${PROXY:-}" ]; then PROXY_LINE="export http_proxy=$PROXY https_proxy=$PROXY HTTP_PROXY=$PROXY HTTPS_PROXY=$PROXY no_proxy=127.0.0.1,localhost"; else PROXY_LINE=":"; fi
mkdir -p "$HOME/Library/LaunchAgents"
WRAP="$HOME/.bayclaw-colima-start.sh"
{
  printf '%s\n' '#!/bin/bash'
  printf '%s\n' 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"'
  printf '%s\n' "$PROXY_LINE"
  printf 'for i in 1 2 3; do colima start %s --cpu %s --memory %s --disk %s && exit 0; sleep 15; done\n' "$NET_OPTS" "${C_CPU}" "${C_MEM}" "${C_DISK}"
  printf '%s\n' 'exit 1'
} > "$WRAP"
chmod +x "$WRAP"
CPLIST="$HOME/Library/LaunchAgents/com.bayclaw.fleet.colima.plist"
{
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  printf '%s\n' '<plist version="1.0"><dict>'
  printf '%s\n' '  <key>Label</key><string>com.bayclaw.fleet.colima</string>'
  printf '%s\n' '  <key>ProgramArguments</key><array>'
  printf '    <string>%s</string>\n' "$WRAP"
  printf '%s\n' '  </array>'
  printf '%s\n' '  <key>RunAtLoad</key><true/>'
  printf '%s\n' '  <key>StandardOutPath</key><string>/tmp/bayclaw-colima.log</string>'
  printf '%s\n' '  <key>StandardErrorPath</key><string>/tmp/bayclaw-colima.log</string>'
  printf '%s\n' '</dict></plist>'
} > "$CPLIST"
launchctl bootout "gui/$(id -u)/com.bayclaw.fleet.colima" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$CPLIST" 2>/dev/null || launchctl load "$CPLIST" 2>/dev/null

# Drop any forwarder from older script versions -- vmnet makes it unnecessary.
launchctl bootout "gui/$(id -u)/com.bayclaw.fleet.proxy" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/com.bayclaw.fleet.proxy.plist" 2>/dev/null

# Start colima IN THIS SSH SESSION (not via launchd): on multi-NIC Macs the
# launchd GUI context picks a source interface that cannot reach the LAN proxy,
# so the in-session network context is what makes the one-time image download
# work. The VM persists after disconnect; the LaunchAgent only handles reboots,
# by when the image is cached (no download needed).
if colima status >/dev/null 2>&1; then
  say "colima already running"
else
  say "starting colima (vmnet, cpu=${C_CPU} mem=${C_MEM}GiB disk=${C_DISK}GiB)..."
  ok=0
  for i in 1 2 3; do
    # shellcheck disable=SC2086
    if colima start $NET_OPTS --cpu "${C_CPU}" --memory "${C_MEM}" --disk "${C_DISK}"; then ok=1; break; fi
    say "colima start attempt $i failed; cleaning up and retrying..."
    colima delete -f >/dev/null 2>&1
    sleep 10
  done
  [ "$ok" = 1 ] || { echo "ERROR: colima start failed after retries"; exit 1; }
fi

# Standard working directory used by dispatched container jobs.
mkdir -p "$HOME/bayclaw/work"

say "verifying docker (hello-world)..."
if docker run --rm hello-world >/dev/null 2>&1; then
  say "OK -- $(docker --version)"
  say "OK -- $(colima version 2>/dev/null | head -1)"
else
  echo "ERROR: 'docker run hello-world' failed"; exit 1
fi
REMOTE_EOF

provision_node() {
  local id="$1" user="$2" host="$3" port="$4"
  echo "==> [$id] $user@$host:$port"
  # -n: don't read this script's stdin (would otherwise swallow the loop input).
  if ! ssh -n "${SSH_OPTS[@]}" -p "$port" "${user}@${host}" true 2>/dev/null; then
    echo "    ERROR: SSH unreachable -- check key/network, skipping"
    return 1
  fi
  if ssh "${SSH_OPTS[@]}" -p "$port" "${user}@${host}" \
    "C_CPU=${COLIMA_CPU} C_MEM=${COLIMA_MEM} C_DISK=${COLIMA_DISK} PROXY='${FLEET_PROXY}' bash -s" < "$REMOTE_FILE"; then
    echo "    DONE [$id]"
  else
    echo "    FAILED [$id] (see message above)"
    return 1
  fi
}

# Fill TARGETS without mapfile (absent on macOS's bash 3.2). Process substitution
# keeps python's stdin separate from the loop.
TARGETS=()
while IFS= read -r line; do
  [ -n "$line" ] && TARGETS+=("$line")
done < <(python3 - "$INVENTORY" "$TARGET" <<'PY'
import json, sys
inv, target = sys.argv[1], sys.argv[2]
for d in json.load(open(inv)):
    if d.get("local"):
        continue
    if target != "all" and d.get("id") != target:
        continue
    print(d["id"], d.get("user", ""), d["host"], d.get("port", 22))
PY
)

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "No matching worker node for target '$TARGET' in $INVENTORY"
  exit 1
fi

rc=0
for line in "${TARGETS[@]}"; do
  # shellcheck disable=SC2086
  provision_node $line || rc=1
done

echo
echo "Provisioning finished (target: $TARGET). Run ./health-check.sh to confirm."
exit $rc
