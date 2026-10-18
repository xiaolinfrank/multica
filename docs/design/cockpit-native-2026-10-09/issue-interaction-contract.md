# Issue 操作依据与批量结果合同

2026-10-11，实现合同；操作依据、批量回执和层级事务已提交后端 `b2f191fc0`。agent 3 完整 handler 回归 2640 个父用例通过，1 个既有外部联网用例按门控跳过；界面浏览器验收和常驻部署已完成，见[验证报告](implementation/agent3-issue-operation-validation.json)及[部署报告](implementation/agent3-operation-resident-deployment.json)。本批不新增 DDL，不改变既有业务权限或自动执行规则；读依据用于解释和引导，写事务中的实际校验始终权威。

## 现有事实与不能混淆的边界

- `handler/issue.go` 的单条更新已经有状态目录、父子归属、Triage、执行者和数据库保护。新增正式成果/验收 Review Issue 的状态、改派、主归属限制来自 9064；删除/历史来源保护由 9065 的索引查询延续。
- 成果/验收正式 Review 的当轮待审只允许未开始/进行中分类；已决定只能保持完成分类，退休/被替代只能保持关闭分类。普通 Issue 的状态和执行者修改不能替代正式评审命令。
- 会议纪要的正式评审权限仍来自会议版本。其既有普通 Issue 状态/改派行为没有被改成上述锁定模式；首页有独立工作包下一步投影。不能仅凭关联用途 `review` 把会议任务变成新的成果 Review 锁。
- Triage 不是状态分类。目前只锁 `parent_issue_id`；状态、项目、执行者等是待确认提案，普通编辑仍允许。派发门禁另行阻止未接受提案自动运行。
- 普通主归属 Issue 改项目/模块前需要显式解除主归属；正常删除会保留创建收据的 tombstone，不能把所有 primary Issue 都标成不可删除。
- 固定成果的原始/当前/历史生产任务保留项目和模块。即使解除普通 primary，也不解除正式历史保护；生产责任交接不会篡改或释放原来源。已确认会议行动会保留 Issue 的删除历史，但不能据此杜撰一个当前不存在的永久项目迁移锁。
- `BatchUpdateIssues` 逐条事务，可能已有一部分提交后再遇到拒绝。`BatchDeleteIssues` 先加载、去重有效对象，再在**同一事务**锁定和检查全部有效对象，随后取消/删除；本批保留两者差异。

主要证据：`server/internal/handler/issue.go` 的 `updateIssueWithStatusGuard`、`updateIssueAtomically`、`BatchUpdateIssues`、`deleteIssuesAndCollectAttachmentURLs`；`issue_triage_guard.go`；`service/cockpit_primary.go`；`migrations/987_cockpit_primary_integrity.up.sql`、`9064_cockpit_artifact_integrity.up.sql`、`9065_cockpit_artifact_guard_index_lookups.up.sql`。

## 有界只读操作依据

已实现入口：

- `POST /api/issues/operation-basis`，只读请求体 `{issue_ids: UUID[]}`，1–100 个不同 UUID；严格验证，响应逐一对应原请求顺序。选择工作区使用现有 `X-Workspace-ID`，明确校验当前成员，不能初始化驾驶舱。
- 详情和列表在父级界面按**已加载的当前集合**独立批量读取依据；现有 Issue 响应不强制装配新字段，旧客户端无需承担附加关系查询。每页最多 100 个，跨界面共用最多 4 个并发读取槽；先按已加载顺序分块，再规范化各页 ID 集合，追加页不会重排已满旧页的缓存键。筛选或层级变化确实改变页面集合时重新读取。不扫描整张列表，不从每行 hook 发一个请求。单个 Issue 原 loader 仍支持 UUID/identifier，依据批量输入仅纯 UUID。
- 项目/模块删除入口分别提供 `GET /api/projects/{id}/operation-basis`、`GET /api/modules/{id}/operation-basis`，复用现有 owner/admin 检查和真实 `HasCockpitArtifactScope` / `HasCockpitPrimaryForProject|Module`。不通过下载全部 Issue 来推断容器可删。

响应形状：

