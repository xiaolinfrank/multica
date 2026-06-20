#!/bin/bash
# BayClaw fleet — set up NAS workspace access for the multica daemon on a node.
#
# macOS TCC blocks ANY launchd-spawned process (root LaunchDaemon or user
# LaunchAgent) from reading/writing a network volume (/Volumes/NAS, SMB/NFS).
# The only fix is to grant the multica binary Full Disk Access (FDA). FDA cannot
# be added to a bare CLI binary, so multica is wrapped in /Applications/
# BayClawFleet.app and code-signed with a stable self-signed cert so the FDA
# grant survives rebuilds (TCC matches the cert-based Designated Requirement,
# not the cdhash). See memory: nas-workspace-migration.
#
# Run ON the node (needs NOPASSWD sudo). Idempotent.
#   nas-fda-setup.sh prep     <device-id>   # build .app + cert + sign + wrapper + enable Screen Sharing
#                                            # (daemon keeps LOCAL workdir, stays healthy) — then GRANT FDA via GUI
#   nas-fda-setup.sh activate <device-id>   # switch daemon to NAS workspaces root + reload (run AFTER FDA granted)
#   nas-fda-setup.sh refresh  <device-id>   # after `make build`: refresh .app binary + re-sign + NAS plist (enroll calls this)
#   nas-fda-setup.sh verify   <device-id>   # check daemon is on NAS root with no TCC EPERM
set -euo pipefail

MODE="${1:?usage: nas-fda-setup.sh prep|activate|refresh|verify <device-id>}"
DEV="${2:?device-id required (e.g. fosun_agent_3)}"

HOMEDIR="/Users/${DEV}"
BIN_SRC="${HOMEDIR}/bin/multica"
APP="/Applications/BayClawFleet.app"
APP_BIN="${APP}/Contents/MacOS/multica"
WRAPPER="/usr/local/bin/bayclaw-fleet-daemon-wrapper.sh"
PLIST="/Library/LaunchDaemons/com.bayclaw.fleet.daemon.plist"
SIGN_CN="BayClaw Fleet Code Signing"
SYS_KC="/Library/Keychains/System.keychain"
NAS_MOUNTPOINT="/Volumes/NAS/虚拟员工工作区"
WS_ROOT="${NAS_MOUNTPOINT}/v2/${DEV}"
HERMES="${HOMEDIR}/var/hermes-agent/.venv/bin/hermes"
PATHV="${HOMEDIR}/.local/bin:${HOMEDIR}/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# SHA-1 of our code-signing cert (works for untrusted self-signed certs, unlike
# `find-identity -v` which only lists trust-valid identities). Sign by this hash
# so a duplicate same-CN cert can never make `codesign --sign <CN>` ambiguous.
sign_hash() {
  sudo security find-certificate -a -c "$SIGN_CN" -Z "$SYS_KC" 2>/dev/null | awk '/SHA-1 hash:/{print $NF; exit}'
}

