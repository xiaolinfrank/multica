#!/usr/bin/env bash
#
# bayclaw-serve.sh -- start/stop/restart the BayClaw dev deployment as detached
# background processes (so they survive the launching shell / SSH session):
#   - Go API server  (server/bin/server)            on $PORT          (.env: 18080)
#   - Next.js web (production build + next start)    on $FRONTEND_PORT (.env: 13000)
#
# Web is served as a PRODUCTION build, not `next dev`. Dev mode blocks
# cross-origin requests to /_next/* dev resources for any host not in
# `allowedDevOrigins`, which silently breaks login (the controlled email input
# never hydrates) for every LAN device other than the one bound to the server.
# Production has no such gate. URLs stay origin-relative because NEXT_PUBLIC_*
# are empty in .env, so the bundle is LAN-safe.
#
# Postgres (docker) and the agent daemon are left untouched -- the daemon
# reconnects automatically after the server restarts.
#
# Usage:
#   scripts/bayclaw-serve.sh start        # build Go + start both, detached
#   scripts/bayclaw-serve.sh stop         # stop both (frees the two ports)
#   scripts/bayclaw-serve.sh restart      # build Go + restart both  (the deploy flow)
#   scripts/bayclaw-serve.sh status       # show listeners, health, recent logs
#
# Flags:
#   --no-build      skip BOTH the Go (`make build`) and web (`next build`) build
#                   steps on start/restart; restart the existing binaries/bundle
#                   as-is (faster; use when neither backend nor frontend changed)
#   ENV_FILE=path   use an alternate env file (default: <repo>/.env)
#
# Logs: <repo>/logs/server.log and <repo>/logs/web.log
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
LOG_DIR="$ROOT/logs"

cmd="${1:-}"
shift 2>/dev/null || true
NO_BUILD=0
for a in "$@"; do [ "$a" = "--no-build" ] && NO_BUILD=1; done

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: env file not found: $ENV_FILE" >&2
  exit 1
fi
# Load .env into the environment (the server binary and next dev read it from
# their process env). Assignments only; comments/blank lines are ignored.
set -a; . "$ENV_FILE"; set +a
PORT="${PORT:-8080}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

say() { printf '==> %s\n' "$*"; }

kill_port() {
  local p="$1" pids
  pids="$(lsof -ti:"$p" 2>/dev/null)"
  [ -n "$pids" ] || return 0
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  for _ in 1 2 3 4 5; do
    lsof -ti:"$p" >/dev/null 2>&1 || return 0
    sleep 1
  done
  pids="$(lsof -ti:"$p" 2>/dev/null)"
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null
  return 0
}

stop_all() {
  say "stopping web (:$FRONTEND_PORT)"
  pkill -f "turbo dev --filter=@multica/web" 2>/dev/null
  pkill -f "pnpm dev:web" 2>/dev/null
  pkill -f "next start --port $FRONTEND_PORT" 2>/dev/null
  kill_port "$FRONTEND_PORT"
  say "stopping API server (:$PORT)"
  kill_port "$PORT"
}

build_go() {
  if [ "$NO_BUILD" = 1 ]; then
    say "skipping Go build (--no-build)"
    return 0
  fi
  say "building Go binaries (make build)"
  ( cd "$ROOT" && make build ) || { echo "ERROR: make build failed" >&2; exit 1; }
  refresh_server_app
}

# refresh_server_app copies the freshly-built server binary into the
# BayClawServer.app bundle and re-signs it with the pinned cert so the .app
# keeps its FDA across rebuilds (DR = certificate root, not cdhash — the
# authorization survives a binary swap + same-cert re-sign, no GUI re-grant).
# No-op if the .app was never created (e.g. a fresh checkout without FDA set up).
refresh_server_app() {
  local app="$HOME/Applications/BayClawServer.app"
  local kc="$HOME/Library/Keychains/bayclaw-signing.keychain-db"
  local cert=8E5D68C59C6E9806E2D4870EDD90573B28FDE2FD
  [ -d "$app" ] || return 0
  [ -f "$ROOT/server/bin/server" ] || return 0
  /bin/cp -f "$ROOT/server/bin/server" "$app/Contents/MacOS/server"
  if [ -f "$kc" ]; then
    security unlock-keychain -p bayclaw "$kc" 2>/dev/null
    if codesign --force --sign "$cert" --keychain "$kc" --identifier com.bayclaw.server.serve "$app" 2>/dev/null; then
      say "refreshed + re-signed BayClawServer.app (FDA preserved)"
    else
      say "WARN: BayClawServer.app re-sign failed (check keychain '$kc')"
    fi
  fi
}

