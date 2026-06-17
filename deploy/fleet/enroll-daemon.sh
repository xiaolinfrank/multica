#!/usr/bin/env bash
#
# enroll-daemon.sh -- turn BayClaw fleet Mac nodes into compute-pool workers by
# installing the multica daemon + the Hermes agent (backed by the Fosun OpenAI
# gateway, model Kimi-K2.6) on each node and registering them as shared runtimes.
#
# What it does, per node, idempotently:
#   1. push the multica CLI binary  -> ~/bin/multica  (de-quarantined)
#   2. rsync the Hermes agent repo  -> ~/var/hermes-agent  (working tree only)
#   3. install uv (if missing) and `uv sync --extra acp`  (via FLEET_PROXY)
#   4. write ~/.hermes/config.yaml  (named custom provider "fosun" -> gateway)
#   5. write ~/.multica/config.json (server_url -> coordinator, token, workspace)
#   6. install a system LaunchDaemon (runs as root) so the daemon survives reboot
#      AND can reach the LAN -- a user LaunchAgent is blocked by macOS Local
#      Network privacy and gets "no route to host"; only a root daemon is exempt.
#
# The gateway bearer token is NOT stored on the node: the node's config.yaml
# reads it from $OPENAI_API_KEY, which the daemon injects per-task from the
# multica agent's custom_env. Only the multica daemon token touches the node.
#
# Usage:
#   deploy/fleet/enroll-daemon.sh <node-id> [node-id ...]
#   deploy/fleet/enroll-daemon.sh all
#   deploy/fleet/enroll-daemon.sh restart <node-id>   # just kick the daemon
#
# Env overrides:
#   COORD_URL        coordinator server URL    (default http://10.35.182.19:18080)
#   FLEET_PROXY      egress proxy for uv/pip   (default http://10.35.182.19:7897)
#   PROFILE          coordinator daemon profile to copy token/workspace from
#                                              (default bayclaw-bio)
#   DEVICES_FILE     inventory                 (default <repo>/deploy/fleet/devices.json)
#   MULTICA_BIN      CLI binary to ship        (default <repo>/server/bin/multica)
#   HERMES_SRC       Hermes repo to rsync      (default $HOME/var/hermes-agent)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COORD_URL="${COORD_URL:-http://10.35.182.19:18080}"
FLEET_PROXY="${FLEET_PROXY:-http://10.35.182.19:7897}"
PROFILE="${PROFILE:-bayclaw-bio}"
DEVICES_FILE="${DEVICES_FILE:-$ROOT/deploy/fleet/devices.json}"
MULTICA_BIN="${MULTICA_BIN:-$ROOT/server/bin/multica}"
HERMES_SRC="${HERMES_SRC:-$HOME/var/hermes-agent}"
PROFILE_CFG="$HOME/.multica/profiles/$PROFILE/config.json"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o ServerAliveInterval=10 -o StrictHostKeyChecking=accept-new)

say() { printf '\n=== %s ===\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[ -x "$MULTICA_BIN" ] || die "multica binary not found at $MULTICA_BIN (run: make build)"
[ -d "$HERMES_SRC" ] || die "Hermes repo not found at $HERMES_SRC"
[ -f "$DEVICES_FILE" ] || die "devices file not found at $DEVICES_FILE"
[ -f "$PROFILE_CFG" ] || die "profile config not found at $PROFILE_CFG (need a logged-in '$PROFILE' runner profile)"

# Pull token + workspace from the coordinator's runner profile. The token is a
# user PAT (mul_) for the shared-runner account; reusing it on each node makes
# every node register PUBLIC runtimes for the same workspace(s).
RUNNER_TOKEN="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["token"])' "$PROFILE_CFG")"
WORKSPACE_ID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("workspace_id",""))' "$PROFILE_CFG")"
[ -n "$RUNNER_TOKEN" ] || die "no token in $PROFILE_CFG"

# Resolve a node id -> "user host port" from devices.json (skips local).
node_fields() {
  python3 - "$DEVICES_FILE" "$1" <<'PY'
import json,sys
devs=json.load(open(sys.argv[1])); want=sys.argv[2]
for d in devs:
    if d.get("local"): continue
    if d.get("id")==want:
        print(d.get("user",want), d.get("host",""), d.get("port",22)); break
else:
    sys.exit(1)
PY
}

all_node_ids() {
  python3 - "$DEVICES_FILE" <<'PY'
import json,sys
for d in json.load(open(sys.argv[1])):
    if not d.get("local"): print(d["id"])
PY
}

