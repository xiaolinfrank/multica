# R3：单向棘轮夹死点释放（取消放宽 + unstart/unschedule）

状态：**已实现，待 agent 3 验收**。依据[设计总纲](./design-principles-2026-10-12.md)原则 2（确认可逆），取代 [meeting-lifecycle-contract](./meeting-lifecycle-contract.md) §5 中「started 不可取消、schedule/start 无回退」的条款。

## 缺口

R1/R2 之后仍存三个夹死点：

1. **in_progress 不能取消**——`guard_cockpit_meeting_preparation_fact` 触发器与取消预览双重拒绝「已开始的会议按未召开取消」。现实中会议开到一半取消是正常事件，被逼着先 end 再 reopen 再 cancel（三步替代一步）。
2. **确认开始无回退**——误点「确认开始」后没有回退路径，只能前进到 end。
3. **确认安排无回退**——schedule 误确认后只能取消重来（丢失处置上下文）。

## 命令语义

| 命令 | 前置 | 结果 | 清除 | 保留 | 例外 |
| --- | --- | --- | --- | --- | --- |
| `unstart` | `in_progress`；reason 必填 | → `scheduled` | started_confirmed_at/by、**actual_started_at** | ended 三件（必空）、台账 | 会议确实已开始时走 correct_times/end，不走本命令（hint 明示） |
| `unschedule` | `scheduled` 且 started/ended 确认为空；reason 必填 | → `unconfirmed` | 仅 occurrence_state | actual_started_at（reopen 留下的事实）与一切已记录事实 | started 事实存在时先 unstart |
| `cancel`（放宽） | `unconfirmed/scheduled/**in_progress**/cancelled` | → `cancelled` | —— | 全部事实 | `ended` 仍需先 reopen（纪要结论在 ended 上，先撤结论再取消） |

设计要点：
- **撤哪步确认清哪步事实**：unstart 清 actual_started_at（它是「已开始」前提下记录的推论）；对照 reopen 清 actual_ended_at 而保留 actual_started_at（撤的是结束不是开始）——两者对称自洽。
- unstart 后 `schedule` 守卫（要求 actual 时间为空）自然重新满足，`scheduled → unconfirmed → schedule → start` 全链路可循环。
- ended → cancelled 必须绕行 reopen，理由与 R2 一致：ended 承载纪要结论层，直接取消会把「发生过且有结论」压成「未召开」；reopen 先显式撤回结论再取消，台账两次留痕。
- 逆向命令全部走既有幂等协议（command_key 台账、reason ≤16000、previous_occurrence 快照），无新表无新列，仅触发器函数放宽（迁移 9148）。

## 实现

- **9148 迁移**：`guard_cockpit_meeting_preparation_fact` 的取消前置从 `unconfirmed/scheduled/cancelled` 放宽加入 `in_progress`；错误消息改为「An ended meeting must be reopened before…」。
- **服务层** `cockpit_meeting_lifecycle.go`：`applyMeetingOccurrence` 加 `unstart`/`unschedule` case；`lifecycleHeader` 能力位补 `can_reopen`（R2 借用 can_correct_times 的债一并修正）、`can_unstart`、`can_unschedule`。
- **取消路径** `cockpit_cancellation.go` + `cockpit_meeting_disposition.go`：blocked reason `meeting_already_started` → `meeting_ended_reopen_first`（仅 ended 挡）。
- **前端**：lifecycle 组件加「更正开始确认/更正安排确认」按钮（能力位 gating、reason 必填、无时间字段）；preparation preview 加新 reason 文案；四语 5 key。
- **schema 顺带修复**：`CockpitLifecycleCommandResultSchema` 的 refine 矩阵漏了 `reopen`（R2 遗留——HTTP 非 secure context 下前端命令链路未暴露，验收时以 API 直验代替），本次连同 `unstart`/`unschedule` 一并补上（receipt.occurrence 非空 + reason 非空 + previous_occurrence 非空）。

## 验收

- 本机：`TestCockpitLifecycleUnstartUnschedule`、`TestCockpitInProgressCancellation`（含 ended blocked reason 断言）通过；service 全量仅既证 collation 差异；handler `TestCockpit*` 全绿；core 17/17 + 新增 ack 用例；views lifecycle 组件 7/7。core/views 全量失败集与 HEAD 基线逐一对账一致（预存在）。
- agent 3：见 implementation-status.md 验收记录。