ensure_cert() {
  if [ -n "$(sign_hash)" ]; then
    echo "  cert present"; return
  fi
  echo "  creating self-signed code-signing cert in System keychain"
  local d; d=$(mktemp -d)
  cat > "$d/ext.cnf" <<CNF
[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=${SIGN_CN}
O=BayClaw
[v3]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
CNF
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes -keyout "$d/k.key" -out "$d/c.crt" -config "$d/ext.cnf" 2>/dev/null
  openssl pkcs12 -export -inkey "$d/k.key" -in "$d/c.crt" -out "$d/c.p12" -passout pass:bayclaw -name "$SIGN_CN" 2>/dev/null
  sudo security import "$d/c.p12" -k "$SYS_KC" -P bayclaw -A -T /usr/bin/codesign >/dev/null
  rm -rf "$d"
}

build_and_sign_app() {
  echo "  building + signing ${APP}"
  sudo mkdir -p "${APP}/Contents/MacOS"
  sudo cp "$BIN_SRC" "$APP_BIN"
  sudo chmod 755 "$APP_BIN"
  sudo tee "${APP}/Contents/Info.plist" >/dev/null <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.bayclaw.fleet.daemon</string>
<key>CFBundleName</key><string>BayClawFleet</string>
<key>CFBundleExecutable</key><string>multica</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1.0</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
PL
  sudo codesign --force --sign "$(sign_hash)" --keychain "$SYS_KC" --identifier com.bayclaw.fleet.daemon "$APP"
  codesign --verify "$APP" && echo "  signature valid; DR:"
  codesign -d --requirements - "$APP" 2>&1 | grep -i designated | sed 's/^/    /'
}

install_wrapper() {
  echo "  installing wrapper ${WRAPPER}"
  sudo mkdir -p "$(dirname "$WRAPPER")"
  sudo tee "$WRAPPER" >/dev/null <<'WR'
#!/bin/bash
# Gate the daemon on the NAS SMB share being mounted, then exec the real daemon.
# Runs as /bin/bash (no FDA) so it MUST only read the mount table (getfsstat,
# not TCC-gated), never touch files on the NAS volume.
set -euo pipefail
MOUNTPOINT="/Volumes/NAS/虚拟员工工作区"
: "${MULTICA_WORKSPACES_ROOT:?MULTICA_WORKSPACES_ROOT must be set by the plist}"
nas_mounted() { /sbin/mount | grep -qF "on ${MOUNTPOINT} ("; }
for _ in $(seq 1 60); do nas_mounted && break; sleep 5; done
nas_mounted || { echo "[wrapper] NAS share ${MOUNTPOINT} not mounted; aborting so launchd retries" >&2; exit 1; }
echo "[wrapper] NAS mount present; MULTICA_WORKSPACES_ROOT=${MULTICA_WORKSPACES_ROOT}; exec: $*"
exec "$@"
WR
  sudo chmod 755 "$WRAPPER"
}

enable_screensharing() {
  echo "  enabling Screen Sharing (VNC :5900) for the one-time FDA grant"
  sudo launchctl enable system/com.apple.screensharing 2>/dev/null || true
  sudo launchctl bootstrap system /System/Library/LaunchDaemons/com.apple.screensharing.plist 2>/dev/null || true
}

write_plist_local() {  # daemon runs the .app binary, LOCAL workdir (healthy pre-grant)
  sudo tee "$PLIST" >/dev/null <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.bayclaw.fleet.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${APP_BIN}</string>
    <string>daemon</string><string>start</string><string>--foreground</string>
    <string>--device-name</string><string>${DEV}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/bayclaw-fleet-daemon.log</string>
  <key>StandardErrorPath</key><string>/tmp/bayclaw-fleet-daemon.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${HOMEDIR}</string>
    <key>PATH</key><string>${PATHV}</string>
    <key>MULTICA_HERMES_PATH</key><string>${HERMES}</string>
  </dict>
</dict></plist>
PL
}

write_plist_nas() {  # daemon runs via wrapper -> .app binary, NAS workdir
  sudo tee "$PLIST" >/dev/null <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.bayclaw.fleet.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${WRAPPER}</string>
    <string>${APP_BIN}</string>
    <string>daemon</string><string>start</string><string>--foreground</string>
    <string>--device-name</string><string>${DEV}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/bayclaw-fleet-daemon.log</string>
  <key>StandardErrorPath</key><string>/tmp/bayclaw-fleet-daemon.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${HOMEDIR}</string>
    <key>PATH</key><string>${PATHV}</string>
    <key>MULTICA_HERMES_PATH</key><string>${HERMES}</string>
    <key>MULTICA_WORKSPACES_ROOT</key><string>${WS_ROOT}</string>
  </dict>
</dict></plist>
PL
}

write_plist_legacy() {  # pre-NAS behavior: daemon runs ~/bin/multica directly on LOCAL workdir
  sudo tee "$PLIST" >/dev/null <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.bayclaw.fleet.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${BIN_SRC}</string>
    <string>daemon</string><string>start</string><string>--foreground</string>
    <string>--device-name</string><string>${DEV}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/bayclaw-fleet-daemon.log</string>
  <key>StandardErrorPath</key><string>/tmp/bayclaw-fleet-daemon.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${HOMEDIR}</string>
    <key>PATH</key><string>${PATHV}</string>
    <key>MULTICA_HERMES_PATH</key><string>${HERMES}</string>
  </dict>
</dict></plist>
PL
}

reload_daemon() {
  sudo plutil -lint "$PLIST" >/dev/null
  sudo launchctl bootout system/com.bayclaw.fleet.daemon 2>/dev/null || true
  sleep 2
  sudo launchctl bootstrap system "$PLIST"
  sleep 6
}

remove_stray_user_agent() {  # latent double-run on reboot (see agent_2)
  local f="${HOMEDIR}/Library/LaunchAgents/com.bayclaw.fleet.daemon.plist"
  if [ -f "$f" ]; then
    mv "$f" "${f}.disabled" && echo "  moved stray user LaunchAgent (would double-run on reboot)"
  fi
}

case "$MODE" in
  prep)
    echo "[prep ${DEV}] building signed .app + wrapper (daemon stays on LOCAL workdir)"
    ensure_cert
    build_and_sign_app
    install_wrapper
    remove_stray_user_agent
    mkdir -p "$WS_ROOT" 2>/dev/null && echo "  NAS dir ready: $WS_ROOT" || echo "  WARN: could not create $WS_ROOT (NAS mounted?)"
    write_plist_local
    reload_daemon
    enable_screensharing
    echo ""
    echo ">>> NEXT: Screen Sharing to vnc://$(ipconfig getifaddr en0 2>/dev/null || echo this-host) and add"
    echo ">>>       ${APP}  to  System Settings > Privacy & Security > Full Disk Access"
    echo ">>> Then run:  nas-fda-setup.sh activate ${DEV}"
    sudo launchctl print system/com.bayclaw.fleet.daemon 2>/dev/null | grep -E 'state =' | head -1
    ;;
  activate)
    echo "[activate ${DEV}] switching daemon to NAS workspaces root: $WS_ROOT"
    mkdir -p "$WS_ROOT" 2>/dev/null || true
    write_plist_nas
    reload_daemon
    echo "  verifying..."
    grep -E 'workspaces_root|\[wrapper\]' /tmp/bayclaw-fleet-daemon.log | tail -2
    if tail -40 /tmp/bayclaw-fleet-daemon.log | grep -qi 'operation not permitted'; then
      echo "  !! TCC EPERM still present — FDA grant not effective. Re-check the grant targets ${APP}."
      exit 1
    fi
    echo "  OK: no TCC EPERM. Daemon on NAS root."
    ;;
  refresh)
    # Re-deploy after `make build`: pull the fresh binary into the signed .app and
    # re-sign with the node's existing cert (DR stays stable -> FDA grant holds),
    # then write the NAS plist + reload. Falls back to a legacy LOCAL daemon if the
    # node was never migrated (no signed .app / cert) so a fresh node still runs.
    if [ -x "$APP_BIN" ] && [ -n "$(sign_hash)" ]; then
      echo "[refresh ${DEV}] migrated node: refreshing signed .app + NAS plist"
      sudo cp "$BIN_SRC" "$APP_BIN"
      sudo chmod 755 "$APP_BIN"
      sudo codesign --force --sign "$(sign_hash)" --keychain "$SYS_KC" --identifier com.bayclaw.fleet.daemon "$APP"
      codesign --verify "$APP" || { echo "  re-sign failed"; exit 1; }
      mkdir -p "$WS_ROOT" 2>/dev/null || true
      write_plist_nas
      reload_daemon
      if tail -40 /tmp/bayclaw-fleet-daemon.log | grep -qi 'operation not permitted'; then
        echo "  !! TCC EPERM after refresh — FDA grant lost? Re-grant ${APP}."; exit 1
      fi
      grep -E 'workspaces_root' /tmp/bayclaw-fleet-daemon.log | tail -1
      echo "  OK: refreshed binary + NAS plist, no EPERM."
    else
      echo "[refresh ${DEV}] NOT migrated to NAS (no signed .app/cert) — installing legacy LOCAL daemon"
      echo "  To migrate: nas-fda-setup.sh prep ${DEV}; grant FDA to ${APP}; then re-run."
      write_plist_legacy
      reload_daemon
      sudo launchctl print system/com.bayclaw.fleet.daemon 2>/dev/null | grep -E 'state =' | head -1
    fi
    ;;
  verify)
    grep -E 'workspaces_root' /tmp/bayclaw-fleet-daemon.log | tail -1
    sudo launchctl print system/com.bayclaw.fleet.daemon 2>/dev/null | grep -E 'state =' | head -1
    tail -40 /tmp/bayclaw-fleet-daemon.log | grep -qi 'operation not permitted' && echo "EPERM PRESENT (bad)" || echo "no EPERM (good)"
    ;;
  *) echo "unknown mode: $MODE"; exit 2;;
esac
