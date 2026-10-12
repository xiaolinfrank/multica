# 会议生命周期：议题、准备与发生事实

> **2026-10-12 总纲修订**：§2/§3/§5 中「确认结束不可重开、release 后 readiness 冻结、单版本结论一次性写入的终态语义」被原则 2 取代（切片 R1/R2：reopen、投影替代 released_at）；correct_times、议题软移除与命令台账是总纲范本，保留。 详见[设计总纲](./design-principles-2026-10-12.md)与[评审记录](./review-2026-10-12.md)。

状态：本批已完成 agent 3 功能、规模与最终浏览器验收，并部署到常驻测试环境；独立 `multica_test` 与常驻均为 9075，账本分别 761 与 764。详见[验证记录](implementation/agent3-meeting-lifecycle-validation.json)及[部署记录](implementation/agent3-meeting-lifecycle-resident-deployment.json)。日期：2026-10-11。现有产品依据为后端 `b2f191fc0` 及其已冻结客户端。本批保留此前已发布的任务操作依据与恢复路径。

## 1. 本次交付

在一场会议中完成“登记议题 → 打开或明确创建准备任务 → 查看材料 → 记录讨论 → 确认实际已经召开/结束 → 进入已有纪要流程”。没有纪要工作包的会议也能记录议题与发生事实；启用工作包仍是独立选择。

本次增加议题、发生事实和有界入口，不执行会议模板，不实现取消后的任务处置、归档、循环会议、正式决议或自动录音转写。开始、结束、保存记录、确认资料齐备均不创建任务、启动运行、移动目录或写入 NAS。用户明确选择“新建准备任务”才创建一条任务，默认 `backlog`，禁止随创建派发智能体。