```json
{
  "workspace_id": "uuid",
  "schema_version": 1,
  "generated_at": "RFC3339",
  "items": [{
    "issue_id": "uuid",
    "availability": "available",
    "issue_revision": 42,
    "status": {"state": "allowed", "allowed_categories": ["unstarted", "started"], "reason_codes": []},
    "assignee": {"state": "blocked", "reason_codes": ["formal_reviewer_binding"]},
    "scope": {"state": "blocked", "reason_codes": ["formal_review_scope"]},
    "parent": {"state": "allowed", "reason_codes": []},
    "primary": {"state": "blocked", "reason_codes": ["formal_review_scope"]},
    "delete": {"state": "blocked", "reason_codes": ["retained_formal_history"]},
    "execution": {"state": "blocked", "reason_codes": ["human_formal_review"]},
    "targets": [{"kind": "artifact_version", "artifact_id": "uuid", "version_id": "uuid", "purpose": "formal_review"}],
    "targets_total": 1
  }]
}
```

`state` 为 `allowed | blocked | unknown`，不是通用授权许可证。`allowed_categories` 使用实际目录的四类 `unstarted/started/done/closed`；不可把当前未知状态当成可写的新分类。状态可改不表示已满足 Agent 派发条件，执行者可选也不保证任意候选 Agent 可调用；实际候选仍由现有 invocation/runtime 判定与选择器处理。

`availability` 为 `available | unavailable | unknown`：

- `available`：已读到该工作区对象，并完成本次所需依据计算。
- `unavailable`：对象缺失或当前调用者不可读，统一 `not_found`/同类不泄露错误；只回所请求 ID，不补来自另一工作区的标题、来源或 targets。
- `unknown`：依据不完整/规则版本不支持/有界层级分析无法确认；不能退化成“没有保护”。整次 SQL/权限服务失败仍是明确 HTTP 错误，不伪造一页空对象。

主归属选择还要表达当前项目/模块缺失这一真实前置条件：先提供本 Issue 可操作的项目/模块入口，不能展示一个必定因归属不匹配而失败的 L3 选择器。普通固定来源 Issue 的项目/模块保留与 primary 编辑是不同事实；不能因它是成果来源就额外禁止后端仍允许的同范围 primary 调整。

对无法判定的写动作，客户端保持禁用并给“重新读取”入口；可读对象的普通打开操作仍可用。对象版本和依据都可能在读后变化，因此不靠缓存绕过事务校验。

## 依据与恢复入口

输出理由是稳定代码，由四语界面解释；内部诊断不作为主要文案。优先覆盖：

| 事实 | 实际限制 | 真实入口 |
| --- | --- | --- |
| 当前成果/验收正式评审 | 禁普通终结、改派、迁移主归属 | 固定 artifact/version 或 node/request 的正式评审；管理者显式交接 |
| 普通 primary | 项目/模块迁移需先处理主归属；普通删除仍可执行 | 本 Issue 的主归属编辑或所属 L3，不承诺解除不可解除的正式历史 |
| artifact 原始/历史生产来源 | 即使 primary 已空，仍保留项目/模块和删除历史 | 成果/来源依据；需要新的生产任务时显式交接，不能称其能释放旧来源 |
| 父子归属或受保护后代 | 子项不能独立脱离父项目/模块；父项不能连带移动保留事实 | 原父 Issue / 子任务列表 / 实际保留对象 |
| 会议工作包/已确认行动历史 | 保留删除历史；执行门禁与普通状态编辑分别解释 | 对应会议工作流或固定行动 |
| Triage | 父关系暂不可设置；执行前需接受提案 | 本 Issue 的真实分流处理入口 |
| 项目/模块包含保留范围 | 容器删除被拒 | 有限的关联计划项/成果/验收入口；无权限只解释所需角色 |

每条最多 3 个结构化 targets，按正式待处理入口、可处理的 primary、固定历史依据排序并去重；`targets_total` 表示同口径可导航依据数，不是 Issue/版本完成数。大量依据通过已有有界反向上下文继续读取，不能把所有版本塞进一个 targets。

目标类型限真实对象：`issue`、`node`（可指定 `tasks/details/acceptance`）、`meeting`（`workflow/resources`、可带 action ID）、`artifact`（草稿或生产来源的准确成果 ID）、`artifact_version`（固定 artifact/version）、`acceptance_request`（固定 node/request）。只给对象 ID、目的、可读标签和必要固定版本，不给任意 href。未落地的 section/deep-link 不进入合同；客户端统一用现有 workspace paths、cockpit navigation 和 `AppLink`。

## SQL 与服务边界

新增独立 `issue_operation_basis.sql` 和纯投影服务；批量读取一次 membership/状态目录，再以请求 UUID 集合读取轻量 Issue、primary、父信息和真实治理角色。复用 `cockpit_artifact_review_stage`、`cockpit_artifact_references_issue`、`CockpitWorkflowReferencesIssue` 以及既有执行门禁的事实来源，不能以可编辑用途标签或 Issue assignee 推断正式权限。