enroll_node() {
  local id="$1" user host port
  read -r user host port < <(node_fields "$id") || die "unknown node id: $id"
  local target="$user@$host"
  say "$id ($target:$port)"

  if ! ssh "${SSH_OPTS[@]}" -p "$port" "$target" 'true' 2>/dev/null; then
    echo "  SKIP: $id unreachable over SSH"; return 1
  fi

  echo "  [1/6] push multica binary"
  ssh "${SSH_OPTS[@]}" -p "$port" "$target" 'mkdir -p ~/bin ~/var/hermes-agent ~/.multica ~/.hermes' 2>/dev/null
  scp "${SSH_OPTS[@]}" -P "$port" "$MULTICA_BIN" "$target:bin/multica.new" >/dev/null 2>&1 || { echo "  scp failed"; return 1; }
  ssh "${SSH_OPTS[@]}" -p "$port" "$target" \
    'mv ~/bin/multica.new ~/bin/multica && chmod +x ~/bin/multica && xattr -d com.apple.quarantine ~/bin/multica 2>/dev/null; true'

  echo "  [2/6] rsync Hermes repo (working tree)"
  rsync -az --delete \
    --exclude='.git' --exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' \
    --exclude='*.bak*' --exclude='logs/' \
    -e "ssh ${SSH_OPTS[*]} -p $port" \
    "$HERMES_SRC/" "$target:var/hermes-agent/" >/dev/null 2>&1 || { echo "  rsync failed"; return 1; }

  echo "  [3/6] install uv + uv sync --extra acp (via proxy)"
  echo "  [4/6] write ~/.hermes/config.yaml"
  ssh "${SSH_OPTS[@]}" -p "$port" "$target" "FLEET_PROXY='$FLEET_PROXY' bash -s" <<'REMOTE'
set -e
export HTTPS_PROXY="$FLEET_PROXY" HTTP_PROXY="$FLEET_PROXY" ALL_PROXY="$FLEET_PROXY"
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1
export PATH="$HOME/.local/bin:$PATH"
cd "$HOME/var/hermes-agent"
uv sync --extra acp >/dev/null 2>&1
cat > "$HOME/.hermes/config.yaml" <<'YAML'
model:
  default: "Kimi-K2.6"
  provider: "custom:fosun"
custom_providers:
  - name: fosun
    base_url: "https://ai-gateway.fosunpharma.com/kimi-2.6/v1"
    key_env: OPENAI_API_KEY
    api_mode: chat_completions
    models: ["Kimi-K2.6"]
YAML
chmod 600 "$HOME/.hermes/config.yaml"
"$HOME/var/hermes-agent/.venv/bin/hermes" version >/dev/null 2>&1 && echo "    hermes ok"
REMOTE

  echo "  [5/6] write ~/.multica/config.json (token via stdin)"
  printf '{"server_url":"%s","workspace_id":"%s","token":"%s"}\n' "$COORD_URL" "$WORKSPACE_ID" "$RUNNER_TOKEN" \
    | ssh "${SSH_OPTS[@]}" -p "$port" "$target" 'cat > ~/.multica/config.json && chmod 600 ~/.multica/config.json && echo "    config.json written"'

  echo "  [6/6] install + (re)start system LaunchDaemon (root)"
  ssh "${SSH_OPTS[@]}" -p "$port" "$target" "DEVICE_ID='$id' bash -s" <<'REMOTE'
set -e
H="$HOME"
PL=/tmp/com.bayclaw.fleet.daemon.plist
cat > "$PL" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.bayclaw.fleet.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>$H/bin/multica</string>
    <string>daemon</string><string>start</string>
    <string>--foreground</string>
    <string>--device-name</string><string>$DEVICE_ID</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/bayclaw-fleet-daemon.log</string>
  <key>StandardErrorPath</key><string>/tmp/bayclaw-fleet-daemon.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$H</string>
    <key>PATH</key><string>$H/.local/bin:$H/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>MULTICA_HERMES_PATH</key><string>$H/var/hermes-agent/.venv/bin/hermes</string>
  </dict>
</dict>
</plist>
PLIST
# Stop any prior daemon (in-session / user agent) to avoid daemon.id/port clash.
pkill -f "multica daemon start" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.bayclaw.fleet.daemon" 2>/dev/null || true
sudo -n launchctl bootout system/com.bayclaw.fleet.daemon 2>/dev/null || true
sleep 2
sudo -n cp "$PL" /Library/LaunchDaemons/com.bayclaw.fleet.daemon.plist
sudo -n chown root:wheel /Library/LaunchDaemons/com.bayclaw.fleet.daemon.plist
sudo -n chmod 644 /Library/LaunchDaemons/com.bayclaw.fleet.daemon.plist
sudo -n launchctl bootstrap system /Library/LaunchDaemons/com.bayclaw.fleet.daemon.plist
echo "    LaunchDaemon bootstrapped"
REMOTE

  # Verify the runtime registered (give the daemon a few seconds).
  sleep 6
  if "$MULTICA_BIN" runtime list --profile "$PROFILE" --output json 2>/dev/null \
       | grep -q "$id"; then
    echo "  OK: $id registered a runtime (device_name=$id)"
  else
    echo "  WARN: $id runtime not visible yet -- check /tmp/bayclaw-fleet-daemon.log on the node"
  fi
}

restart_node() {
  local id="$1" user host port
  read -r user host port < <(node_fields "$id") || die "unknown node id: $id"
  ssh "${SSH_OPTS[@]}" -p "$port" "$user@$host" \
    'sudo -n launchctl kickstart -k system/com.bayclaw.fleet.daemon && echo restarted' 2>/dev/null
}

main() {
  [ $# -ge 1 ] || die "usage: enroll-daemon.sh <node-id|all> [node-id ...] | restart <node-id>"
  if [ "$1" = "restart" ]; then shift; restart_node "$1"; return; fi
  local ids=()
  if [ "$1" = "all" ]; then while read -r n; do ids+=("$n"); done < <(all_node_ids); else ids=("$@"); fi
  local rc=0
  for id in "${ids[@]}"; do enroll_node "$id" || rc=1; done
  say "done"
  return $rc
}
main "$@"
