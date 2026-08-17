# BayClaw 邮件子系统

> 适用范围：复星医药大湾区 BayClaw 平台的出站邮件（欢迎邮件 + 收件箱通知 + 收件箱每日摘要 + 个人专属验证码）。
> 最后更新：2026-08-17

## 1. 概述

BayClaw 通过 `server/internal/service/email.go` 的 `EmailService` 发三类邮件：

| 邮件 | 函数 | 触发时机 |
| --- | --- | --- |
| 欢迎 / 验证码邮件 | `SendWelcomeEmail(to, code string)` | 用户注册 / 申请验证码 |
| 收件箱通知（逐条转发） | `SendInboxItemEmail(to, InboxEmailInput)` | 收件箱产生 @提及 / 评论 / 指派等事件（由 `cmd/server/notification_listeners.go` 调用；`INBOX_EMAIL_FORWARD=false` 时禁用） |
| 收件箱每日摘要 | `SendInboxSummaryEmail(to, InboxSummaryEmailInput)` | 每天 09:00 Asia/Shanghai，`internal/scheduler` 的 `inbox_email_digest` 任务（`INBOX_EMAIL_DIGEST=true` 时启用） |

两套收件箱模板**共用同一套品牌外壳**：青→蓝渐变头 + 320px 圆角徽章公仔 + 底部复星医药大湾区总部 logo。

发信通道优先级一致：**SMTP 中继 → Resend API → DEV stdout**（无 SMTP/Resend 时仅打印，不报错）。

## 1.1 收件箱每日摘要（2026-08-17 新增，与逐条转发平行）

逐条转发因发信频率过高已被 `INBOX_EMAIL_FORWARD=false` 停用（代码保留）。替代的降噪机制：

- **调度**：`server/internal/scheduler/jobs_inbox_digest.go`，job 名 `inbox_email_digest`，挂在 DB 调度器（`sys_cron_executions` 表）上，每天 **09:00 Asia/Shanghai** 跑一次。`PlansForScope` 钩子计算当天边界（时区写死，不用 time.Local）。
- **内容**：查过去 7 天内"未读且未归档"的收件箱条目（sqlc `ListUnreadInboxForDigest`），**按 issue 分组去重后每用户每天汇总成一封**邮件（`aggregateDigest`：跨工作区分节、每工作区最多列 8 条+溢出计数、节与条目均按时间倒序）。
- **未读口径**：与收件箱 UI（`CountUnreadInboxByWorkspace`）一致——每组只看最新一条，`NOT EXISTS(组内更新条目)` 保证"打开过 issue 的旧未读兄弟条目"不会复活进摘要。
- **静音**：沿用 per-(工作区,用户) 的 `notification_preference.preferences["email"]=="muted"` 门控（缺省=发送）。
- **幂等**：靠 `sys_cron_executions` 的 (job, scope, plan_time) 唯一键；重启/多实例不会重发。**故意不重试**（MaxAttempts=1）：邮件按人不幂等，部分成功后重试会给已收到的人重发；漏一天无损失（窗口滚动 7 天）。
- **无未读则零发信**：查询空集直接返回，不发任何邮件。
- 开关：`.env` 的 `INBOX_EMAIL_DIGEST=true`（默认关，注册在 `main.go` 调度器初始化处）。

## 2. 关键设计决策

### 2.1 内联图用 `data:` URI，不用 CID
两张品牌图（`assets/bayclaw_mascot_email.png`、`assets/fosun_pharma_gba_hq_email.png`）经 `//go:embed` 读入，转成 `data:image/png;base64,...` 直接写进 HTML。
**原因**：早期用 `multipart/related` + `cid:` 内嵌图时，Exchange/Outlook 会把内嵌图当成附件、显示为「Insert 01 / Insert 02」标签。改成单 part `text/html` + data URI 后，该标签消失，且内网无图床也能自包含渲染。

### 2.2 公仔不做抠图，用圆角徽章
公仔原图自带浅灰蓝渐变背景。不抠图（抠图易出白边/光晕），而是 `border-radius:42px` + 双层柔和投影（`0 18px 44px` + `0 6px 14px`）做成精致圆角徽章浮在渐变头上。
定稿尺寸：**320×320**（2026-08-14 定稿，曾 84→96→140→200→260→320 多轮调整）。

