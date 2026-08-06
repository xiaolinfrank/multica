# BayClaw LAN 卡顿事故复盘与运维手册（2026-08-06）

> 适用范围：BayClaw fork 的服务器中心化局域网部署（本机 Mac mini）。
> 本文档沉淀 2026-08-05 ~ 08-06 的全站间歇性卡顿事故：症状指纹、三层根因、
> 可复用的取证方法、已实施的六项加固、以及当前服务栈的运维手册。

## TL;DR

- **症状**：LAN 用户间歇性"页面能开、数据/JS 资源加载不出"，agent 名显示
  `Unknown Agent`，每次发作 1-2 分钟，时好时坏。
- **真根因**（8-06 11:42）：colima VM（2 vCPU / 4GiB / 无 swap）在持续高负载
  （~45 daemon 心跳 + 200-430 次 DB acquire/15s）下**整体静默冻结**，Postgres
  随之停摆，Go 服务所有 DB 请求挂起；因无任何超时，挂到浏览器/客户端超时
  （8-30s），前端/daemon 重试又放大成请求风暴。
- **独立诱因**（早于主因）：主机 Cisco AnyConnect Socket Filter 系统扩展间歇
  吞掉 `127.0.0.1`（仅 IPv4 回环）的新 TCP SYN，导致部分连接随机 30-75s 挂起。
- **已完成加固**：colima 扩容 + swap、Redis 启用、容器 restart policy、
  Go 快速失败超时、colima 自启 + PG 就绪等待、colima/PG watchdog。
- **复发风险**：high → **low**（VM 冻结触发点消除 + 四层兜底）。

---

## 1. 事故时间线

| 时间（本地） | 事件 |
| --- | --- |
| 08-05 中午 | LAN 用户开始间歇卡顿：页面能开、资源加载不出 |
| 08-05 晚 | 上线 Caddy HTTPS/HTTP2 前置（误判根因是 HTTP/1.1 每 origin 6 连接上限，未治好） |
| 08-06 上午 | 确诊 AnyConnect Socket Filter 吞 `127.0.0.1` 新 SYN → 卸载该系统扩展 |
| 08-06 11:42 | **colima VM 静默冻结**，PG 停摆（8s 卡顿真根因），全站全面卡死 |
| 08-06 12:52 | 用户重启设备；colima 未自启 → PG 没起来 → server fatal → 全站挂 |
| 08-06 13:00-14:30 | 手动恢复服务 + workflow 四路并行深挖 DB 连接问题 |
| 08-06 14:30-15:00 | 完成六项加固并全部部署验证 |

---

## 2. 症状指纹

| 现象 | 指向 |
| --- | --- |
| HTML 能加载，JS chunk / 数据 API 加载不出 | 数据/代理层（Next→Go 或 Go→PG）卡住 |
| agent 名显示 `Unknown Agent` | agent 列表 API 未返回（后端数据其实正常） |
| 间歇性、每次 1-2 分钟 | 某种累积/重试循环，非持续故障 |
| DevTools 显示请求 `pending` + "Provisional headers are shown" | 请求未离开浏览器（本地排队）或连接未建立 |
| 连接建立但 8-30s 才响应/失败 | Go 无超时，挂起直到客户端超时 |
| 恢复时刻积压请求"同一秒批量完成" | 决堤特征：阻塞解除后排队请求集中释放 |

> 早期一度以为是 HTTP/1.1 每 origin 6 连接上限（浏览器本地排队），并为此上了
> Caddy HTTP/2。**这是有效加固但非病根**——排查时不要被"连接排队"表象带偏。

---

## 3. 根因分析（三层）

### 3.1 真根因：colima VM 静默冻结 → PG 停摆

**证据链**（全部实锤）：

- PG 容器日志：最后正常 checkpoint 在 `03:42:28 UTC`（= 11:42 本地），之后
  **戛然而止**；重启恢复时 `database system was not properly shut down`，
  WAL 尾部只写了 ~320 字节（`invalid record length ... got 0`）。
- PG 日志全程**无 OOM / 无 kill / 无错误**；VM 的 journald 在 06:30 后静默
  （无 panic / 无 hung-task 记录）。
- 宿主 macOS 全程醒着：`pmset -g log` 无 sleep/wake、无 jetsam kill、
  无 Virtualization.framework 崩溃报告。
- 综合判定：**整个 VM guest 在 11:42 停止执行**（macOS Virtualization.framework
  的 2 vCPU / 4GiB / 无 swap 虚拟机在高负载下冻结），PG 进程本身没有崩溃。

**触发条件**：持续重负载跑在过小 VM 上——~45 个 daemon runtime 心跳轮询、
~200-430 次 DB acquire/15s、25 连接池反复打满（`empty_acquire_delta` 一度
245/95/137）。2 vCPU 上 checkpoint 写 ~50 buffers 要 5-6s，是明显的 CPU 争用信号。

### 3.2 独立诱因：Cisco AnyConnect Socket Filter（已卸载）

- `systemextensionsctl list` 显示 `com.cisco.anyconnect.macos.acsockext` 处于
  `[activated waiting for user]`（机器并未实际连该 VPN）。
