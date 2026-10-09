# 评审责任交接与流程恢复

承接145a9ccfa。目标是让指定评审人离开后，管理人可以明确交接正式评审责任，保留原文、已有结论和责任历史。沿用现有会议工作包、任务与运行机制。

## 行为

- 只有工作包创建者或工作区owner/admin可交接，必须是通过现有认证边界识别的人类操作；机器凭据不能交接。目标必须是当前工作区的另一位成员，原因必填。
- 当前版本仍待评审：原版本的ID、编号、内容、hash、提交UUID、作者和pending结论均不变。新建一个人类评审任务，旧评审任务置为cancelled；版本当前评审人和任务指针显式切换。交接不等于通过、拒绝或发布。
- 尚未提交或当前评审已经结束：只改变后续版本的默认评审人，不改历史版本的责任、结论、反馈或发布记录，也不创建空任务。
- 工作包默认评审人和当前版本实际评审人分开展示。待评审转交后，原评审人不能凭旧页面或旧任务操作新评审；服务器检查当前权限与修订。
- 每次交接在不可变记录中保留操作者、前后评审人、原因、时间、结果revision，以及实际受影响版本和前后任务（仅pending时有这些指针）。旧任务继续受删除、解绑、用途清除、接管和Agent执行保护；取消状态本身不是唯一保护依据。
- 交接、创建新任务、结束旧任务、更新版本指针和保存记录同事务。任一步失败均回滚，提交成功后广播。评审与交接竞争时只能一个按观察到的revision生效。

## HTTP与读模型

`POST /api/cockpit/meetings/{meetingId}/workflow/reviewer`

```json
{
  "expected_revision": 4,
  "handoff_key": "<uuid>",
  "reviewer_id": "<user-uuid>",
  "reason": "原评审人离职，由项目质量负责人接手"
}
```

成功返回最新完整workflow DTO。新增顶层`can_reassign_reviewer`（旧响应默认false）和`reviewer_handoffs`（旧响应默认[]）。每条记录：

```text
id, handoff_key, from_reviewer_id, to_reviewer_id,
version_id (nullable), from_review_issue (nullable), to_review_issue (nullable),
reason, created_by, created_at, revision
from_reviewer_name, to_reviewer_name, created_by_name (optional display fields)
```

任务卡片复用现有`CockpitWorkflowIssue`。无当前pending评审时三个可空字段都为null。当前版本沿用现有`reviewer_id/review_issue`表示有效评审责任；交接历史保存之前的责任，版本文本仍不可变。旧客户端继续理解当前指针，不从普通任务执行者推断批准权。

显示名从当前会议交接记录中的用户ID一次批量读取，退出工作区但账户仍存在的人仍可显示姓名；名称是当前个人资料而非不可变历史快照，身份依据始终为ID。姓名无法取得时明确保留ID，不推测；不返回邮箱或额外资料。

`handoff_key`标识一次命令，网络重试必须复用原key、revision、目标和原因。相同key且相同操作者/目标/原因/原revision返回已执行结果；不同意图返回409。历史记录确认优先于目标当前成员状态，避免执行成功后目标又离职导致重试伪失败。新key目标与当前默认评审人相同返回400，不生成无意义记录。reason trim后1–16000字节。

继续使用`cockpit:changed`的`meeting_workflow`作用域。默认人变更不修改已通过版本的批准者；已批准的当前版本仍可按原发布权限发布。

## 界面与CLI

管理人从会议工作台“移交评审责任”打开确认对话框，选择成员并填写原因。确认前明确本次影响：移交当前待评审任务，或仅修改后续默认人。操作等待服务器确认，丢失响应时保留命令key并提供重试/查询状态；不得生成新key盲目重试。

评审人离职警告连接到真实交接入口。非管理人看到受阻事实和联系管理人的提示；历史中的人员离开后仍展示稳定ID与已有任务链接。表单在同版本的评审人/任务改变时重置，避免遗留旧评审草稿。

CLI：`multica cockpit meeting workflow reassign-reviewer <meeting-id> --revision <n> --handoff-key <uuid> --reviewer-id <uuid> --reason <text>`。

本批不修改工作区退出/移除权限，不自动邀请离职成员，不引入代签，不取消整个工作包。NAS持久同步、通用文件产出物和完整驾驶舱视觉改版继续后续实现。

## 验证

覆盖人员退出后的恢复、固定内容与历史结论不变、原评审人失权、新评审人可审、同key并发与网络重试、冲突/回滚、原任务保护及运行门禁、未来默认人与当前评审人的区分、机器与跨工作区权限、整个工作区清理。浏览器验证真实交接和后续评审发布；全部使用隔离数据，不调用真实Agent或NAS。
