# 成果与验收持久化：迁移扩号审查稿

2026-10-10。审查对象为 `codex/cockpit-native-foundation` 工作树，基于 `14016f9056fe` 加当前未提交改动。本稿记录源码审查及实施方案；用户在方案说明后要求继续，新增号段规则已同步到 AGENTS 和中英文开发约定。成果迁移、真实接口和运行验收尚待实施，不能据此宣称成果业务已交付。

关联：[成果与验收合同](../artifact-acceptance-contract.md)、[剩余范围](../completion-plan.md)、[主提案](../proposal.md)。

## 1. 当前实现边界

| 层次 | 已有内容 | 尚未接通的部分 |
| --- | --- | --- |
| 客户端 | 成果列表、版本阅读、提交、评审、验收条件/请求表单；分页 schema、严格回执、草稿和精确重试 | 这些请求需要真实领域接口，客户端通过契约测试不等于后端存在 |
| Go 合同 | DTO、文本字节/hash、UUID、条件/证据规模校验；当前版本与指定人评审等纯规则 | 没有成果/验收的数据库命令、并发事务、权限读模型或路由 |
| 文件复制 | `artifactcapture.Capturer` 对明确附件做流式复制、回读核验；目标键包含版本和尝试 UUID | 没有生产调用者、持久意图/租约、后台执行器、对象清理或下载 capability 接线；测试使用假存储 |
| 既有闭环 | 纪要版本、正式 Review Issue、评审交接、会议行动、L3 主归属和 NAS 操作账本 | 这些表的领域语义不能替代通用成果、正式 L3 验收或独立决议 |

成果页和 L3 成果/验收组件已准备接线，但 `server/cmd/server/router.go` 没有对应 `/artifacts` 或 `/nodes/{id}/acceptance` 路由。当前上下文明确返回 `capabilities.artifacts=false` 和 `capabilities.acceptance=false`，界面不展示这些尚不可用的入口；旧深链显示不可用原因与实际工作入口，不请求不存在的服务。能力关闭只是交付隔离，不算成果实现。后端闭环验收后才可开放，不能用空集合、固定成功响应或无作用按钮掩盖缺口。

源码依据：

- [客户端 API](../../../../packages/core/api/client.ts) 中 `getCockpitArtifacts` 至验收方法；[成果查询](../../../../packages/core/cockpit/artifact-queries.ts) 对未确认响应报错。
- [驾驶舱入口](../../../../packages/views/cockpit/components/cockpit-entry.tsx)、[L3 入口](../../../../packages/views/cockpit/components/cockpit-selected-node.tsx)。
- [Go DTO/输入规则](../../../../server/internal/service/cockpit_artifact_contract.go)、[纯业务策略](../../../../server/internal/service/cockpit_artifact_policy.go)、[复制组件](../../../../server/internal/artifactcapture/capture.go)。
- [实际路由](../../../../server/cmd/server/router.go)。`server/pkg/db/queries` 和 `server/migrations` 尚无这些成果/验收领域对象。

现有附件、存储、IssueService 和人类任务机制应复用。`issue_source_context` 不适合作为新领域的存储替身：它要求 `anchor_comment_id`，且其 pending/attached/abandoned 状态服务于原始来源上下文捕获；不能把成果审批或 L3 验收塞入它的 snapshot。复制意图与清理的实现模式可复用，领域行不能冒用。

## 2. 扩号规则建议

后续新增 fork 迁移使用 **9000–9999**。原 900–999 中已发布或已应用的文件保持原名、原内容；当前新增已到 994，995–999 不挤入成果批次，也不重排旧编号。所有新编号仍全仓唯一；上游未来若占用同号，应在新增文件应用前解决冲突，不重命名已经入账的迁移。

根 `AGENTS.md` 和中英文 conventions 已在本轮同一变更更新编号约定；实际新增迁移仍须逐项实现并在 agent 3 验证。

已准备的 runner 使用数字前缀排序，历史同号按原文件名稳定排序，down 反向执行；账本身份仍是完整文件 stem。这是支持新范围的必要条件，必须先保证部署工具运行新 runner，不能让旧字典序 runner 处理含 9000 系列的迁移目录。

依据：[排序实现](../../../../server/internal/migrations/migrations.go)、[排序回归](../../../../server/internal/migrations/migrations_order_test.go)、[全仓唯一编号检查](../../../../server/internal/migrations/migrations_lint_test.go)。本轮只核对代码，不重复执行这些测试。

### 旧账本不重放的保证

