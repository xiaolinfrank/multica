# 会议工作包首批实现合同

2026-10-09。承接 implementation-status.md 后续会议闭环；本文件记录首批实际实现范围与接口。

## 本批闭环

启用工作包 → 新建或显式接管未开始的纪要 Issue → 人确认会议已结束和材料齐备 → 人点击“启动纪要任务” → 提交不可变文本纪要版本 → 人负责的评审 Issue → 通过/退回/拒绝 → 通过后显式发布指定版本。

本批采用显式启动命令，不宣称已启用无人确认的定时自动推进。数据库中的文本版本即固定、可回取内容；NAS 仍只做已有目录操作，录音识别/转写、文件事件摄取和自动派发行动不包含在本批。保留旧会议文本作为历史记录，不能把它自动当成已发布版本。

显式启动Agent/小队任务时通过原生Run的handoff携带会议UUID和读取/提交指引。Agent执行时从board读取当前资料目录，从workflow读取版本/修订与评审人，再以保留的submission_key提交文本；缺少真实会议资料应报告阻塞。该交接不嵌入原始议程作为指令、不修改接管Issue正文、不提供自动人工确认权限。

## 工作模型

- 一个 meeting 一个 `cockpit_meeting_work_package`，无外键；稳定字段包括 workspace_id、meeting_id、revision、minutes_issue_id、reviewer_id、ended_at、materials_ready、released_at、release_task_id、current_version_id、published_version_id、created_by、created_at、updated_at。
- `minutes_issue_id` 在包之间唯一。已有任务只有用户明确选择、属于工作区且为 backlog、无活跃运行、未被其他工作包/评审占用时可以接管；不猜测 legacy `role=task` 的用途。
- 普通 IssueService 创建 backlog 纪要任务并在同事务建立工作包、用途与门禁。禁止先创建可执行任务再补门禁。
- 文本版本保存 id、workspace_id、meeting_id、version_number、submission_key(UUID)、content、content_hash、source_issue_id、review_issue_id、reviewer_id、decision、feedback、submitted_by_type/id、created_at、reviewed_by/at、published_by/at。文本提交后不可改；一轮一条评审 Issue，同一submission_key重试复用原结果。
- 评审授权取版本里的 reviewer_id，不取可被普通编辑修改的 Issue.assignee_id。只有可信人类身份可以启用、修改就绪、启动、评审和发布。
- 工作包和版本的正式变更使用 expected_revision；互相竞争的命令返回409。完全相同的幂等重试可以返回已经存在的结果，不能创建重复Issue或新版本。
- 存在pending当前版本时不允许另开一轮；先完成本轮结论。正式重新提交才产生新版本与新评审；旧结论保持原版本。
- `approved / changes_requested / rejected` 都表示本轮评审有结论；只有approved且仍为current_version才允许发布。Review Issue.done不触发任何通过/发布。
- 工作包记录受到整板导入/恢复保护。已有纪要版本不随普通会议编辑、任务删除或计划基线操作消失；相关删除入口需明确保护或正确清理所属工作区，不留悬空门禁。

## API

全部workspace-scoped，meetingId使用UUID，Issue请求标识先用现有加载器解析。

| 动作 | 路径 | 请求要点 |
| --- | --- | --- |
| 读取工作包 | GET `/api/cockpit/meetings/{meetingId}/workflow` | 未启用也返回200且enabled=false |
| 启用/接管 | POST 同上 | reviewer_id；可选existing_issue_id；新建时project_id/module_id/node_id、assignee_type/assignee_id；默认执行者为当前成员 |
| 记录就绪事实 | PATCH 同上 | expected_revision；ended可设true但不撤回已结束事实；materials_ready布尔，仅启动前可改 |
| 启动纪要工作 | POST `.../workflow/release` | expected_revision；两事实成立，权限/入队校验成功后原子更新Issue、运行队列和release记录；成员任务无Run |
| 提交版本 | POST `.../workflow/versions` | expected_revision、submission_key、content；采用包的指定reviewer；创建本轮人类Review Issue |
| 提交评审结论 | POST `.../workflow/versions/{versionId}/review` | expected_revision、decision、feedback；decision为approved/changes_requested/rejected；后两种必须有反馈 |
| 发布版本 | POST `.../workflow/versions/{versionId}/publish` | expected_revision；只接受已通过的当前版本，重试不重复发布 |

所有成功写入返回最新工作流读模型，字段如下（业务ID均为真实UUID，不是占位值）：