### 2.3 收件箱通知 deep link 格式（重要）
「查看详情」按钮指向 `InboxEmailInput.DeepLink`，由调用方 `notification_listeners.go` 拼接：
```
base = FRONTEND_ORIGIN + "/" + ws.Slug + "/inbox"
有 IssueID → base + "?issue=" + issueID
无 IssueID → base
```
该格式与前端 `apps/web/components/web-notification-bridge.tsx` 的 canonical 拼法（`${paths.workspace(slug).inbox()}?issue=${id}`）完全一致，点击可直接定位到具体消息。
> ⚠️ 早期曾错误地拼成 `FRONTEND_ORIGIN + "/issues/" + issueID`（无 slug），与前端路由不符，已在 2026-08-14 修正。

## 3. 收件箱通知类型标签

`inboxTypeLabel(type)` 把内部 snake_case 类型映射为中文药丸标签：

| 输入（含别名） | 显示 |
| --- | --- |
| `mention` / `mentioned` / `at` | 提及 |
| `comment` / `reply` | 评论 |
| `assignment` / `assigned` / `assign` | 指派 |
| `invite` / `invitation` | 邀请 |
| `quick_create_done` / `created` / `done` | 创建完成 |
| `issue_subscribed` / `subscribed` | 关注更新 |
| `system` | 系统通知 |
| `due` / `deadline` | 截止提醒 |
| `approval` / `approve` | 待审批 |
| 其他 / 空 | 新通知 |

`InboxEmailInput{WorkspaceName, Title, Body, Type, DeepLink}` 中 workspace/title/body/type 为用户可控字段，全部 `html.EscapeString` 转义；subject 走 `sanitizeSubjectField` 防注入。

## 4. 个人专属永久验证码（MULTICA_PERSONAL_CODES）

`.env` 的 `MULTICA_PERSONAL_CODES` 是官方「个人专属永久码」机制：

- 格式：`email:6位码,email:6位码,...`（当前共 **32 条**，含 huangpeilin 等真实用户及系统/测试账号）。
- 行为：命中即视为验证码通过，**复用、永不过期、绕过单次 `verification_code` 生命周期**（见 `handler/auth.go` 的 `personalVerificationCodeForEmail` / `isPersonalVerificationCode` / `VerifyCode`）。
- 生效条件：**仅非 production 生效**（`APP_ENV` 为空即激活；生产环境自动忽略）。
- 校验接口：`POST /auth/verify-code` `{"email","code"}`，个人码命中返回 200 + JWT。

> 黄沛霖：`huangpeilin@fosunpharma.com:028691`。其余 31 条见 `.env`。

## 5. SMTP 发信配置

走 Gmail 中继，经本地代理 `127.0.0.1:7897`：
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587            (STARTTLS)
SMTP_USERNAME=huangplinfrank@gmail.com
SMTP_FROM_EMAIL=huangplinfrank@gmail.com
HTTP_PROXY / HTTPS_PROXY / ALL_PROXY=http://127.0.0.1:7897
```
> 内网直连 `github.com:443` 被 reset，但发信走 Gmail + 回环代理正常。代理必须存活（curl 探活：能连 7897 即在线）。

## 6. 发测试邮件的标准姿势（不重启 server）

`go test` 从**当前源码**编译 `EmailService` 发信，不依赖运行中 server，可即时验证模板改动：

1. 临时写一个 `server/internal/service/zz_tmp_*.go` 测试：
   ```go
   func TestZZTmpSendXxx(t *testing.T) {
       to := os.Getenv("BAYCLAW_TEST_EMAIL")
       if to == "" { t.Skip("BAYCLAW_TEST_EMAIL not set") }
       s := NewEmailService() // 无参，全部从 env 读 SMTP
       // 欢迎：s.SendWelcomeEmail(to, "028691")
       // 通知：s.SendInboxItemEmail(to, service.InboxEmailInput{...})
       // 摘要：s.SendInboxSummaryEmail(to, service.InboxSummaryEmailInput{...})
   }
   ```
2. 跑（`.env` 已 source）：
   ```bash
   cd multica && set -a; source ./.env; set +a
   export BAYCLAW_TEST_EMAIL=huangpeilin@fosunpharma.com
   cd server && go test ./internal/service/ -run TestZZTmpSendXxx -count=1 -v
   ```
3. 跑完即删临时文件，保持仓库干净（`git status` 应无新增）。

### 6.1 取验证码（host 无 psql）
本机未装 `psql`，PG 在 colima 容器里：
```bash
docker exec -i multica-postgres-1 psql -U multica -d multica -t -A \
  -c "INSERT INTO verification_code (email, code, expires_at) VALUES ('huangpeilin@fosunpharma.com','$CODE', now()+interval '10 minutes') RETURNING code;" \
  | head -1 | tr -d '[:space:]'
