#!/bin/bash
# BayClaw fleet — harden the NAS auto-mount against mid-run drops.
# Run ON a node (user context; no sudo needed — mount-nas is a user LaunchAgent).
#   1. soft SMB mount  -> I/O fails fast (~SMB timeout) instead of hanging the
#      daemon forever when the NAS blips. Takes effect on the next (re)mount.
#   2. StartInterval watchdog -> launchd re-runs the idempotent mount-nas.sh
#      every 120s, so a dropped share is automatically remounted.
set -uo pipefail
SH="$HOME/Library/Scripts/mount-nas.sh"
PL="$HOME/Library/LaunchAgents/com.fosunpharma.mount-nas.plist"

if [ -f "$SH" ]; then
  if grep -q 'mount_smbfs -o soft' "$SH"; then
    echo "  soft mount: already set"
  else
    sed -i '' 's/mount_smbfs "/mount_smbfs -o soft "/g' "$SH" && echo "  soft mount: added"
  fi
  echo "  mount line: $(grep -o 'mount_smbfs[^"]*"//' "$SH" | head -1)"
else
  echo "  WARN: $SH not found"
fi

if [ -f "$PL" ]; then
  if plutil -extract StartInterval raw "$PL" >/dev/null 2>&1; then
    echo "  StartInterval: already set ($(plutil -extract StartInterval raw "$PL"))"
  else
    plutil -insert StartInterval -integer 120 "$PL" && echo "  StartInterval: 120s added"
  fi
  launchctl bootout "gui/$(id -u)/com.fosunpharma.mount-nas" 2>/dev/null
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$PL" && echo "  mount-nas LA reloaded"
else
  echo "  WARN: $PL not found"
fi
echo "  NAS smbfs mounts now: $(mount | grep -c 'NAS/.*smbfs')"
