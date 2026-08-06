#!/bin/bash
# 重启后自启 colima（docker runtime，host PG 容器）。
# colima CLI 是客户端，start 完成即退出，所以不能靠 KeepAlive —— 本脚本由
# ~/Library/LaunchAgents/com.bayclaw.colima.plist 在登录时 RunAtLoad 执行一次，
# 内部轮询 VM 状态并重试，直到 colima 真正 running 或 12 次尝试耗尽。
# 日志：logs/colima-boot.log（覆盖每次登录）。
LOG="/Users/fosun_main_agent/var/multica/logs/colima-boot.log"
COLIMA=/opt/homebrew/bin/colima
echo "=== colima-boot $(date '+%F %T') ===" >> "$LOG"
for i in $(seq 1 12); do
  if "$COLIMA" status 2>/dev/null | grep -q 'running'; then
    echo "colima already running (attempt $i)" >> "$LOG"
    exit 0
  fi
  echo "attempt $i: colima start" >> "$LOG"
  "$COLIMA" start >> "$LOG" 2>&1
  sleep 10
done
echo "colima-boot gave up after 12 attempts" >> "$LOG"
exit 0
