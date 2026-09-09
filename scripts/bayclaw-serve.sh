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
# Postgres and Redis are macOS-native brew services (postgresql@17 / redis)
# since the 2026-09-09 cutover, not colima containers; they and the agent
# daemon are left untouched -- the daemon reconnects after the server restarts.
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

# --- native datastore client (colima -> brew cutover, 2026-09-09) -----------
# 钉死 keg 绝对路径而不是信 PATH：launchd 走 `zsh -lc` 时 homebrew 在 PATH 上，
# 但 agent/cron/`sh -c` 上下文未必有。而裸 `pg_isready` 命令不存在时的失败形态，
# 与「数据库真的挂了」一模一样——正是让备份 L2 层静默失效 3 周的那种形状。
# 顺带钉住 17 大版本：将来 brew link postgresql@18 不会把探针悄悄换掉。
PG_ISREADY_BIN="${PG_ISREADY_BIN:-/opt/homebrew/opt/postgresql@17/bin/pg_isready}"

say() { printf '==> %s\n' "$*"; }

# require_pg_client —— 探针二进制缺失时拒绝往下走。
# 必须由 case 分支首行调用，绝不能塞进 wait_for_pg：restart 里 wait_for_pg 是在
# stop_all 之后才跑的，在那里硬退出等于把「二进制找不到」变成「生产停机」。
require_pg_client() {
  [ -x "$PG_ISREADY_BIN" ] && return 0
  echo "ERROR: pg_isready 不在 $PG_ISREADY_BIN" >&2
  echo "       PG 现在是原生 brew postgresql@17，不再是容器 multica-postgres-1。" >&2
  echo "       修：brew install postgresql@17，或 PG_ISREADY_BIN=/path/to/pg_isready $0 ..." >&2
  echo "       没有探针就分不清『PG 还在启动』和『PG 没了』，拒绝改动正在跑的部署。" >&2
  exit 1
}

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

# Wait for Postgres before starting the Go server. 2026-09-09 起 PG 是原生
# brew postgresql@17（launchd sh.brew.postgresql@17），同时监听 [::1]:5432 与
# 127.0.0.1:5432。已无 docker。
#
# 探测顺序：先 ::1，因为那正是 server 走的路径——DATABASE_URL 写 localhost，
# 本机 pgx 先解析到 ::1；且 IPv6 回环对 Cisco AnyConnect 的 acsockext 过滤器免疫
# （它会间歇吞掉发往 127.0.0.1 的新 SYN，那次 hang 曾在 stop_all 之后卡死 restart，
# 站点已经停了却一直等）。再退回 127.0.0.1，以便 v4-only 监听也能被认出来。
#
# 超时：每次探测由 `-t 2` 限住，整个循环由挂钟 deadline 限住，所以 60s 是真上限。
# 旧版的 `docker exec` 完全没有边界，VM 冻结时会永远挂着。
wait_for_pg() {
  local started deadline host
  started="$(date +%s)"; deadline=$((started + 60))
  say "waiting for Postgres (native brew postgresql@17) ..."
  while :; do
    for host in ::1 127.0.0.1; do
      if "$PG_ISREADY_BIN" -q -h "$host" -p 5432 -U multica -d multica -t 2; then
        say "Postgres ready on [$host]:5432 (after $(( $(date +%s) - started ))s)"
        return 0
      fi
    done
    [ "$(date +%s)" -lt "$deadline" ] || break
    sleep 1
  done
  echo "WARN: Postgres 在 60s 内未就绪（[::1] 与 127.0.0.1 都不通）；仍继续启动 server" >&2
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
    require_pg_client
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
    require_pg_client
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