1. `ExtractVersion` 仍只移除 `.up.sql/.down.sql`，不转换、补零或截断编号；`schema_migrations.version` 不做数据迁移。
2. runner 对每个完整 stem 查账本；已存在即跳过。只改变遍历顺序不会重新执行已登记文件。不得通过删除旧账本行“修复”扩号。
3. runner 没有内容 checksum。发布前应比对旧目录/目标目录/已应用 stem 的 manifest 与 SHA；已应用文件改动须作为发布错误处理，不能靠上述 skip 隐藏。源目录缺少的旧历史 stem 保留在账本，不自动清理。
4. 条件跳过也会登记账本，因此“已入账”不能替代对象存在性检查。新 DDL 对已知可选旧对象使用 `IF EXISTS/IF NOT EXISTS`；真正缺少运行前置对象时，给出独立、可审核的修复迁移或停止部署，不重放冻结文件。
5. 所有 concurrent 索引都单独一个单语句 up 文件，并登记 invalid-index cleanup。DDL 成功、账本写入前失败后重试，应检查实际对象定义/索引有效性，不能只凭 `IF NOT EXISTS` 判断结构正确。

具体 skip、条件登记与非全批事务行为见 [runner](../../../../server/cmd/migrate/main.go) 的 `runMigrations`。扩号不会增加 checksum、改变执行身份或偷偷恢复缺失对象。

## 3. 第一批模型及编号预算

以下是**第一批预分配清单**，不是已落盘文件。涵盖通用文本/文件成果、人类正式评审及交接、版本生产来源、多处固定版本引用、L3 验收及交接；不把它缩成只有文本的演示闭环。

建议分配 **9000–9064，共 65 对 up/down 文件**：14 个建表文件、50 个独立 concurrent 索引文件、1 个纯保护约束文件。每个表的结构和索引分开审查。编号只是预算；实现时若删减冗余索引，可在任何应用之前重新连续分配，应用后即冻结。

所有业务表含 `workspace_id`；UUID 关系由应用事务校验，无 FK、级联删除或级联更新。下表的 `U` 表示 `CREATE UNIQUE INDEX CONCURRENTLY`，其余为 `CREATE INDEX CONCURRENTLY`。有 `id` 的表使用独立唯一索引保证身份，不再另写会自动新建索引的内联 PRIMARY KEY/UNIQUE；组合身份表采用列出的组合唯一索引。

| 结构文件 | 表与主要职责 | 独立索引文件与键（按列出顺序分配） |
| --- | --- | --- |
| 9000 | `cockpit_artifact`：不可变原始来源 `source_issue_id`，唯一主 L3 `owner_node_id`，当前授权生产任务，创建键/hash/操作者，标题、修订、归档、当前/已批准版本 pin | 9001–9005：U(id)；U(workspace_id,creation_key)；(workspace_id,owner_node_id,id)；(workspace_id,source_issue_id,id)；(workspace_id,authorized_producer_issue_id,id) |
| 9006 | `cockpit_artifact_version`：提交键/hash、版本号，精确文本或固定对象身份/hash，生产 Issue/Run、会议/纪要版本来源，固化与评审分别记状态，正式 reviewer/Review Issue/结论 | 9007–9012：U(id)；U(workspace_id,artifact_id,version_number)；U(workspace_id,artifact_id,submission_key)；U(workspace_id,review_issue_id) WHERE 非空；(workspace_id,producer_issue_id,id)；(workspace_id,source_meeting_id,id) WHERE 非空 |
| 9013 | `cockpit_artifact_capture`：以 `version_id` 为唯一意图身份，固定附件/存储来源，队列、租约、退避、总尝试数及当前尝试 | 9014–9015：U(version_id)；(next_attempt_at,version_id) WHERE 可领取状态；工作区校验始终保留在查询中 |
| 9016 | `cockpit_artifact_capture_attempt`：每次独立尝试、租约令牌、不可变目标键、验证结果及对象清理状态；对象键必须在 I/O 前入账 | 9017–9020：U(id)；U(workspace_id,version_id,attempt_number)；U(storage_key)；(cleanup_next_attempt_at,id) WHERE 待清理/过期清理租约 |
| 9021 | `cockpit_artifact_reviewer_handoff`：显式交接键/hash、原/新评审人和 Review Issue、固定版本、原因、操作者、结果修订；退休任务继续受保护 | 9022–9025：U(id)；U(workspace_id,artifact_id,command_key)；(workspace_id,artifact_id,created_at,id)；(workspace_id,from_review_issue_id) WHERE 非空 |
| 9026 | `cockpit_artifact_producer_assignment`：保留原始来源，显式授权新生产 Issue；命令键/hash、原/新 Issue、原因和结果修订 | 9027–9031：U(id)；U(workspace_id,artifact_id,command_key)；(workspace_id,artifact_id,created_at,id)；(workspace_id,from_issue_id,id)；(workspace_id,to_issue_id,id) |
| 9032 | `cockpit_artifact_node_reference`：某 L3 明确引用固定版本，用途、命令键/hash、创建与撤销审计；不改变主归属 | 9033–9037：U(id)；U(workspace_id,reference_key)；U(workspace_id,node_id,version_id,purpose) WHERE 未撤销；(workspace_id,node_id,id) WHERE 未撤销；(workspace_id,artifact_id,id) |
| 9038 | `cockpit_artifact_meeting_reference`：会议资料/评审背景引用固定版本，保留撤销历史 | 9039–9043：与上一表对应，以 meeting_id 替代 node_id |
| 9044 | `cockpit_acceptance_definition`：L3 当前条件修订、当前请求/最后通过请求 pin、配置审计 | 9045：U(workspace_id,node_id) |
| 9046 | `cockpit_acceptance_criterion`：稳定条件 ID、所属 L3、当前标题/说明/顺序；移除保留身份，不抹掉已引用条件 | 9047–9048：U(id)；(workspace_id,node_id,position,id) |
| 9049 | `cockpit_acceptance_request`：请求键/hash、条件修订、证据摘要 hash、指定人/Review Issue、正式结论、被替代指针/时间及修订 | 9050–9053：U(id)；U(workspace_id,node_id,request_key)；(workspace_id,node_id,created_at,id)；U(workspace_id,review_issue_id) WHERE 非空 |
| 9054 | `cockpit_acceptance_request_criterion`：请求中固定的条件 ID、文字与顺序，不从可编辑当前定义回读历史 | 9055：U(workspace_id,request_id,criterion_id) |
| 9056 | `cockpit_acceptance_evidence`：每个固定条件引用哪些固定成果版本；没有文件名推断和第二份执行状态 | 9057–9058：U(workspace_id,request_id,criterion_id,version_id)；(workspace_id,version_id,request_id) |
| 9059 | `cockpit_acceptance_reviewer_handoff`：验收责任显式转交、命令去重及退休 Review Issue 保护；不伪造拒绝/通过 | 9060–9063：U(id)；U(workspace_id,node_id,command_key)；(workspace_id,node_id,created_at,id)；(workspace_id,from_review_issue_id) WHERE 非空 |
| 9064 | 在新增表均可用后扩展现有正式 Review Issue 执行保护；覆盖成果、验收及退休评审任务 | 不建索引；只拒绝非法执行/删除，不用触发器隐式清理、改派或推进业务 |

