#!/bin/bash
# colima-pg-watchdog.sh —— PG/colima 存活看门狗（best-effort 自动恢复）。
#
# 背景：2026-08-06 colima VM 在高负载下静默硬冻结（VM 进程不退出、只是不
# 执行），PG 随之停摆 70 分钟直到人工重启设备。VM 扩容 + Redis + Go 30s
# request deadline 已大幅降低概率与影响，但 VM 仍可能冻结；本脚本在 PG 连续
# 不可达时 best-effort 重启 colima，把"人工介入 70 分钟"缩到"自动恢复 ~2 分钟"。
#
# 探测：每 30s 用轮询式 timeout（macOS 没有 GNU `timeout` 命令，勿用）
# 包裹 docker exec psql select 1 —— VM 冻结时 docker exec 会 hang，15s 后
# 判失败。触发：连续 3 次失败（~90s+）才重启，避免短暂抖动误判。
# 冷却：重启后 5 分钟内不再重启，防循环。
# 可靠性：VM 冻结时 colima restart 本身可能受影响，属 best-effort；失败则
# 仅记录，留人工介入。日志：logs/watchdog.log。
#
# 启用：~/Library/LaunchAgents/com.bayclaw.watchdog.plist（KeepAlive 持续运行）。
ROOT="/Users/fosun_main_agent/var/multica"
LOG="$ROOT/logs/watchdog.log"
THRESHOLD=3        # 连续失败次数
PROBE_INTERVAL=30  # 秒
COOLDOWN=300       # 重启后冷却秒数
LAST_RESTART=0
FAIL=0

mkdir -p "$ROOT/logs"

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
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  return 1
}

# probe_pg —— 真实 PG 查询，15s 内无响应判失败。
probe_pg() {
  run_timed 15 docker exec multica-postgres-1 psql -U multica -d multica -tAc 'select 1' >/dev/null 2>&1
}

echo "=== watchdog start $(date '+%F %T') ===" >> "$LOG"

while true; do
  if probe_pg; then
    [ "$FAIL" -ne 0 ] && echo "$(date '+%F %T') PG recovered (was $FAIL fails)" >> "$LOG"
    FAIL=0
  else
    FAIL=$((FAIL + 1))
    echo "$(date '+%F %T') PG probe FAILED ($FAIL/$THRESHOLD)" >> "$LOG"
    if [ "$FAIL" -ge "$THRESHOLD" ]; then
      NOW=$(date +%s)
      if [ $((NOW - LAST_RESTART)) -lt "$COOLDOWN" ]; then
        echo "$(date '+%F %T') in cooldown, skip restart" >> "$LOG"
        FAIL=0
      else
        echo "$(date '+%F %T') PG unreachable ${THRESHOLD}x — restarting colima (best-effort)" >> "$LOG"
        # colima restart 正常需 60-120s，给 180s 上限；失败仅记录
        run_timed 180 colima restart >> "$LOG" 2>&1 || echo "$(date '+%F %T') colima restart failed/timed out" >> "$LOG"
        sleep 20
        (cd "$ROOT" && run_timed 60 docker compose up -d) >> "$LOG" 2>&1 || true
        # 等 PG 回来
        for i in $(seq 1 30); do
          probe_pg && break
          sleep 2
        done
        LAST_RESTART=$(date +%s)
        FAIL=0
        echo "$(date '+%F %T') recovery attempt complete" >> "$LOG"
      fi
    fi
  fi
  sleep "$PROBE_INTERVAL"
done
