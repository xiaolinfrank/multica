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
}

start_server() {
  [ -x "$ROOT/server/bin/server" ] || { echo "ERROR: server/bin/server missing -- run a build first" >&2; exit 1; }
  say "starting API server (:$PORT) -> logs/server.log"
  ( cd "$ROOT" && nohup ./server/bin/server >> "$LOG_DIR/server.log" 2>&1 & disown )
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