```
> ⚠️ `psql ... RETURNING` 会多输出一行状态 `INSERT 0 1`，必须 `| head -1` 只取首行，否则验证码区会混入「INSERT 0 1」导致收件人无法使用。

## 7. 运维：server 重启与 codesign 坑

修改 `email.go` / `notification_listeners.go` 后，必须 **rebuild + 重启** 运行中的 server 才能生效（dev 发信测试只是从源码编译，不影响线上）。

### 7.1 重启的正确姿势（避开 codesign Bus error）
- **坑**：`scripts/bayclaw-serve.sh` 的 `start_server` 优先用 `~/Applications/BayClawServer.app/Contents/MacOS/server`（.app 包装二进制）。codesign 重签可能触发 **Bus error，让新进程卡死且 `kill -9` 也杀不掉**。
- **正解**：直接用**裸二进制** `server/bin/server`（与 `com.bayclaw.server.plist` 的 `exec` 一致），完全绕开 .app/codesign：
  ```bash
  cd multica && set -a; source ./.env; set +a
  ./server/bin/server            # 前台验证能起；后台请用下方后台任务方式
  ```
- **让后台进程跨工具调用存活**：本沙箱里 `launchctl load/bootstrap` 对 launchd 域被限制（I/O error），`setsid` 也不可用；普通 `nohup ... &` 会被工具清理杀掉。可靠做法是走 Bash 工具的 **`run_in_background`** 起 server（系统托管，进程脱离工具 shell 存活）。
- 构建输出：`make build` 或 `cd server && go build -o bin/server ./cmd/server` → `server/bin/server`。

### 7.2 验证重启成功
```bash
lsof -nP -iTCP:18080 -sTCP:LISTEN        # 应监听 IPv6 *:18080
curl -s -o /dev/null -w '%{http_code}' http://localhost:18080/health   # 期望 200
# 确认进程是裸二进制（路径不应含 .app）：
lsof -p $(lsof -ti:18080|head -1) | grep 'txt.*server'
# 验证个人码已加载：
curl -s -X POST localhost:18080/auth/verify-code \
  -d '{"email":"huangpeilin@fosunpharma.com","code":"028691"}'   # 期望 200 + JWT
```

## 8. 已知限制 / 待办
- 欢迎邮件正文仍写「验证码 10 分钟内有效」，对永久个人码不准确，尚未为个人码路径单独去掉时限话术。
- 收件箱逐条转发（`SendInboxItemEmail`）保留但被 `INBOX_EMAIL_FORWARD=false` 停用；生产通知渠道以每日摘要为准。
- 摘要查询 `ListUnreadInboxForDigest` 暂无专用索引（全局 `read=false AND archived=false` + `NOT EXISTS` 关联子查询）；当前数据量下每天一次全表扫可忽略，若未来 inbox_item 增长明显可加 fork 迁移（900-999 区间，单语句 `CREATE INDEX CONCURRENTLY`）。
- 32 条个人码中含测试/合成账号（`@owner-lookup.test`、`plugin-e2e-*`、`fixedcode-test` 等），如需仅保留真实用户可一键从 `.env` 剔除。