- 该过滤器**间歇吞掉 `127.0.0.1`（仅 IPv4 回环）上的新 TCP SYN**：客户端停在
  `SYN_SENT` 30-75s，而被吞端口随时间漂移（轮番命中 18080 和 13001）。
- **已建立的连接、`::1`（IPv6 回环）、网卡 IP 均不受影响** —— 这就是
  "`127.0.0.1` 慢 / `[::1]` 快" 现象的来源。
- 处理：卸载 AnyConnect 全部模块（`/opt/cisco/anyconnect/bin/anyconnect_uninstall.sh`
  等）+ 系统设置里删除 socket filter 扩展。**彻底解法**：让 IT 卸载该扩展
  （机器不连该 VPN），见 §7。

### 3.3 放大器链（把 PG 停摆放大成 8-30s 全站卡死）

PG 停摆时，请求不是快速失败而是恶性循环：

```
PG 不可达
  → pgxpool 排队，25 连接被挂起查询占满（idle 全是"坏连接"，empty_acquire 暴增）
    → Go http.Server 无任何超时（Read/Write/IdleTimeout 全 0）
      → 挂起的 handler 活到客户端超时（浏览器/Next 8-30s，daemon 30s）
        → Next 代理 socket hang up → 前端/daemon 重试
          → WS 重连触发 ~25 个 query 族全量 refetch（use-realtime-sync.ts）
            → 更多请求 → 池更满 → 恶性循环
```

三个放大器：

1. **Redis 未启用**（`REDIS_URL` 未设）：每次请求都做一次 per-request DB auth
   查询（PAT 查库），claim 也不短路。重启前 auth 就消耗了大量池连接。
2. **Go http.Server 无超时**：挂起请求不释放连接，直到每个客户端自己超时。
3. **前端重连风暴**：WS 断线重连时 `invalidateWorkspaceScopedQueries` 全量
   invalidate ~25 个 query 族（active 的立即 refetch），13:35 的
   `acquire_count_delta=898/30s` 里 130 个 HTTP 请求正是"3 次 WS 重连 refetch"。

---

## 4. 诊断取证方法（可复用）

以下是一套把"间歇卡顿"定位到具体层的取证链，供后续排查参考。

| 手段 | 命令 | 抓到什么 |
| --- | --- | --- |
| 金丝雀探活 | 每 15-30s `curl` 三跳（Caddy→Next→Go）+ PG 快照 | 慢窗口 + 是否全栈级 |
| 半开连接 | `lsof -nP -iTCP:18080` 看 `SYN_SENT` 主人 | 谁在建连失败（回环过滤器） |
| 端口状态 | `netstat -an -p tcp` 按状态计数 | 海量 `TIME_WAIT`/`CLOSING` = 连接 churn 风暴 |
| 进程冻结 | server.log 心跳/HTTP 完成记录是否连续 | Go 进程活着 vs 挂了 |
| PG 停摆 | `docker logs multica-postgres-1` 看 checkpoint 间隔 | 最后 checkpoint 后戛然而止 = VM 冻结 |
| 池压力 | `grep 'db pool' logs/server.log` 看 `empty_acquire_delta` 时间序列 | 触发时刻 + 是否周期爆发 |
| 请求风暴源 | server.log 请求路径计数（`awk` 按 path 聚合） | 谁在疯狂轮询（daemon 心跳 vs 前端） |
| 系统扩展 | `systemextensionsctl list` | AnyConnect 等网络过滤器 |
| 多路径对打 | 同轮压测 `127.0.0.1` / `[::1]` / 网卡 IP | 隔离"回环过滤器" vs 其他 |

> 关键教训：`avg_acquire_ms` 常年 0-1ms 不代表池没问题 —— acquire 快，但
> **SQL 执行**可以卡在冻结的 PG 上。判断要区分"acquire 排队"和"query 挂起"。

---

## 5. 加固措施（已实施）

| # | 加固 | 改动 | 效果 |
| --- | --- | --- | --- |
| 1 | colima 扩容 | `~/.colima/default/colima.yaml` cpu 2→4, memory 4→8, +provision 建 4G swapfile | 消除 VM 冻结触发点（治本） |
| 2 | Redis 启用 | `docker-compose.override.yml` 加 redis + `REDIS_URL` | realtime 切 sharded、PAT/claim/auth 缓存；**稳态 empty_acquire 归零** |
| 3 | 容器自启 | override 设 postgres/redis `restart: unless-stopped` | 修复"重启后全挂"的容器侧根因 |
| 4 | Go 快速失败 | `main.go` ReadHeaderTimeout=10s/IdleTimeout=120s + 新 `internal/middleware/request_timeout.go`（30s，跳过 WS/下载） | PG stall 时 query 30s 快速失败，不再无限挂起 |
| 5 | colima 自启 + PG 等待 | `com.bayclaw.colima.plist` + `scripts/colima-boot.sh`；`bayclaw-serve.sh` 加 `wait_for_pg` | 重启后 colima/PG/server 自动恢复时序 |
| 6 | watchdog | `scripts/colima-pg-watchdog.sh` + `com.bayclaw.watchdog.plist` | VM 再冻结时 ~2min 自动恢复（原 70min 人工） |

