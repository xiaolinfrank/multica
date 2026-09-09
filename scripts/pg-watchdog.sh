#!/bin/bash
# pg-watchdog.sh —— PostgreSQL / Redis 存活看门狗。
#
# 2026-09-09：生产 PG/Redis 从 colima 容器迁到 brew 原生进程，本脚本由
# colima-pg-watchdog.sh 改名而来，恢复动作也整体降级。
#
# 为什么降级：brew 的 sh.brew.postgresql@17 / sh.brew.redis 两个 LaunchAgent
# 都带 KeepAlive+RunAtLoad，进程崩溃和开机自启已由 launchd 兜住。看门狗只剩
# 一个 launchd 覆盖不到的场景——进程活着但不响应（hang）。所以恢复动作是
# 一条 ~2s 的 brew services restart，而不是过去那条要跑 150s+ 的 colima stop。
#
# 2026-09-07 的教训必须记住：旧版把 `colima restart` 放进 180s 预算里，光 stop
# 就要 150s，必然超时；超时又杀不掉正在开机的 limactl，于是每 5 分钟留下一台
# 半启动的 VM，PG 从 10:42 断到 17:45，看门狗跑了一下午全在打断自己。
# 现在恢复动作是有界的轻量操作，且失败两次就彻底闭嘴留人工——宁可不修，
# 不可越修越坏。
#
# 探测：每 30s，用轮询式 timeout 包裹（macOS 没有 GNU `timeout` 命令，勿用）。
# 触发：连续 3 次失败（~90s+）才动手。冷却：恢复后 300s 内不再动手。
# 日志：logs/watchdog.log（注意不是 plist 里的 launchd-watchdog.log，那个恒为 0 字节）。
ROOT="/Users/fosun_main_agent/var/multica"
LOG="$ROOT/logs/watchdog.log"
THRESHOLD=3        # 连续失败次数
PROBE_INTERVAL=30  # 秒
COOLDOWN=300       # 恢复后冷却秒数（brew restart 很快，不需要旧版的 900s）
GIVEUP=2           # 连续恢复失败这么多次后停止自动恢复，只告警

# postgresql@17 是 keg-only，psql/pg_isready 必须显式加它的 bin。
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/bin:/bin"
# 内部链路走 [::1]：AnyConnect 的回环过滤器会间歇吞 127.0.0.1 的新 SYN。
PGHOST_LOCAL="::1"
PGUSER_LOCAL="multica"

mkdir -p "$ROOT/logs"

# 密码只从 .env 的 DATABASE_URL 取，绝不写死。
load_pw() {
  PGPASSWORD="$(awk -F= '/^DATABASE_URL=/ { sub(/^[^=]*=/, ""); print; exit }' "$ROOT/.env" \
    | sed -E 's|^postgres(ql)?://[^:]+:([^@]*)@.*|\2|')"
  export PGPASSWORD
}
load_pw

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

# run_timed <seconds> <cmd...> —— 后台执行 + 轮询 kill 实现超时（macOS 兼容）。
# 返回命令实际退出码；超时被杀返回 1。
run_timed() {
  local secs="$1"; shift
  "$@" &
  local pid=$!
  local i
  for i in $(seq 1 $((secs * 2))); do
    kill -0 "$pid" 2>/dev/null || { wait "$pid" 2>/dev/null; return $?; }
    sleep 0.5
  done
  pkill -TERM -P "$pid" 2>/dev/null
  kill -TERM "$pid" 2>/dev/null
  sleep 1
  pkill -KILL -P "$pid" 2>/dev/null
  kill -KILL "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  return 1
}

# 真实查询而非 TCP 连通性：hang 住的 PG 照样接受连接。
probe_pg() {
  run_timed 15 psql -h "$PGHOST_LOCAL" -U "$PGUSER_LOCAL" -d multica -tAc 'select 1' >/dev/null 2>&1
}
probe_redis() {
  run_timed 10 redis-cli -h "$PGHOST_LOCAL" PING >/dev/null 2>&1
}

# 恢复：一条有界的 brew services restart，60s 预算绰绰有余。
recover() { # recover <postgresql@17|redis>
  log "restarting brew service: $1"
  run_timed 60 brew services restart "$1" >> "$LOG" 2>&1
}

log "=== watchdog start (brew native PG/redis) ==="

PG_FAIL=0; RD_FAIL=0
PG_LAST=0; RD_LAST=0
PG_GIVEUP=0; RD_GIVEUP=0

while true; do
  # ---- PostgreSQL ----
  if probe_pg; then
    [ "$PG_FAIL" -ne 0 ] && log "PG recovered (was $PG_FAIL fails)"
    PG_FAIL=0; PG_GIVEUP=0
  else
    PG_FAIL=$((PG_FAIL + 1))
    log "PG probe FAILED ($PG_FAIL/$THRESHOLD)"
    if [ "$PG_FAIL" -ge "$THRESHOLD" ]; then
      NOW=$(date +%s)
      if [ "$PG_GIVEUP" -ge "$GIVEUP" ]; then
        log "PG 自动恢复已连续失败 ${GIVEUP} 次，停止自动恢复，留人工介入"
        PG_FAIL=0
      elif [ $((NOW - PG_LAST)) -lt "$COOLDOWN" ]; then
        log "PG in cooldown, skip restart"
        PG_FAIL=0
      else
        recover postgresql@17
        for _ in $(seq 1 15); do probe_pg && break; sleep 2; done
        if probe_pg; then
          log "PG recovery OK"; PG_GIVEUP=0
        else
          PG_GIVEUP=$((PG_GIVEUP + 1)); log "PG recovery 失败 ($PG_GIVEUP/$GIVEUP)"
        fi
        PG_LAST=$(date +%s); PG_FAIL=0
      fi
    fi
  fi

  # ---- Redis ----
  if probe_redis; then
    [ "$RD_FAIL" -ne 0 ] && log "redis recovered (was $RD_FAIL fails)"
    RD_FAIL=0; RD_GIVEUP=0
  else
    RD_FAIL=$((RD_FAIL + 1))
    log "redis probe FAILED ($RD_FAIL/$THRESHOLD)"
    if [ "$RD_FAIL" -ge "$THRESHOLD" ]; then
      NOW=$(date +%s)
      if [ "$RD_GIVEUP" -ge "$GIVEUP" ]; then
        log "redis 自动恢复已连续失败 ${GIVEUP} 次，停止自动恢复，留人工介入"
        RD_FAIL=0
      elif [ $((NOW - RD_LAST)) -lt "$COOLDOWN" ]; then
        log "redis in cooldown, skip restart"
        RD_FAIL=0
      else
        recover redis
        for _ in $(seq 1 15); do probe_redis && break; sleep 2; done
        if probe_redis; then
          log "redis recovery OK"; RD_GIVEUP=0
        else
          RD_GIVEUP=$((RD_GIVEUP + 1)); log "redis recovery 失败 ($RD_GIVEUP/$GIVEUP)"
        fi
        RD_LAST=$(date +%s); RD_FAIL=0
      fi
    fi
  fi

  sleep "$PROBE_INTERVAL"
done