对普通 source/producer、formal Review、meeting history 等关系，按工作区与真实角色索引做集合查询。展示 targets 的候选先去重，再按 issue 分组排序截前 3，同时算总数；禁止为每个 Issue 调一次完整 artifact/version/history getter，禁止读取正文。

父子/后代保护与写路径相同，不默默忽略后代。优先用选中行的 indexed 子关系判定，仅对存在子项的选中对象展开所需层级；复用已保留 Issue ID 集合，避免对每个后代逐条执行完整九路查询。重叠选择去重、循环检测、不能确认时回 `unknown`。上线前用 100 个选中项与大子树做 EXPLAIN/真实时延验证；不靠任意截断后声称“无锁”。

将共同的领域事实/判定抽成服务 helper，供投影和应用写前置检查复用；数据库 trigger 仍保留最后保护。此处不增加通用关系表、影子状态或持久权限快照。新增读接口都经过 zod、`parseWithFallback` 和异常响应测试。

## 批量回执与兼容

保留旧 `updated` / `deleted` 和原 HTTP 状态。已存在的 400/403/409/500 不改成成功的 `200 partial`；在同一次错误体上追加已确认回执，core 从 `ApiError.body` 严格解析。现有成功体可以 additive 增加相同结构，旧客户端忽略新字段。

统一附加：

```json
{
  "error": "原错误文案（仅错误响应）",
  "code": "formal_review_required",
  "workspace_id": "uuid",
  "requested_ids": ["uuid-a", "uuid-b", "uuid-c"],
  "transaction_mode": "per_item",
  "transaction_outcome": "partial",
  "updated": 1,
  "results": [
    {"issue_id": "uuid-a", "outcome": "applied", "revision": 43, "changed": true},
    {"issue_id": "uuid-b", "outcome": "rejected", "code": "formal_review_required"},
    {"issue_id": "uuid-c", "outcome": "not_attempted", "code": "batch_stopped"}
  ],
  "unconfirmed_ids": []
}
```

- `applied` 只表示该项事务已确认提交（或明确确认的无变化应用，`changed=false`）；不表示 Agent 已执行、正式评审通过或外部文件已删除。
- `rejected` 需要已确认没有提交该项，并给稳定原因及可读的有限恢复入口；缺失/无权限对象不泄露标题。服务内部错误返回通用代码，不把 SQL/存储诊断裸放出来。
- `not_applied` 用于已经进入写阶段、但事务已确认回滚的项，代码为 `batch_rolled_back`；它不是未尝试，也不是已经保存。批次附 `transaction_outcome=rolled_back`。
- `not_attempted` 只用于确实未开始写的剩余项。按现有顺序遇明确终止条件停，不暗中扩大自动继续范围；既有逐项可跳过失败也必须记录其真实结果。
- 数据库提交结果不明或传输中断不能假填成上述已确认结果之一。服务保留已确认子集并列 `unconfirmed_ids`；客户端没收到可核回执时，把相应请求集合标成未知。
- 每个 requested ID 恰好出现在 results 或 unconfirmed_ids 中，不能重复或遗漏；计数从已确认 `applied` 推导，与旧字段保持同口径。服务规范化/去重后回显，客户端验证工作区与实际发送集合。
- 本批不引入 `client_request_id` 或持久幂等 ledger；界面操作代次只防止迟到回执影响新界面，不能作为服务器幂等键。网络未知不自动重新执行已尝试项；先回读真实状态，由用户决定新的命令。当前值相同也不能伪造原命令已执行的审计证明。

新客户端同时发送 `expected_revisions: {issueUUID: revision}`，逐项用现有 revision guard 防止未知重试覆盖别人的后续修改；服务不可只在事务外检查。旧客户端省略时保持原行为。已经变化的同值字段可以显示“当前已是该值”，但不是持久命令去重。

Batch Update 仍是 `per_item`。Batch Delete 保持有效对象集合单事务的 `atomic` 模式：先锁定、校验全部，再取消/删除，提交前不得发取消通知。写前保护检查拒绝时，该项 rejected，其他有效项 not_attempted，deleted=0；进入写阶段后若整笔事务已确认回滚，已尝试项为 not_applied/batch_rolled_back，未尝试项仍为 not_attempted，且 transaction_outcome=rolled_back。成功提交才同时为 applied。缺失请求 ID 明确回执而非消失，不能悄悄改成逐条删除。外部对象删除/对账状态与数据库删除分开说明。