**关键实现细节**：

- `pgxpool.Config` **没有** `AcquireTimeout` 字段 —— acquire 超时只能靠调用方
  context。所以快速失败靠 middleware 给 `r.Context()` 加 deadline。
- **macOS 没有 GNU `timeout(1)` 命令** —— watchdog 的探测/重启超时必须用
  "后台执行 + 轮询 `kill -0` + 超时 kill" 实现，直接写 `timeout 15 docker exec`
  会 `command not found` 导致误判。
- `http.Server` 的 `ReadTimeout`/`WriteTimeout` **不能加**（会杀 WebSocket 长连接
  和上传）——只加 `ReadHeaderTimeout` + `IdleTimeout`。

---

## 6. 服务栈与运维手册

### 6.1 架构

```
用户浏览器
   │ https://10.35.178.181:13000  (或 10.35.182.19)
   ▼
Caddy (HTTPS/HTTP2, :13000, launchd)   ← 自签名 tls internal，http 自动 308 跳 https
   │ reverse_proxy [::1]:13001
   ▼
Next.js (prod, :13001, 仅回环, bayclaw-serve.sh)   ← 兼应急后门
   │ rewrite → http://[::1]:18080
   ▼
Go API (Chi, :18080, bayclaw-serve.sh)
   │ pgxpool → 127.0.0.1:5432
   ▼
colima VM (docker) → postgres 容器 + redis 容器
```

> **内部链路一律走 `[::1]`（IPv6 回环）**：`.env` 的 `REMOTE_API_URL` 和
> Caddyfile 的 `reverse_proxy [::1]:13001`。这是当年绕过回环过滤器的决定，
> 现在 AnyConnect 已卸载，仍保留（IPv6 回环本身也更快更稳）。

### 6.2 进程 / 容器 / 自启

| 组件 | 托管方式 | 自启 |
| --- | --- | --- |
| colima | `com.bayclaw.colima`（colima-boot.sh，RunAtLoad+重试） | ✅ |
| postgres / redis | docker（restart: unless-stopped） | ✅（colima 起后自动恢复） |
| server / web | `com.bayclaw.serve`（登录时跑 `bayclaw-serve.sh start --no-build`，含 `wait_for_pg`） | ✅ |
| Caddy | `com.bayclaw.caddy`（RunAtLoad+KeepAlive） | ✅ |
| watchdog | `com.bayclaw.watchdog`（KeepAlive） | ✅ |
| runner daemons | `com.bayclaw.runner-bio/clinical` | ✅ |

> 重启顺序依赖：colima（含 PG/redis）→ server/web（`wait_for_pg` 保证）→ Caddy。

### 6.3 watchdog 行为

- 每 30s `docker exec ... psql select 1`（15s 轮询超时）。
- 连续 3 次失败（~90s）→ `colima restart` + `docker compose up -d` + 等 PG 回来。
- 重启后 5min 冷却，防循环。日志 `logs/watchdog.log`。
- **best-effort**：VM 冻结时 colima 命令本身可能受影响，失败仅记录待人工。

### 6.4 常用检查命令

```bash
bash scripts/bayclaw-serve.sh status          # server/web 端口 + 健康
docker ps                                      # PG/redis 容器
colima status                                  # VM 状态
grep 'db pool' logs/server.log | tail          # 池压力（empty_acquire_delta）
tail -5 logs/watchdog.log                      # watchdog 探测
tail -20 logs/caddy-access.log                 # 访问日志（自轮转）
```

### 6.5 故障恢复

```bash
# 服务全挂 / 卡死时的恢复顺序：
launchctl kickstart -k gui/501/com.bayclaw.colima   # 确保 colima
docker ps && docker start multica-postgres-1 multica-redis-1   # 确保容器
nohup bash scripts/bayclaw-serve.sh restart --no-build >> logs/restart.log 2>&1 &
```

> **重启脚本卡住时先想 colima/PG，不是脚本问题**：如果 PG 不可达，server 起来
> 会 fatal 退出；`wait_for_pg` 只在脚本管理的 start/restart 生效。

---

## 7. 残留风险与待办

- **AnyConnect 彻底卸载**（请 IT）：socket filter 扩展虽已删除，但 AnyConnect
  应用残留 `/Applications/Cisco`、`/opt/cisco` 已清，建议 IT 层面确保无其他
  网络过滤组件。
- **query 级 deadline 未做**（broad 重构）：当前是 middleware 的 request 级 30s
  deadline。若要对"已建立的坏连接上挂起的查询"更快失败，需 handler 层给每个
  DB 查询单独设 context deadline —— 因涉及全部 handler，暂未做。
- **WS 重连 refetch 收窄未做**：`invalidateWorkspaceScopedQueries` 仍全量
  invalidate。Redis + 超时已让 DB 压力不构成瓶颈，此项留给前端性能优化。
- **观察**：金丝雀监控用户链路（>5s 报警），若再出现卡顿应能第一时间定位。
