#!/bin/bash
# bayclaw-fleet-refresh.sh <local-multica-binary> [device-id ...]
#
# Headless refresh of the fleet worker daemon binary inside
# /Applications/BayClawFleet.app on each worker node.
#
# Per node:
#   1. probe SSH (5x retry - agent_1 is flaky)
#   2. read the LIVE designated requirement; extract `certificate root = H"<sha1>"`
#      -> ad-hoc signed app (no cert root) means ABORT this node, never swap blind
#   3. scp new binary, sudo swap into the .app
#   4. re-sign with the SAME certificate (System keychain, identifier
#      com.bayclaw.fleet.daemon) so the DR stays certificate-pinned and the
#      Full Disk Access grant survives
#   5. verify DR is unchanged, then launchctl kickstart -k the daemon
#
# Must run under /bin/bash (zsh does not word-split). Pure ASCII only:
# remote shells are bash 3.2 and heredocs with multibyte chars break.
# Feed nothing to ssh via -n; stdin is used by the scp/ssh pipes.
set -u

BIN="$1"
shift || true
IDS="$@"
if [ -z "$IDS" ]; then
  IDS="agent_1 agent_2 agent_3 agent_4 agent_5 agent_6"
fi
if [ ! -f "$BIN" ]; then
  echo "ERROR: local binary not found: $BIN" >&2
  exit 2
fi

host_of() {
  case "$1" in
    agent_1) echo 10.35.182.4 ;;
    agent_2) echo 10.35.182.31 ;;
    agent_3) echo 10.35.182.39 ;;
    agent_4) echo 10.35.182.34 ;;
    agent_5) echo 10.35.182.25 ;;
    agent_6) echo 10.35.182.29 ;;
    *) echo "" ;;
  esac
}

APP=/Applications/BayClawFleet.app
MACOS_BIN=$APP/Contents/MacOS/multica
FAILED=""

for id in $IDS; do
  host=$(host_of "$id")
  if [ -z "$host" ]; then
    echo "[$id] unknown device id, skipped"
    FAILED="$FAILED $id"
    continue
  fi
  # accounts are fosun_agent_N while the selector ids are agent_N
  SSH=(ssh -o ConnectTimeout=8 -o BatchMode=yes "fosun_$id@$host")

  ok=0
  for i in 1 2 3 4 5; do
    if "${SSH[@]}" true 2>/dev/null; then ok=1; break; fi
    sleep 2
  done
  if [ "$ok" != 1 ]; then
    echo "[$id] SSH probe failed after 5 tries, skipped"
    FAILED="$FAILED $id"
    continue
  fi

  if ! scp -o ConnectTimeout=8 -o BatchMode=yes -q "$BIN" "fosun_$id@$host:/tmp/multica.new"; then
    echo "[$id] scp failed, skipped"
    FAILED="$FAILED $id"
    continue
  fi

  "${SSH[@]}" /bin/bash -s "$MACOS_BIN" "$APP" <<'REMOTE'
set -u
MACOS_BIN="$1"
APP="$2"

DR=$(codesign -d --requirements - "$APP" 2>&1)
HASH=$(printf '%s\n' "$DR" | sed -n 's/.*certificate root = H"\([0-9a-fA-F]*\)".*/\1/p' | head -1)
if [ -z "$HASH" ]; then
  echo "ABORT: live DR has no certificate root (ad-hoc?) - refusing blind swap"
  echo "DR was: $DR"
  exit 1
fi

sudo /bin/cp -f /tmp/multica.new "$MACOS_BIN" || { echo "ABORT: cp failed"; exit 1; }
sudo codesign --force --sign "$HASH" \
  --keychain /Library/Keychains/System.keychain \
  --identifier com.bayclaw.fleet.daemon "$APP" || { echo "ABORT: codesign failed"; exit 1; }

DR2=$(codesign -d --requirements - "$APP" 2>&1)
HASH2=$(printf '%s\n' "$DR2" | sed -n 's/.*certificate root = H"\([0-9a-fA-F]*\)".*/\1/p' | head -1)
if [ "$HASH2" != "$HASH" ]; then
  echo "ABORT: DR changed after re-sign ($HASH -> $HASH2)"
  exit 1
fi

VER=$("$MACOS_BIN" --version 2>&1 | head -1)
sudo launchctl kickstart -k system/com.bayclaw.fleet.daemon || { echo "ABORT: kickstart failed"; exit 1; }
# keep ~/bin/multica in sync: the fleet status page probes THIS copy over SSH
# for daemon_version, not the .app copy the daemon actually runs
mkdir -p "$HOME/bin"
/bin/cp -f /tmp/multica.new "$HOME/bin/multica" || echo "WARN: ~/bin sync failed (fleet page version will look stale)"
echo "OK cert=$HASH version=$VER"
REMOTE

  if [ $? -eq 0 ]; then
    echo "[$id] refreshed"
  else
    echo "[$id] FAILED (see remote output above)"
    FAILED="$FAILED $id"
  fi
done

if [ -n "$FAILED" ]; then
  echo "FAILED devices:$FAILED"
  exit 1
fi
echo "all refreshed"