## 界面与状态边界

操作集仍是已有权威的 `selectedIds ∩ 当前 surface 可选 Issue IDs`，投影和写入都使用实际将发送的这组对象。不得借这次改造开始操作已经移出当前筛选/页面范围的历史选择。

详情菜单、右键、table 行、子任务行及批量弹窗消费同一 Query 依据。正常主归属和不可解除的保留来源显示不同下一步；加载失败不能展示一个“看起来已解锁”的菜单。列表只为当前页装配依据，不下载所有历史关系。

确认流程 await 严格回执，不在 finally 关闭弹窗、清选择或丢草稿。全部成功才完成当前操作；部分成功保留未处理项及输入，明确哪些已应用。未知结果保留原意图并提供回读。晚回执只处理捕获的工作区、surface、操作代次和发送 ID 集合，不能清理用户之后的新选择或把其导航回旧对象。

Query owns server facts；Zustand 只存实际用户选择/命令输入/客户端草稿，不存 operation_basis。依据 key 含 workspace 和规范化请求集合，注销/切换工作区沿现有清理；Issue、primary、meeting_workflow/actions、artifacts、acceptance、成员与相关结构事件按组失效，因为正式关系新增不一定推进原 Issue revision。

## 验收清单

状态展示继续区分完成（done）和关闭/取消（closed），不得把取消标成完成。受保护与批量写优先等待真实结果，不新增整页乐观快照/回滚机制。

1. 一条当前正式 Review 从详情、右键、table 和子行都无法普通 done/改派，但真实评审/交接入口可达；退休与已决定任务保持真实分类边界。
2. 普通 primary 的可处理迁移门槛与永久保留来源明显区分；删除普通 primary 保留收据，不被误锁。
3. 100-ID 读含正常、缺失、跨工作区、未知、深层后代；不泄露标题，不 N+1，不以空数组伪装无保护。
4. Batch Update 第 1 条成功、第 2 条拒绝、第 3 条未执行，HTTP 仍原错误，客户端准确保留后两条及用户输入；未知提交不自动重放。
5. Batch Delete 一项受保护，全事务无删除、无先行取消副作用；成功子集的回执范围与原加载语义一致。
6. 项目/模块删除按钮给出真实保留依据；个人选择范围不被拓展。工作区/页面切换后的迟到回执不能清掉新选择。
7. 新旧 API 回包、错误体、未确认旧后端、未知枚举和缺字段均有同层契约回归；运行仅 agent 3。

## 冻结的首批读取形状

Go 类型以 `server/internal/service/issue_operation_basis_types.go` 为准。首批以独立批量读装配当前可见页；既有 Issue list/search/children 不强制增加关系查询，也不从每行重复读取。

`GET /api/cockpit/nodes/{id}/operation-basis`、项目和模块同名端点统一返回：

```json
{
  "workspace_id": "uuid", "schema_version": 1, "generated_at": "RFC3339",
  "resource_kind": "node", "resource_id": "uuid", "resource_revision": null,
  "availability": "available",
  "delete": {"state": "blocked", "reason_codes": ["retained_artifact_scope"]},
  "structural_edit": {"state": "blocked", "reason_codes": ["retained_artifact_scope"]},
  "add_child": {"state": "blocked", "reason_codes": ["retained_execution_leaf"]},
  "targets": [{"kind": "node", "node_id": "uuid", "view": "acceptance", "label": "交付范围", "purpose": "retained_node"}],
  "targets_total": 1
}
```

节点没有独立 revision 字段，不把时间戳伪装成版本。结构编辑仅指 parent/project/module，名称、计划状态等普通字段不因此被锁定。项目/模块仅提供删除依据，其 `structural_edit` 和 `add_child` 明确为 `unknown/not_applicable`。不存在或不可读对象统一 unavailable，全部字段 unknown/basis_unavailable、targets=[]/total=0。

普通子 Issue 的已有解除父关系并迁移操作继续可达：仅父关系约束时 `scope.state=allowed`、`reason_codes=[parent_scope_requires_detach]`，仍须原显式确认；primary、正式保留来源或 Review 限制优先阻断，不能通过解除父关系规避。

批量回执固定 `transaction_outcome` 为 `committed | partial | rolled_back | not_started | unknown`；逐项 outcome 为 `applied | rejected | not_attempted | not_applied`。计数是已确认提交事实；unknown 的 ID 只在 `unconfirmed_ids`，不伪造逐项结果。旧 HTTP 状态始终保留。