这些索引覆盖唯一效果、对象定位、历史分页、待处理领取和删除保护。暂不为每个筛选组合增加索引；标题搜索、项目/模块范围及 200000 版本的查询计划要在 agent 3 真实数据上检查后决定。索引清单不能代替 SQL 计划验收，当前 100000 Issue/20000 会议测试也不证明成果历史性能。

### 不可省略的关系与恢复语义

- `artifact.source_issue_id` 是原始来源；每版 `producer_issue_id` 记录真实生产任务，Run 由可信任务凭据推导。生产责任交接只影响后续提交，不改旧来源、旧 Run 或当前待审正文。
- 节点/会议引用必须落固定 `version_id`。引用与所有权分开，不能通过参考关系取得提交、评审或验收权限；撤销引用也不能删除已通过验收的固定证据。
- 当前/退休正式 Review Issue 都从这些领域记录识别，不依赖可编辑角色或 assignee。复用既有 IssueService typed hook 在同事务创建人工任务及关键关联；所有直接入队/唤醒/重试入口继续守卫。
- 文件意图先提交再做外部 I/O；每次尝试用新对象键。过期租约不能将版本置 ready；只有回读 hash/大小符合的固定副本才允许同事务创建 Review Issue。需要处理的失败可以保留，再显式提交新版本，不能伪称旧版本已固化。
- 工作区删除先把每个自有对象的清理责任持久化，再移除业务事实；`capture_attempt` 中承担清理的最小记录须保留至对象删除确认，可成为失去业务父行的受控清理记录。若实现选择独立对象清理表，必须重新列明额外表/索引预算，不得清掉全部尝试后靠内存任务删文件。NAS 团队副本不在此删除范围。
- 验收提交及通过均核对条件修订、成果当前已批准版本和引用资格。旧通过记录不变；变动显示需重新验收。失效 pending 请求只经明确 `supersedes_request_id` 替代；同键重试不重复创建 Review Issue。
- 归档/恢复、成果及验收评审交接、生产任务授权、多处引用的精确 API/DTO 仍需补齐；当前客户端接口并没有包含这些完整命令，不能只加表后即宣称合同全部落实。

## 4. 应用、验证及回退边界

