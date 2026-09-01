#!/bin/bash
# 开发同步验证流程（协调机 -> fosun_agent_3 开发栈）
#
# 约定：本机(协调机)开发 -> ./scripts/dev-node-sync.sh 验证 -> 通过后才动本机生产。
#
# 用法:
#   scripts/dev-node-sync.sh [sync|restart|tunnel|verify|full]
#     sync    只 rsync 代码+二进制到 agent_3
#     restart 远程重启 dev 栈
#     tunnel  确保协调机侧 ssh 隧道(localhost:23000=web, 28080=server)
#     verify  走隧道做 health+登录端到端验证
#     full    sync + restart + tunnel + verify（默认）
#
# agent_3 仅开放 ssh 22 入站(设备管控),web/server 通过隧道访问:
#   开发页面:  http://localhost:23000/{slug}/...   dev code: 831204
#   dev 栈配置: agent_3 ~/var/multica-dev/.env (DB=协调机 :5433 dev 容器,与生产 :5432 隔离)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST=fosun_agent_3
REMOTE_DIR='~/var/multica-dev'
LOCAL_WEB_PORT=23000
LOCAL_API_PORT=28080

do_sync() {
  echo "==> rsync repo -> $HOST:$REMOTE_DIR"
  rsync -a --delete \
    --exclude .git --exclude apps/web/.next/cache --exclude logs \
    --exclude .env --exclude dev-run.sh --exclude 'server/bin' --exclude 'node_modules/.cache' \
    --exclude .DS_Store \
    "$ROOT/" "$HOST:$REMOTE_DIR/"
  # server 二进制单独传(排除目录后补)
  rsync -a "$ROOT/server/bin/server" "$ROOT/server/bin/migrate" "$HOST:$REMOTE_DIR/server/bin/" 2>/dev/null || \
    { ssh "$HOST" "mkdir -p $REMOTE_DIR/server/bin"; rsync -a "$ROOT/server/bin/server" "$ROOT/server/bin/migrate" "$HOST:$REMOTE_DIR/server/bin/"; }
}

do_restart() {
  echo "==> restart dev stack on $HOST"
  ssh -o ConnectTimeout=10 "$HOST" "$REMOTE_DIR/dev-run.sh restart" || true
  sleep 3
}

do_tunnel() {
  if nc -z -w 1 localhost "$LOCAL_WEB_PORT" 2>/dev/null; then
    echo "==> tunnel already up (:$LOCAL_WEB_PORT)"
    return
  fi
  echo "==> opening ssh tunnel :$LOCAL_WEB_PORT(web) :$LOCAL_API_PORT(server)"
  nohup ssh -N -L "$LOCAL_WEB_PORT:127.0.0.1:13000" -L "$LOCAL_API_PORT:127.0.0.1:18080" "$HOST" \
    > /tmp/agent3-tunnel.log 2>&1 &
  disown
  sleep 2
}

do_verify() {
  s=$(curl -s --noproxy '*' -m 8 -o /dev/null -w '%{http_code}' "http://localhost:$LOCAL_API_PORT/health")
  w=$(curl -s --noproxy '*' -m 8 -o /dev/null -w '%{http_code}' "http://localhost:$LOCAL_WEB_PORT/login")
  code=$(curl -s --noproxy '*' -m 8 "http://localhost:$LOCAL_WEB_PORT/api/config" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin)["server_version"])' 2>/dev/null || echo '?')
  echo "server=$s web=$w version=$code"
  [ "$s" = "200" ] && [ "$w" = "200" ] && echo "VERIFY OK (dev code 831204 登录入口: http://localhost:$LOCAL_WEB_PORT/login)" || { echo "VERIFY FAILED"; exit 1; }
}

case "${1:-full}" in
  sync) do_sync ;;
  restart) do_restart ;;
  tunnel) do_tunnel ;;
  verify) do_tunnel; do_verify ;;
  full) do_sync; do_restart; do_tunnel; do_verify ;;
esac