## 首轮实现与验证边界

2026-10-11：独立读取接口和批量 additive 回执已落源码，无 DDL。Agent 3 定向 service 3 个父用例、handler 10 个父用例通过；后者包含新读取 2 个、新批量回执 4 个及原无操作/无效状态、会议取消删除竞态 4 个回归。确认了原 409 保留、逐项成功与未执行区分、锁内 revision 竞争，以及整组回滚与未知提交分开。

对应编译产物为 service `2d94676a…`、handler `9bd46736…`；运行日志为 agent 3 的 `operation-basis-service.log`、`operation-basis-handler.log`。协调机仅编译和静态检查。这份首轮记录不表示部署或全部交互验收完成；后续规模测量见下一段，完整 handler 最终结果见本文开头。

随后 Agent 3 大集合检查通过：100 个选中父项、10,000 个子项，每父有真实 primary 保护，一项另含固定成果来源；21 次读取，首次观察 70.308 ms，20 次后续样本 p50 63.565 ms、p95 65.353 ms，最大响应 66,872 B。显式 ANALYZE，未宣称操作系统冷缓存，未改变应用 planner 设置；专属夹具和 search log 清理后均为 0。证据：[操作依据规模报告](implementation/agent3-operation-basis-scale.json)。这不代表任意更深层级或更多资料的既定延迟保证。

## 关系快捷操作按实际效果校验

- `duplicate_of_issue_id` 非空会由服务端补写 `status=cancelled`，因此也要检查 closed 分类；同时显式提交状态时只能用原始 key `cancelled`，不能用其它同类自定义状态替代。`duplicate_of_issue_id=null` 被拒绝；解除重复关系通过实际离开 cancelled 的状态写完成，当前界面使用 todo/unstarted。退休正式 Review 只能保持 closed，不能借“解除重复”重新打开。
- 设置**不同**父任务、且未显式提供项目/模块时，会采用新父任务的 project_id/module_id。候选两字段与当前 Issue 完全相同时，仅受 parent 依据约束；若不同，还需要 scope 依据允许。候选轻量搜索缺字段不能按 null 猜测，确认前使用精确详情。添加已有子任务时，被修改对象是所选 child，不是当前 parent。
- 移除父关系只清 parent/stage，不自动清项目/模块。普通来源任务可在同归属内调整父关系，不因此获得跨范围迁移权限。新建子任务也不代表修改原父项的正式评审结果或责任。
- Issue 详情的 Archive 图标在已完成任务上只调用当前阅读入口的 onDone，并非独立 Issue 归档写；不能因为标签“归档”误套状态变更。`/issues/{id}/move` 最终调用同一 UpdateIssue 流程，仍按实际 status/assignee/parent/scope 效果判断。

此次修复了 canonical atomic mutation 在刷新未显式提交字段时覆盖新父任务隐式归属的问题：在同一 Issue 锁内、refresh 之后，使用事务绑定查询重算 parent filing；普通重归属与受保护来源拒绝由相同规则处理。新增关系回归单独验证，不能以此前 basis 规模读取通过替代该写路径验收。

层级修复已纳入本批：Agent 3 的修改前具名回归确实复现 18 层后回接根被接受，以及并发 A↔B 两笔都成功。新实现使用完整 UUID 祖先查询和 workspace KEY SHARE → hierarchy advisory transaction lock → catalog/domain/Issue 行锁；canonical Create、parent/scope Update/Batch/Move、双行 duplicate、Issue 删除及项目/模块删除使用统一入口次序。普通 title/status 不取 hierarchy 锁，但都在 Issue 行锁内刷新未提交字段，不能把锁前旧归属写回。

父项与所有实际改变的后代在同一事务迁移；去掉子树写入的 10 层截断，返回及发布仅实际变更的轻量字段，不加载全文。工作区删除的既有 FOR UPDATE 与入口 KEY SHARE 隔离。Agent 3 修改后 6 个层级父用例通过，覆盖原两项失败、深层完整迁移/回滚、创建与父迁移交错，以及普通字段保留并发新归属；完整包回归另行记录。

保留旧 CreateIssue 的明确产品合同：当父项和新子项均无模块时，调用者可显式指定另一个 project；缺省才继承。不能把 SetParent 的缺省继承规则误套为创建必须项目相等，更不能将这类合法已有子项标成损坏。原模块约束保持；命令执行先后仍决定随后父项迁移对既有后代的作用。