# Wait for Postgres (runs in colima docker) before starting the Go server.
# On reboot, colima can take minutes to come up; the Go binary fatals if the
# DB is unreachable at boot, and com.bayclaw.serve (RunAtLoad, no KeepAlive)
# would not restart it. Poll the host-side 5432 forward until it is up.
wait_for_pg() {
  local i
  say "waiting for Postgres ..."
  for i in $(seq 1 60); do
    # Prefer `docker exec pg_isready`: it asks Postgres inside the container
    # directly and bypasses the host loopback, which the Cisco AnyConnect
    # acsockext filter can otherwise swallow (new SYNs to 127.0.0.1 make `nc`
    # hang even though PG is fine — that hang previously killed restart
    # mid-way, after stop_all had already taken the server down).
    # Fall back to nc on [::1] (IPv6 loopback is immune), with a 2s timeout.
    if docker exec multica-postgres-1 pg_isready -U multica -d multica >/dev/null 2>&1; then
      say "Postgres is ready (after ${i}s)"; return 0
    fi
    nc -z -w2 ::1 5432 2>/dev/null && { say "Postgres is ready via ::1 (after ${i}s)"; return 0; }
    sleep 1
  done
  echo "WARN: Postgres not reachable after 60s; starting server anyway" >&2
  return 1
}

# wait_for_nas blocks until the SMB share is mounted, so the server doesn't
# race the mount on boot (LOCAL_UPLOAD_DIR may point at the NAS for the
# attachments-on-NAS deployment). Reads the mount table ONLY — never touches a
# file on the volume: AnyConnect's TCC wall blocks sentinel `[ -f ]` probes on
# network volumes from launchd contexts, but `mount` output is always readable
# (getfsstat, not a file open).
wait_for_nas() {
  local i
  say "waiting for NAS mount /Volumes/虚拟员工工作区 ..."
  for i in $(seq 1 60); do
    if mount | grep -qF "on /Volumes/虚拟员工工作区 (smbfs"; then
      say "NAS mounted (after ${i}s)"; return 0
    fi
    sleep 1
  done
  echo "WARN: NAS /Volumes/虚拟员工工作区 not mounted after 60s; starting server anyway (uploads fail if LOCAL_UPLOAD_DIR points there)" >&2
  return 1
}

start_server() {
  [ -x "$ROOT/server/bin/server" ] || { echo "ERROR: server/bin/server missing -- run a build first" >&2; exit 1; }
  # Prefer the .app-wrapped binary so the process runs under BayClawServer.app's
  # identity (and its FDA / network-volume TCC grant once granted). Falls back to
  # the bare binary if the .app was never created (no FDA setup yet).
  local app_server="$HOME/Applications/BayClawServer.app/Contents/MacOS/server"
  if [ -x "$app_server" ]; then
    say "starting API server via BayClawServer.app (:$PORT, FDA-eligible) -> logs/server.log"
    ( cd "$ROOT" && nohup "$app_server" >> "$LOG_DIR/server.log" 2>&1 & disown )
  else
    say "starting API server (:$PORT) -> logs/server.log"
    ( cd "$ROOT" && nohup ./server/bin/server >> "$LOG_DIR/server.log" 2>&1 & disown )
  fi
}

build_web() {
  if [ "$NO_BUILD" = 1 ]; then
    say "skipping web build (--no-build)"
    return 0
  fi
  say "building web (production: pnpm --filter @multica/web build)"
  ( cd "$ROOT" && pnpm --filter @multica/web build ) || { echo "ERROR: web build failed" >&2; exit 1; }
}

start_web() {
  [ -d "$ROOT/apps/web/.next" ] || { echo "ERROR: apps/web/.next missing -- run a build first" >&2; exit 1; }
  say "starting web (prod, :$FRONTEND_PORT) -> logs/web.log"
  ( cd "$ROOT" && nohup pnpm --filter @multica/web exec next start --port "$FRONTEND_PORT" >> "$LOG_DIR/web.log" 2>&1 & disown )
}

wait_port() {
  local p="$1" name="$2" i
  for i in $(seq 1 60); do
    lsof -ti:"$p" >/dev/null 2>&1 && { say "$name is listening on :$p"; return 0; }
    sleep 1
  done
  echo "WARN: $name did not start listening on :$p within 60s (check logs)" >&2
  return 1
}

status() {
  printf '%-12s %-10s %s\n' "COMPONENT" "PORT" "STATE"
  for pair in "API server:$PORT" "Web dev:$FRONTEND_PORT"; do
    local name="${pair%%:*}" p="${pair##*:}"
    if lsof -ti:"$p" >/dev/null 2>&1; then
      printf '%-12s %-10s %s\n' "$name" "$p" "UP"
    else
      printf '%-12s %-10s %s\n' "$name" "$p" "down"
    fi
  done
  echo
  echo "API health: $(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/health" 2>/dev/null || echo n/a)"
  echo "Fleet endpoint (expect 401 = up+auth-gated): $(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/api/fleet/status" 2>/dev/null || echo n/a)"
}

mkdir -p "$LOG_DIR"

case "$cmd" in
  start)
    build_go
    build_web
    wait_for_pg
    wait_for_nas
    start_server; start_web
    wait_port "$PORT" "API server"; wait_port "$FRONTEND_PORT" "Web dev"
    echo; status
    ;;
  stop)
    stop_all
    say "stopped (Postgres and the agent daemon were left running)"
    ;;
  restart)
    build_go
    build_web
    stop_all
    wait_for_pg
    wait_for_nas
    start_server; start_web
    wait_port "$PORT" "API server"; wait_port "$FRONTEND_PORT" "Web dev"
    echo; status
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: scripts/bayclaw-serve.sh {start|stop|restart|status} [--no-build]" >&2
    exit 2
    ;;
esac
