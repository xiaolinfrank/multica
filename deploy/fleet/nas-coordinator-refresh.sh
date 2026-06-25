#!/bin/bash
# Run ON the COORDINATOR (本机) after `make build`.
# The bio/clinical runner LaunchAgents execute the binary INSIDE
# ~/Applications/BayClawFleet.app (a copy), NOT server/bin/multica — so a plain
# `make build` leaves them on the old binary. This refreshes the .app from the
# freshly built binary and re-signs with the dedicated signing keychain cert, so
# the Full Disk Access grant survives (DR is cert-bound). No sudo needed.
# See memory: nas-workspace-migration.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN_SRC="${MULTICA_BIN:-$ROOT/server/bin/multica}"
APP="$HOME/Applications/BayClawFleet.app"
APP_BIN="$APP/Contents/MacOS/multica"
KCP="$HOME/Library/Keychains/bayclaw-signing.keychain-db"
SIGN_CN="BayClaw Fleet Code Signing"

[ -x "$BIN_SRC" ] || { echo "binary not found: $BIN_SRC (run: make build)"; exit 1; }
[ -d "$APP" ]     || { echo "$APP missing — coordinator not migrated to NAS"; exit 1; }
HASH=$(security find-certificate -a -c "$SIGN_CN" -Z "$KCP" 2>/dev/null | awk '/SHA-1 hash:/{print $NF; exit}')
[ -n "$HASH" ]    || { echo "signing cert not found in $KCP"; exit 1; }

security unlock-keychain -p bayclaw "$KCP" 2>/dev/null || true
cp "$BIN_SRC" "$APP_BIN"
chmod 755 "$APP_BIN"
codesign --force --sign "$HASH" --keychain "$KCP" --identifier com.bayclaw.fleet.daemon "$APP"
codesign --verify "$APP" || { echo "re-sign failed"; exit 1; }
echo "refreshed + re-signed $APP ($("$APP_BIN" --version 2>&1 | head -1))"

for prof in bio clinical; do
  launchctl bootout "gui/$(id -u)/com.bayclaw.runner-$prof" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.bayclaw.runner-$prof.plist"
done
sleep 5
rc=0
for prof in bio clinical; do
  wr=$(grep -o 'workspaces_root=[^ ]*' "/tmp/bayclaw-runner-$prof.launchd.log" | tail -1)
  ep=$(grep -c 'operation not permitted' "/tmp/bayclaw-runner-$prof.launchd.log")
  echo "  runner-$prof: $wr EPERM=$ep"
  [ "$ep" = 0 ] || rc=1
done
[ "$rc" = 0 ] && echo "coordinator runners refreshed, on NAS, no EPERM." || echo "WARN: EPERM seen — re-check FDA grant on $APP"
exit $rc
