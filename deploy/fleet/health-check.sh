#!/usr/bin/env bash
#
# health-check.sh -- one-line reachability + Docker status for every node in the
# inventory. Read-only; safe to run any time. Mirrors what the Fleet dashboard
# shows, but from the shell.
#
# Usage:
#   ./health-check.sh
#   FLEET_DEVICES_FILE=/path/devices.json ./health-check.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVENTORY="${FLEET_DEVICES_FILE:-$SCRIPT_DIR/devices.json}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=6 -o StrictHostKeyChecking=accept-new -o LogLevel=ERROR)

# Remote probe: emit "docker=... containers=...". Add Homebrew bins to PATH -- a
# non-login SSH shell doesn't load the profile, so docker/colima wouldn't be
# found otherwise and every node would falsely read docker=absent.
PROBE='export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then echo "docker=running containers=$(docker ps -q 2>/dev/null | wc -l | tr -d " ")"; else echo "docker=stopped containers=0"; fi
else echo "docker=absent containers=0"; fi'

printf "%-16s %-16s %-10s %-10s %s\n" "ID" "HOST" "REACH" "DOCKER" "CTRS"
printf "%-16s %-16s %-10s %-10s %s\n" "----------------" "----------------" "----------" "----------" "----"

python3 - "$INVENTORY" <<'PY' | while read -r id user host port local; do
import json, sys
for d in json.load(open(sys.argv[1])):
    print(d["id"], d.get("user", "-"), d["host"], d.get("port", 22), "1" if d.get("local") else "0")
PY
  if [ "$local" = "1" ]; then
    out="$(bash -c "$PROBE" 2>/dev/null </dev/null)"
    reach="local"
  # -n on ssh: this loop's stdin is the python pipe; ssh would otherwise eat it.
  elif ssh -n "${SSH_OPTS[@]}" -p "$port" "${user}@${host}" true 2>/dev/null; then
    out="$(ssh -n "${SSH_OPTS[@]}" -p "$port" "${user}@${host}" "$PROBE" 2>/dev/null)"
    reach="up"
  else
    out="docker=- containers=-"
    reach="DOWN"
  fi
  docker="$(echo "$out" | sed -n 's/.*docker=\([^ ]*\).*/\1/p')"
  ctrs="$(echo "$out" | sed -n 's/.*containers=\([^ ]*\).*/\1/p')"
  printf "%-16s %-16s %-10s %-10s %s\n" "$id" "$host" "$reach" "${docker:--}" "${ctrs:--}"
done