```text
enabled, meeting_id, revision,
ended_at, materials_ready, released_at, release_task_id,
reviewer_id, minutes_issue,
current_version_id, published_version_id,
versions[], can_manage, can_submit, can_review, can_publish

minutes_issue / review_issue = { id, identifier, title, status, assignee_type, assignee_id }
version = { id, version_number, submission_key, content, content_hash, source_issue_id,
            review_issue, reviewer_id, decision, feedback,
            submitted_by_type, submitted_by_id, created_at,
            reviewed_by, reviewed_at, published_by, published_at }
```

`can_review`/`can_publish`是当前认证人的能力提示，服务端每次重验；UI同时核对版本、结论和是否当前版。首次数据用schema回退默认安全值；写入必须检查响应实际确认，而不能用默认空值宣称成功。

工作包创建者、工作区owner/admin管理就绪与启动；该管理者或当前成员执行者可提交版本。固定评审人独享评审权，管理者不能因角色代为通过；评审人或管理者可发布。`mat_`提交必须由该纪要Issue所属Run的任务凭据发起，记录真实Agent作者；`mcn_`不能提交。上述机器凭据不能启用、就绪、启动、评审或发布。人类身份按现有认证边界判断，不把凭据映射出的owner ID误认成人类操作。

新增整板字段`has_meeting_workflows`供恢复入口展示保护状态，不为每个会议逐个拉取工作包。正式历史目前不支持单独取消工作包/改评审人/删除会议；整个工作区删除由既有授权入口统一清理。版本列表目前按单会议读取全部文本（每版最多128KiB），后续大规模历史分页属于下一阶段；当前不加载全驾驶舱的版本正文。版本来源保存Issue与作者，尚未扩展为通用文件/Run/上下文快照证据链。

具体限制：指定评审人退出工作区或被移除后，尚待评审的当前版本无法由其他人完成正式评审；该工作包后续版本也会因原评审人不再是成员而被拒绝。修改 Review Issue 的执行者或状态、用管理员身份代签、重新启用并传入另一评审人都不能恢复这条流程。本批尚无评审人交接入口，不应把普通任务改派描述为恢复方法。已有通过结论和发布历史仍保留；已通过的当前版本仍可由现有管理者显式发布。

当前权限匹配的是原有 `user_id`，不是成员记录的 `member.id`。若同一现有用户经正常授权重新加入同一工作区，其原评审人身份会重新满足成员与身份校验，可以继续符合当前版本/修订条件的评审及后续流程；换成不同 `user_id` 的新账户不会恢复该权限。这是当前实现的行为说明，不自动邀请已离开的用户，也不修改退出/移除权限。后续交接需显式授权并保存旧评审责任与结论。

CLI已提供`multica cockpit meeting workflow show|enable|ready|release|submit|review|publish`，具体参数和边界随内置技能同步维护于`server/internal/service/builtin_skills/multica-cockpit/references/cockpit.md`。接管不接受改派参数，初始化遇到不同执行者/归属/显式节点的重复请求返回409。

复用 `cockpit:changed`，新增scope `meeting_workflow`，payload至少meeting_id，客户端invalidate该会议工作包及board/相关Issue投影，不将整个工作包写进Zustand。

## 界面

- 会议工作台分“工作流 / 关联与资料 / 基本信息”；工作流占较宽正文，旧NAS、联系人、关系和历史文字保留。
- 创建会议可以选择“创建纪要工作包”，明确执行者、指定人类评审人和等待条件；目录仍走旧provision，显式create_task:false。失败后重试复用已创建会议ID，不退回旧即时任务创建。
- 旧会议可显式启用；有既有任务时先选择是否接管，不自动暂停或改派正在进行的工作。
- 两条件不齐显示具体缺口；齐备后出现明确“启动纪要任务”，人任务也通过同一入口转为待办。
- 输入文本形成草稿；提交后固定版本，评审头显示Review Issue/评审人/版本。暂缓仅保留待办，不提交最终结论。
- 普通Issue编辑为done或改派之后，工作台继续按正式结论显示。退回修改后在同一纪要Issue返工，下一次正式提交产生新评审轮。

## 验证重点

未就绪的Issue从PUT/BATCH、手动运行、mention、wakeup、retry和claim/start都不能启动；review任务不能因改派/机器认证自动获得人类批准权。完整验证并发初始化、错误回滚、启动幂等、版本提交幂等、权限与修订冲突、done不通过、返修新轮和发布固定版本。测试全部采用隔离数据与假Agent，不运行真实Agent CLI。