1. 先确认扩号规则及上述表清单，再落新增文件、cleanup 登记、sqlc 与正式接口。不要将半批新表接口投入运行；表创建、索引及正式任务 guard 全部完成后才启用写入和后台领取。
2. 发布前保留数据库备份、已应用 stem 和旧/新文件 hash 清单；只使用一个受控 runner。不要同时用自动启动与手工迁移争抢同一实例。
3. 在 agent 3 隔离库验证：旧账本下只应用新增 stem；再次 up 零重复；中断 concurrent index 后能清理重建；缺少条件对象时按预定修复路径处理；工作区删除保留未完成对象清理责任。
4. 验证业务而非仅 schema：并发同键/不同键、来源变动、离职/交接、取消退休评审任务、旧 Agent 凭据、源附件删除、存储失败/租约过期、固定版本回取、验收前证据更新，以及真实 HTTP/CLI/浏览器闭环。
5. 单独验证 200000 成果版本及关系的分页、当前 pin、待审队列和冷热连续查询；未执行前必须标为未验证。现有捕获组件与假 API 的测试不能替代此验收。
6. 优先应用回退：停用新增入口/worker，保留扩展 schema 和已经确认的事实。旧应用若不能识别这些 Review Issue 的执行/删除门禁，不能直接回退到它继续写入；须保留兼容保护，或把相应工作区置于明确只读维护状态。
7. 数据库 down 仅用于隔离空数据演练或已审核的备份恢复。runner 的 `down` 会处理其目录内所有匹配文件，必须使用独立临时目录和明确的本批 manifest，不能在完整 migrations 目录运行。含真实成果/验收/对象意图时应拒绝破坏性 down；不要承诺任意单文件 down/up 都能安全恢复。

## 5. 主提案其他缺口与 DDL 依赖

| 未完成能力 | 已有基础 | 是否需要新 DDL；可先做的部分 |
| --- | --- | --- |
| 通用成果、版本来源、多 L3/会议引用、人工评审、L3 验收 | 本文列出的客户端和纯逻辑，附件/存储/IssueService | **需要**本文领域表/索引及守卫；不能用纪要表、附件名字或 Issue done 代替 |
| 正式决议的生效、替代、废止与影响范围 | 已发布纪要、行动草稿/确认、旧 decisions 文本、计划变更提案 | **需要**独立决议/修订及对象范围关系、正式命令去重和审计。现有行动或待审变更不是正式决议；可先完成提取草稿与原文定位设计 |
| 稳定 ID 的计划基线与差异恢复 | 现有快照、可审核字段变更、稳定绑定、破坏性导入保护 | **分开处理**：可不改 DDL 增加新格式的 UUID 快照/只读差异预览；旧 snapshot payload 当前按 code/parent_code 记录，不能自动声称可映射旧 UUID。正式基线批准、成组恢复命令及关联审计应新增持久结构，不能把重建整板解除保护当完成 |
| L3 明确人类责任、结构化依赖与承诺/预测/实际日期 | 节点 owner/dependencies 自由文本、计划日期、Issue assignee 和主归属 | **需要**明确身份/日期字段、稳定依赖关系和循环约束；现有 Issue 依赖不能冒充 L3 验收前置。无 DDL 可提供待纳管清单与显式候选匹配，不自动回填 |
| 会前议题、准备模板、资料版本、取消/归档和整轮闭环 | 会议工作包、人工就绪事实、准备用途、纪要/评审/行动 | 完整历史与自动准备**需要**议题/模板版本、输入引用和取消/归档审计等持久事实。可无 DDL 改进现有材料入口、按已有角色阅读及显式人工推进；不能按会议时间自动视为已结束 |
| 长程自动化、等待条件、检查点、人工接管 | TaskService、wakeup、Autopilot 规则版本/运行/配额、现有业务门禁 | **不能整体归为无需 DDL**：简单授权事件适配可复用现有执行器；新增跨阶段条件、因果去重/待处理事件、可恢复等待和职责审计需先与既有表逐项映射，再为缺失事实增列/增表。不新建平行通用调度器，也不把定时 deferred task 当资料就绪条件 |
| NAS 资料自动发现、稳定检测、归属建议、最小版本化上下文、跨机器挂载映射 | 显式 NAS 导出、操作/尝试账本、目录扫描、真实 create_only 验证 | **需要**输入文件身份/观察版本、归属确认、连接器/根映射等持久模型；可无 DDL 扩充诊断与人工资料读取。已验证的纪要输出复制不等于双向同步或 AI 自动接收材料 |
| 汇报/保存视图、风险/问题入口、存量显式纳管与最终 UI 验收 | 当前范围读模型、计划导出、分页、客户端偏好、Issue | 个人保存视图、汇报展示、已有 Issue 风险标签视图、显式绑定/主归属纳管可先**不改 DDL**；共享视图/正式风险登记若需独立责任与历史，再明确增量结构。不得把上述界面优化全部卡在扩号上 |

本稿没有把所有未来领域预先占号。决议、基线、会议生命周期和自动化分别冻结合同后再给独立编号段，避免一批迁移混入多个尚未定稿的状态机。
