# R2 实施合同：结论层四个双向命令（2026-10-12）

依据[设计总纲](./design-principles-2026-10-12.md)原则 2。取代各契约中被注记的终态条款（见总纲取代关系表）。

## 迁移 9147（已应用：本机 624 库、agent 3 dev 与 multica_test）

- `guard_cockpit_meeting_end_fact` 放宽：允许 OLD→NULL（reopen 清空），仍禁止替换为不同时间戳（防悄悄改写）。
- `cockpit_meeting_action.previous_resolutions JSONB NOT NULL DEFAULT '[]'`——改判时旧决议追加为 trail（事件层）。
- `cockpit_acceptance_definition.approval_revoked_at/by/reason`——撤销审计；`last_approved_request_id` 指针可清空（needs_reacceptance 为投影，非列）。
- `cockpit_minutes_version.unpublished_at/by/reason`——下线审计；`published_at` 保留（曾发布事实），重新发布时清空 unpublished 字段并允许指针重指。

## 四命令语义

| 命令 | 前置 | 写入 | 副作用纪律 |
| --- | --- | --- | --- |
| reopen（transition） | occurrence=ended，reason 必填 1–16000 | ended→scheduled，清 ended_at/by/source（台账留 previous_occurrence 快照） | 兼容后续取消（scheduled 可取消）；已启动纪要任务的执行门禁随投影收紧 |
| revise_resolution | action ∈ accepted/dismissed，新决议+原因 | previous_resolutions 追加旧决议；当前决议覆盖 | 此前 create 建立的任务保留（普通 issue）；dismiss→create 正常建任务 |
| revoke_approval | 该 request = 当前 last_approved 指针，reason 必填 | 指针置空 + revoked 审计列 | 历史 request 行不改；重新验收通过后指针自然前移 |
| unpublish | 该版本 = 当前 published 指针，reason 必填 | version 写 unpublished 审计；会议 published 指针置空（CAS） | NAS 文件不动；可重新发布同版本或另一 approved 版本 |

## 命令通道

- reopen：现有 lifecycle occurrence 通道（transition 值新增）。
- revise：POST /workflow/actions/{actionId}/revise。
- revoke：POST /nodes/{id}/acceptance/revoke。
- unpublish：POST /workflow/versions/{versionId}/unpublish（compact 回执 action "unpublished"）。

## 实施状态（2026-10-12）

**全栈完成**（四路并行实现 + 共享层 + 集成验证）：

- 共享层：迁移 9147（触发器放宽 + 4 组新列）、SQL 四组查询、路由三条（revise/revoke/unpublish；reopen 走既有 transition 通道）、core 通道（transition 联合、命令联合 "unpublished"、revise/revoke/unpublish 三 mutation、ApiClient 补 bind/unbind/focus 真实方法）、语言包 17 key 四语。
- reopen：applyMeetingOccurrence case "reopen"（ended→scheduled，清 ended_at/by/source + actual_ended_at，保留 actual_started_at，reason 必填）；台账含 previous_occurrence 快照；reopen 后可正常取消会议；UI 复用 transition 对话框。
- revise_resolution：ReviseCockpitMeetingActionResolution（context marker 区分 resolve/revise 通道；previous_resolutions JSONB trail；旧任务保留；幂等同 decision_key 重放）；UI 处置表单复用+改判理由。已知边界：previous_resolutions 暂未投影到 API 响应（仅 DB 留痕），后续需要时补。
- revoke_approval：指针 CAS 清空 + approval_revoked_* 审计；读模型 ApprovalRevoked 投影（NeedsReacceptance 派生）；重新通过后指针前移自然清 revoked 展示。
- unpublish：版本行 unpublished_* 审计 + 会议指针 CAS 置空；幂等 no-op 重试；重新发布同版本支持（Publish 放宽并清 unpublished 字段）；checkActionSource 补 unpublished 判定；draft 行动来源随指针自然失效。

**验证**（协调机 624 库）：`go build`/`go vet` 0 错；service+handler `TestCockpit*` handler 全绿、service 仅既证 collation 环境差异；views 五组件定向 65/65（含新增 reopen/revise/revoke/unpublish 用例）；core tsc 0、定向测试过；语言包 parity 203。**待 agent 3 验收**。