原提案的完整流程仍见 [proposal.md §5](proposal.md#5-会议以议题为主线的完整协作过程)。本次可用的后半段复用 [纪要工作包](work-package-contract.md)、[有界历史](minutes-history-contract.md)、[行动](meeting-actions-contract.md) 与 [成果引用](artifact-runtime-contract.md)，不另建审批状态机。

## 2. 事实与权限

| 名称 | 唯一事实与本次含义 |
| --- | --- |
| 计划日期/时间 | 原 `meet_date`、`start_time`、`end_time` 等安排字段；日期已过不证明会议召开 |
| 旧状态 | 原 `meeting.status` 自由文本，原值保留；与发生状态分开显示，不解析其词语 |
| 发生状态 | `unconfirmed`（尚未记录）、`scheduled`（人已确认安排）、`in_progress`（人已确认开始）、`ended`（人已确认结束） |
| 结束确认 | 唯一 `meeting.ended_at`：平台记录“人确认会议已结束”的时间，不是实际散会时间 |
| 实际起止 | 可选 `actual_started_at`、`actual_ended_at`，由人明确填写；未知就为空，不从安排或确认时间补齐 |
| 资料齐备 | 原工作包 `materials_ready`，表示人已核对当前纪要输入；不表示系统验证了所有附件/NAS，不等于准备任务全部 `done` |
| 议题记录 | 带修订号的工作记录，可以继续修订；不是已批准的纪要或正式决议，也不承诺保存每一版正文 |
| 固定材料 | 沿用成果的固定版本及会议引用；核对身份、版本和可回取性，不以可编辑任务说明代替正式来源 |

发生状态与纪要阶段分别展示，例如“已确认结束 · 待整理纪要”。只有实际起止都明确、顺序有效时才可计算时长。确认时间只能标为“记录时间”或“确认时间”。已发布纪要不代表行动闭环。

权限沿用现有边界：议题和工作记录由当前人类成员编辑，准备任务通过原任务权限创建/复用；未启用工作包时，当前人类成员可记录会议发生事实。已启用工作包后，开始/结束等发生事实与资料确认沿用工作包管理人规则（`created_by` 或当前工作区 `owner/admin`）。新接口不把主持人/组织者自由文本、任务负责人或某个姓名转换成管理权；正式评审仍只属于当轮指定人。机器本次仅沿既有授权读取，不能调用人确认命令。

## 3. `ended_at` 迁移与旧入口

将 `cockpit_meeting_work_package.ended_at` 的既有值原样转入 `cockpit_meeting.ended_at`。非空值已是原管理人确认的结束事实，可以令发生状态为 `ended`；其来源标为 `legacy_confirmation`，`actual_started_at/actual_ended_at` 均保持空。旧表没有记录确认人，不能把工作包创建人冒充确认人，`ended_by` 保持空。

其余旧会议统一 `unconfirmed`。不因自由状态、日期、已有纪要文本、NAS 文件或任务 `done` 补造发生事实。新旧普通创建接口也默认 `unconfirmed`；新工作面可在明确确认安排时调用安排命令，不能由 GET 初始化。

切换后物理移除工作包的旧 `ended_at` 列，只有会议表保存结束确认。具体修改必须覆盖：

- 新发生命令和旧 `/workflow/readiness` 的 `ended: true` 在同一事务中调用同一个结束转换。旧 `ended: false` 仍不能重开已结束会议；旧请求的工作包 `expected_revision` 语义保留。
- 旧完整工作包 JSON、summary、compact 回执的 `ended_at` 字段不变，SQL 从会议事实投影。内部明确使用工作包与会议的组合读取，不再构造可独立写入的镜像字段。
- release 的预读、持锁复查和条件 UPDATE 都检查会议 `ended_at`；概览、会议登记页及工作阶段计算使用同一来源。资料齐备仍在工作包，不能在会议表再存一份。
- 执行门禁保持“未 release 的纪要任务不可运行、正式评审任务不可交给智能体”。现有 trigger 使用 `released_at`，并未直接读取结束时间；不人为增加第二份结束事实。新增/修改完整性检查如需判断已结束，必须读取会议表，且不得削弱既有退休评审/成果评审保护。

确认结束本身不 release。新发生命令成功时，有工作包则同步推进其 revision，使旧客户端持有的旧门禁快照不能执行下一步；同一旧 readiness 请求同时改变结束和资料确认时只推进一次工作包 revision。会议自己的 `lifecycle_revision` 仅在本次发生事实改变时推进。

### 迁移操作边界

迁移需停止所有旧 API/worker writer，备份同一时点完整数据库，核对旧结束事实不存在孤立工作包/跨工作区会议后再转移；异常立即拒绝切换，不能漏搬。替换查询/约束与移除旧列作为同一最终切换事务，不允许旧、新进程混写。

旧客户端 HTTP 兼容不意味着旧后端二进制兼容新 schema。回退应使用仍读取新权威列的兼容二进制；必须回到旧 schema 时，只能按已审核的整批空数据回滚或完整一致备份恢复，不能直接启动旧 writer，也不能仅把新确认事实倒灌成旧列后声称无损。所有已执行 9000–9065 文件保持冻结，本次另分配新迁移号。

## 4. 最小模型

业务事实使用列和领域表；只有不可变命令回执使用有界 JSON。

| 对象 | 字段与限制 |
| --- | --- |
| `cockpit_meeting` 扩展 | `lifecycle_revision`、`agenda_revision`（均从 1 起）；`occurrence_state`；`started_confirmed_at/by`；唯一 `ended_at/by`；`ended_source: legacy_confirmation\|human_confirmation`；可空实际起止；最新事实变更的 `updated_at/by` 使用新领域字段，不冒用旧全文 PATCH 的版本 |
| `cockpit_meeting_agenda` | UUID、workspace/meeting、revision、title、`purposes text[]`、desired_outcome、facilitator_user_id 可空、node_id 可空、notes、sort_order、created/updated actor/time、removed_at/by；一题最多一个明确 L3，多个 L3 可拆为多题 |
| `cockpit_meeting_agenda_reference` | UUID、workspace/meeting/agenda、`kind: issue\|artifact_reference`、target_id、`purpose: preparation\|material`、created actor/time、removed_at/by；`artifact_reference` 指向该会议已有固定成果引用，不复制版本内容或批准事实 |
| `cockpit_meeting_lifecycle_command` | workspace/meeting、command_key UUID、kind、actor_id、request_hash、结果 revision、相关 agenda/reference/issue ID、有限不可变 receipt、created_at；同一会议内 key 唯一，会议普通删除后保留，工作区 teardown 才清理 |

议题标题 trim 后 1–500 UTF-8 字节，desired_outcome 最多 16,000 字节，notes 最多 65,536 字节；notes 保留输入空白，不在网络回执前清草稿。目标 `purposes` 允许六项中的任意去重子集：`planning`、`goal_review`、`boundary_confirmation`、`question_clarification`、`solution_discussion`、`direction_decision`；可为空。它们只描述讨论目标，不授权自动化。

主持人是可读成员元数据，不授予正式审批权。选中 L3 必须是当前工作区的有效执行叶子及有效继承绑定；改名不改 UUID，不从展示编号推绑定。已保存引用的目标后来不可用时保留身份并明确显示不可用，不能把其当作可提交证据或静默改投其它对象。

本批不新增全场议题快照/多版本记录表。会议发生确认和命令历史保留 actor/time，正文当前值有 revision；需要固定证据时沿用正式成果版本/纪要版本。不能把某次旧 agenda revision 的正文假称仍可回取。

## 5. 命令、重试与锁序

新命令共有 `command_key`（UUID）、`expected_revision`（对应对象的修订号）。校验工作区成员身份后，在业务事务里先读取原 key：相同 actor、命令种类及规范化请求 hash 返回原回执，即使当前管理权、目标成员或计划绑定后来变化；不同意图返回 409。create/attach 的原目标后来删除或其原关联后来移除，返回 410，不重新创建、不复活。remove 命令自身已产生 removed 终态时，同 key 必须返回原成功回执；这不是目标丢失。整个会议已删除后所有新读/写均按对象存续拒绝。新命令才检查当前权限和目标条件。

回执格式为 `{workspace_id, meeting_id, command_key, action, replayed, receipt, current}`。`receipt` 是本命令的固定结果（对象 ID、结果 revision、提交字段及 hash）；`current` 是当前有界元数据。重放旧命令不把旧 receipt 覆盖为“当前最新”，客户端也不能用它覆盖新 Query 数据。开始/结束重复使用不同 key 属新命令，按修订号和转换检查，不假称第一次命令的回执。

锁序沿当前创建协议：workspace 存续/成员锁 → 涉及任务创建时的工作区 hierarchy 锁与状态目录锁 → 当前 cockpit → meeting → work package（如有）→ agenda/reference → 必要任务行。读到的旧 board/meeting ID 要在锁内重核。没有创建/更改任务层级的命令不取得 hierarchy 锁。网络、存储探测、附件读取与 NAS 操作都不在事务内执行。

| 发生命令 | 允许转换与结果 |
| --- | --- |
| `schedule` | `unconfirmed → scheduled`，确认已有安排；不根据日期自动执行，修改原计划日期仍使用原基本资料入口 |
| `start` | `unconfirmed/scheduled → in_progress`；记录 server 确认时间，可提交实际开始时间；不要求先有纪要工作包 |
| `end` | `unconfirmed/scheduled/in_progress → ended`；支持补记线下会议，不造缺失的开始事实；唯一 ended_at 写 server 确认时间，可附实际结束时间 |
| `correct_times` | 明确修正/清空可选实际起止，必须给 1–16,000 字节原因并记录前后值；不清除 ended_at、不重开会议、不撤销 release/历史纪要 |

实际时间用带时区 RFC3339，存 UTC；不得晚于提交时的数据库时间。两个实际值同时存在时须开始不晚于结束，只有已结束才可有 actual_ended_at。`end` 可同时明确补充实际开始时间；省略字段维持已存值，显式 null 表示未知。计划时间调整不更改实际时间或已结束事实。

资料确认沿用工作包 manager/revision 与 release 后冻结规则。本次为新 UI 增加带 command_key 的资料命令，旧 readiness 写仍接收旧 body。新回执标明确认 actor/time（新增列；旧资料确认人/时间未知时为空），显示“人已确认”。它不宣称订阅了所有附件、讨论记录和远端文件变化；release 前始终展示当前输入入口与确认含义。后续修改工作记录不会自动重跑智能体或撤销已批准历史。

## 6. 有界 HTTP 合同

前缀为 `/api/cockpit/meetings/{meetingId}`。全部显式工作区头、纯 UUID 边界校验及成员 gate；GET 不创建 board、工作包或目录。新页默认 25、最多 100；q 最多 512 字节，cursor 最多 4096 字节。cursor 绑定 workspace、meeting、endpoint、过滤、页大小与议题集合 revision，集合改变后续页返回 409，显式刷新首页。

| 路由 | 输入/结果 |
| --- | --- |
| `GET /lifecycle` | 元数据 header：workspace_id、meeting_id、lifecycle_revision、agenda_revision、occurrence、资料确认（无工作包为 null）、workflow_enabled、agenda_total、can_* 与结构化 blocked_reasons；无正文/关系全集 |
| `POST /lifecycle/occurrence` | 公共命令字段 + `transition` + 明确时间字段/修正原因；返回固定事实回执及当前 header |
| `POST /lifecycle/materials` | 公共命令字段，其中 expected_revision 为工作包 revision；`materials_ready` boolean；要求已有工作包，缺失时返回可去启用的明确原因，不自动 enable |
| `GET /agenda?q&include_removed&cursor&page_size` | `{workspace_id,meeting_id,agenda_revision,q,include_removed,items,total,next_cursor,page_size}`；默认不含 removed；item 仅身份、标题、purposes、sort_order、facilitator/node 轻量标签、revision、引用数量、updated_at、removed_at、can_* |
| `GET /agenda/{agendaId}` | 同 scope + 单题完整 title/purposes/desired_outcome/notes、显式 L3 与主持人身份、revision、can_*；关系仍独立分页 |
| `POST /agenda` | key + expected_revision=agenda_revision；title、purposes、desired_outcome、notes、facilitator_user_id/node_id 可空；分配稳定 UUID 和追加顺序，不创建任务 |
| `PATCH /agenda/{agendaId}` | key + expected_revision=该题 revision；只更新显式字段，sort_order 可改，notes 省略不清空；结果同时推进题 revision 与集合 revision |
| `POST /agenda/{agendaId}/remove` | key + 该题 revision + reason；软移除，保留任务/固定材料及命令，不删除其来源对象 |
| `GET /agenda/{agendaId}/references?cursor&page_size` | 元数据页，固定 target ID、kind/purpose、可读标签、available、必要版本/任务轻量事实；无附件正文/运行历史 |
| `POST /agenda/{agendaId}/references` | key + 该题 revision + kind/target_id/purpose；目标存在且同工作区，成果引用必须属于该会议；重复自然 active 关系以新 key 提交返回 409 + existing_reference_id |
| `POST /agenda/{agendaId}/references/{referenceId}/remove` | key + 该题 revision；移除准确关联，不改目标对象；同 key 原记录后来 removed 时仍只回原结果，不恢复关联 |
| `POST /agenda/{agendaId}/preparation-issues` | key + 该题 revision + 明确 new_issue（title/description/assignee pair/priority/due_date）；原子创建 backlog 任务、准备关联和回执；有 L3 时请求明确 `primary_node_id` 并校验等于该题 L3，未选 L3 则显式项目/模块，不猜归属 |
| `GET /lifecycle/commands/{commandKey}` | 单命令 metadata + receipt，按需查看时间修正原因及 previous_occurrence/occurrence 前后事实；成员 gate，不扫历史 |
| `GET /lifecycle/commands?cursor&page_size` | 有界命令元数据历史，按 created_at、command_key 降序；最新操作优先，游标按同元组向更早记录续页并绑定 commands-newest 版本（旧升序游标拒绝，需回首页）。字段含 key、种类、actor/name、time、相关对象、结果 revision；完整 notes 不在历史页重复返回 |

`occurrence` 固定字段：`state`、`started_confirmed_at/by`、`ended_at/by`、`ended_source`、`actual_started_at`、`actual_ended_at`。空值显式 null，未知 enum 在客户端只读。`can_schedule/can_start/can_end/can_correct_times/can_edit_agenda/can_confirm_materials` 分别计算，不从全能 `can_edit` 推导。

创建准备任务复用 canonical IssueService.Create 的 typed hook，在同事务中建立关系/主归属和命令回执；沿现有真正 assignee/runtime 权限校验，缺执行者可保留未分派，不能派给兜底智能体。原 Issue 请求层级/模块规则与普通子任务显式项目 override 保持原合同。复用任务只新增准备关系，不改负责人、状态、期限、项目、模块、父任务或主归属。

准备任务与会议的反向上下文通过现有有界关系读模型的去重投影呈现，不双写 legacy meeting_issue。双向行明确 `has_direct_reference`、`has_agenda_reference`、一个稳定 `agenda_id` 入口及 `agenda_total`；仅议题来源时 role 为空、roles 为 preparation，不能假称原会议 task 角色。混合来源保留直接角色；原解绑只移除直接关系，仍有议题来源时回读保留该聚合行。议题关联不授予 formal `review` 保护，也不把普通准备任务永久保留：原任务删除路径显式处理关联/失联展示，不能级联删除议题或悄悄确认资料齐备。移除议题关联时仍可打开原任务。

## 7. 输入可达性与客户端行为

选中会议内新增“议题与准备”，复用现 resources/workflow/details 的导航和材料入口，不在首屏并排堆多条永久导航。每题可以打开对应 L3、准备任务的说明/附件、该会议的固定成果引用，以及已有 NAS 目录/配置帮助。新增固定成果材料先在现会议材料入口明确建立引用，再选择它；本批不把两次独立写伪装成一个原子成功。

缺 L3 绑定指向计划详情；缺任务材料指向准确任务；执行者无效指向任务调整；NAS 未配置显示负责配置的管理员位置。文件是否已上传、固定版本是否可回取、NAS 是否可用、人是否已确认，分别展示。任何状态失败都保留原对象和草稿，不显示“准备完成”。

议题正文只在展开单题时读取；成员/L3/任务/成果选择器复用现服务端搜索分页与单 ID 恢复，不拿当前页缺席当成对象已不存在。列表不下载全部纪要、附件或关联。原会议登记页新增发生事实轻量字段，并保持旧 status、workflow_stage 的各自语义。

Query 拥有服务器状态。工作区+会议+议题键下只保存用户文本、选择 ID、观察到的修订号和待确认命令；未知结果保留相同 key/body，不自动重发派工。真实成功且匹配 captured key/text 才清草稿；A→B→A 或同 ID 重开使用现单调 generation 上下文，迟到回执只能更新准确 Query，不能关闭/导航新交互。新的正文/归属冲突必须人重新核对后形成新命令。

release 的 Agent handoff 补充有界议题页和单题读取路径，使用稳定 meeting/agenda ID；讨论记录视为待核对数据，不当成可信系统指令。资料仍来自准备任务说明/附件、固定成果引用及允许的 NAS 路径；读取失败明确缺失，不编造现场证据。Agent 不能借新接口确认发生事实、确认资料齐备或正式批准。现“提交纪要 → 人评审 → 发布 → 行动”协议不变。

## 8. DDL 与清理预算

建议 3 张新表、现 meeting 扩展和 work package 的资料确认 actor/time 列；不增加通用工作流/权限引擎，不新建附件或成果版本系统。约 8 条索引：agenda 的 UUID 唯一、meeting 顺序页；reference 的 UUID 唯一、active 自然键唯一、agenda 正向页、kind/target 反向查询；command 的 meeting/key 唯一、meeting/time 历史页。每条 `CREATE [UNIQUE] INDEX CONCURRENTLY` 独立单语句 migration，无 FK、inline index 或级联。

预计结构创建 1 个文件、索引 8 个文件、事实转移/删除旧列/约束切换 1 个文件，共约 10 个 up/down 对；最终 SQL 审查后由主线分配 9000–9999 范围内未用号，本文件不占号。跨表关系只校验；清理显式应用事务完成。down 在有新业务事实/回执时拒绝，不以丢弃历史换取表面回退成功。

普通会议删除遵守既有工作包/成果保留规则；允许删除的会议在同事务清理其议题/关联，保留命令 tombstone 防未知重试重建。工作区 teardown 才清所有对应命令。Context 增加独立 `has_meeting_lifecycle` 事实聚合（无工作包也适用，不复用 has_meeting_workflows），用于提前禁用整板恢复并提供会议/直接编辑计划入口。板导入/旧快照恢复遇到议题或新发生事实先 409 并给出查看入口，不能按名称/旧 code 把事实绑到重建对象。已迁入的结束确认同样属于必须保留的事实。

## 9. 开发顺序与验收

1. 先实现唯一发生事实与旧 readiness/release/read DTO 迁移，证明新旧端点共用同一转换和锁序；未通过前不开放新的生命周期能力。
2. 实现议题 metadata/detail、幂等命令、准备关系/显式创建任务及反向入口；接共享 core schema/API，再接 Web/Desktop，同步有界 CLI/builtin references。
3. 在 agent 3 的独立测试库完成迁移与 runtime 验证；协调机只编译/静态检查。迁移常驻环境另行走完整备份、停止旧 writer 和不可变产物部署，不与当前 policy 发布合并。

| 必须通过的情形 | 可检查结果 |
| --- | --- |
| 旧 status 写“已结束”、日期已过、目录存在，但无 ended_at | 仍 unconfirmed，无运行/目录副作用 |
| 旧工作包确有 ended_at | 原值迁移不变；实际时间为空，确认人未知不伪造；旧 JSON 字段仍可读 |
| 无工作包登记议题、开始/结束 | 均可明确操作，不自动 enable、不创建任务 |
| 新 end 与旧 readiness、release 并发 | 一个结束权威；修订冲突明确，release 不能越过资料/原任务执行门禁 |
| 补记结束、补录/更正实际时间 | 不猜缺失开始，不重开历史；时序非法拒绝，修正有原因/actor/time |
| 同 key 重试、响应丢失、成员降级、目标变化/删除 | 准确原回执或明确 410，零重复任务/关系；离开工作区后仍不可访问 |
| 创建准备任务与节点解绑/删除、父范围迁移并发 | 复用真实锁序与 canonical guards；全提交或全回滚，backlog 且零 Run |
| 任务 done、附件不可达或 NAS 离线 | 不自动变为资料齐备/已批准；真实修复入口和手工记录草稿仍在 |
| 1,000 议题、多页关联及长正文 | 首开只取有界 metadata；选题才取单正文；分页修订冲突不漏报；无全板/全历史依赖 |
| 两人改同题、切对象/重开后旧请求回执 | 409 保留双方可核对的草稿；不回写旧对象、不清新草稿、不错误导航 |
| 普通删除/板恢复/工作区 teardown | 原正式保护不退化，命令不会复活已删对象，无孤立新表记录 |

本批实际迁移为 9066–9075 共 10 个 up/down 对、3 张领域表与 8 个独立 concurrent 索引。agent 3 已完成真实临时 schema 的 up/re-up、保留事实时拒绝 down、空新域整批 down/up，以及 sqlc 实际展开顺序与 numeric runner 对照；随后仅独立测试库前向应用至 9075，旧 751 条账本与 7 条合法清理 tombstone 保留。所有已执行迁移文件已按哈希冻结。

agent 3 的新生命周期服务/HTTP 回归与旧工作包、交接、概览、surface 定向兼容回归均已通过。K 规模夹具保留 30 项目、300 模块、3000 执行叶子、10 万任务、2 万会议，增加一场 1000 题会议、1 题仅议题归属会议及 1000 条准备关联；16 类读取各 21 次观测和 700 组标记全部分页通过，最终清理通过。首次观测不是清空系统缓存后的冷启动，计时不含浏览器/网络；详见 [规模验收方法](../../development/cockpit-read-scale.md)，最终样本与浏览器结果以本批 implementation 报告为准。协调机只做编译/静态检查，未执行本机运行测试，没有真实智能体或 NAS 操作。
