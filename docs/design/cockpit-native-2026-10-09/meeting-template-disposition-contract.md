# 会议准备模板、取消与归档：阶段 L 实现合同

> **2026-10-12 总纲修订**：§4「ended 不可改成未举行」由切片 R2 的 reopen 修订（结束确认可更正留痕；取消前置仍限 scheduled/in_progress 的保护保留）；§5/§6 留存与恢复矩阵保留。 详见[设计总纲](./design-principles-2026-10-12.md)与[评审记录](./review-2026-10-12.md)。

状态：阶段 L 已实现、在 agent 3 验收并部署。9076–9091 的 32 个迁移文件已冻结；独立测试数据库账本 777 条，常驻数据库账本 780 条，旧记录与合法清理事实保留。发布源码 `bab527b42`，实际审核与验证边界见 [阶段 L 审核说明](review-meeting-preparation-2026-10-11.md)。基线为 K 的 [会议生命周期](meeting-lifecycle-contract.md)，不改写已应用的旧迁移。NAS 输入资料登记、可靠目录准备和长程自动化仍是后续范围，本文件只规定相关留存边界。

## 1. 本片必须完成的闭环

用户选模板、填写明确的上下文，先看将创建/关联什么，再确认；中断后能继续同一个实例，不能重新造一套任务。取消会议先展示现有准备工作，由人逐项决定保留或处置；归档只整理列表，不等于纪要通过、任务完成或成果验收。

准备模板首版只支持四种已具备真实业务入口的效果：登记议题、明确创建 `backlog` 准备任务、关联已有任务、关联该会议已登记的固定材料引用。开始/结束确认、资料齐备、纪要启用或接管、正式评审与发布不由模板代做。模板不派发智能体、不设置自动运行或提醒、不调用旧 provision 创建目录。

首片的“模板已应用”仅表示所选登记效果均有确认回执。它不能表示会议已召开、材料均可读取、准备任务已经执行或 NAS 已准备完成。模板页面保留原准备任务/材料/纪要入口，用户仍可在那里明确运行任务和推进既有流程。

## 2. 模板是配置，应用结果是实际对象

- 模板保留稳定 UUID；每次修改保存为新的不可变配置版本。版本中的议题、准备项使用稳定 slot UUID，改标题不换身份，新项分配新 UUID。
- 配置只表达本片支持的效果及必要输入槽位，没有任意脚本、条件执行语言、计时器或第二套任务状态机。配置正文可以使用严格、大小受限的结构化 JSON；实际任务、关系、应用进度和回执使用领域列/记录，不藏入旧 meeting.note。
- 每个 slot 明确标题、期望结果、工作记录初值或准备任务说明；L3、执行者、已有任务、固定材料由用户选择真实 UUID。可给选择提示，不能以姓名、编号或 NAS 文件夹名推绑定。
- 不强制为规划/边界讨论选择 L3。无 L3 的准备任务允许明确未归属和未分派；有 L3 时沿 K 的真实叶子与继承范围校验。任务创建固定 `backlog`，不继承来源任务的运行中状态。
- 固定材料槽位选的是目标会议已经登记的引用 ID；其版本可以是合法的 ready/pending 讨论材料。固定内容不等于已批准，展示该固定版本的真实 decision。原始录音/材料不得为了套模板被自动升级为成果、自动指定评审人或进入验收。
- 模板创建人或工作区 owner/admin 管理其配置版本与停用；当前人类成员可读和预览。应用还须满足目标会议、具体任务与引用的真实权限。模板创建人的权限不会借配置转交给使用者。

## 3. 预览授权与幂等应用

`POST /meetings/{id}/template-applications/preview` 只读，返回固定模板版本、会议/议题修订、已解析的 UUID 范围、逐项效果及阻止原因、影响总数和 `context_token`。预览不保存会议、不创建任务、不读写文件系统。Token 是当前事实的一致性凭据，不是权限凭据。

预览最多 50 个效果、总配置/输入快照最多 256 KiB；超过时明确拒绝并要求拆成多个模板。对象选择均使用有界搜索和单对象恢复。默认不选会产生额外对象的效果，用户明确勾选后确认；不能用一个总开关掩盖“新建任务”和“关联已有任务”的差别。

`POST /meetings/{id}/template-applications` 提交 `command_key`、`expected_revision`、`template_version_id`、`context_token` 和最终选择/参数。锁内重新验证人类成员、会议状态、范围、角色、执行者和固定引用；上下文发生变化返回 409，并保留输入供重新预览。不能重新读取模板最新版代替用户确认的版本。

应用头、冻结的所选效果及原命令回执一起提交。第一版对同一会议/模板版本只允许一个应用实例：同 key/actor/意图返回原实例；另一 key 命中现有实例返回 `application_exists` 与已有实例 ID，不给一个没有持久新回执的假 200。用户通过“继续此实例”恢复；额外临时工作用既有明确新增议题/准备任务入口，不重复套整份模板。

每个效果的实际对象与效果回执必须在同一业务事务提交；任务创建复用 canonical Create 的 typed hook、配额、权限和事件。不得先创建任务再补记“已创建”，也不能为模板复制一套任务创建逻辑。效果间依赖仅限本实例内“先创建议题，再关联其准备项”，没有自由编排。

一次明确确认授权全部选中效果（最多 50 项）。UI 随后按依赖顺序自动串行调用单效果 apply，无须用户每 10 项再确认；每个请求只提交一个业务事务。效果为 `applied`、`pending`、`needs_attention`、`skipped`，实例为 `active`、`paused`、`needs_attention`、`completed`。明确失败或人工暂停才停下来请求手动继续。响应未知时先 GET 精确效果及其固定回执，未确认则停止续发，不能自动重发未知命令。离开页面停止客户端推进，但不回滚已经提交的效果；返回后 GET 恢复，再由人继续原实例。第一版不另起后台调度器；GET 不推进实例，也不自动触发运行。

失败不回滚已确认的其它效果，不删除已创建任务。已经发生的效果只读保留；未生效效果可明确跳过并记录原因，不能把失败自动记为跳过。修改原意图须重新预览新命令，不能原地改旧 key/body。若已创建对象后来被用户删除，原命令返回已删除事实/410，不自动补造；补做使用既有明确创建入口。

同键回执先核当前工作区成员身份及原 actor/意图，再读取原结果，先于可能变化的目标角色、成员或绑定条件。已离开工作区不能读取/重放；另一个管理员不会自动扮演原操作者，接手剩余操作需要自己的显式授权记录和重新校验。

## 4. 取消的是尚未举行的会议，不是历史事实

正式 `cancel` 只允许 `unconfirmed/scheduled`，要求人给出原因。`in_progress` 应先记录实际结束；`ended` 不可改成“未举行”。旧自由 status 中写着“取消”不是正式取消事实。K 的唯一 ended_at 仍是结束确认时间，不能清空它来满足取消条件。

先用 `POST /meetings/{id}/cancellation/preview` 读取真实影响：当前生命周期/工作包修订、准备关系、任务操作依据、当前活动 Run、正式来源与引用、已存在的 NAS 操作。列表分页 25/最多 100；计数覆盖全范围，不因只看第一页少算。预览范围过大时明确要求先按准备任务分批处置，不能悄悄遗漏。

确认体含 `command_key`、`expected_revision`、`context_token`、reason 和逐项选择；未勾选条目默认保留。取消事实和所选处置计划原子保存，后续效果有各自确认回执。界面可以显示“会议已取消，2 项处置待完成”，不能在部分失败时显示“全部取消成功”。

准备项可选择：

| 选择 | 真实效果与边界 |
| --- | --- |
| 保留 | 仅记处置原因；原任务、负责人、期限和运行均不变。活动智能体仍可能继续消耗资源，确认中明确列出 |
| 调整准备期限 | 仅调用原任务期限变更；不改状态或运行。需当前任务修订与原权限，不能从会议新日期自动推所有任务期限 |
| 留待另一场会议 | 明确选择目标会议/议题并新增准备引用，保留原来源和处置记录；不改主归属、项目、模块、负责人或任务身份 |
| 取消普通准备任务 | 只在真实操作依据允许 closed 时执行 canonical 取消；保持 `cancelled/closed` 与 `done` 区别。普通唤醒订阅停用，系统规则在关闭期间休眠，未启动的 wakeup queued/deferred 行取消；其他排队任务和活动 Run 保留。正式评审任务不从此路径终结 |
| 请求停止已预览的运行 | 单独勾选准确 Run 集合并复核当前权限；只复用现有取消能力，沿既有 Stop 的 VIEW/cancel 授权（包含原有 owner/admin 治理权限），不借模板额外授予运行或 INVOKE 权限 |

执行取消任务/停止运行前，在原锁序内重核任务修订和活动 Run 集合；有新运行或保护关系变化则该项停止并要求重新预览。不能把“停止已确认的 2 个 Run”扩大成稍后出现的所有 Run。平台取消记录/通知执行端与执行端实际退出分开显示；外部进程、网络文件系统或已发送请求不承诺即时停止或可回滚。

任何已确认的成果、验收、纪要、行动关系都通过既有业务门禁校验。即使普通来源任务允许取消，它所产生的固定版本和正式结论也不会被撤销。需要改变正式决议、评审或生产责任时只给准确原对象入口，不从取消弹窗代批、代拒绝或暗中改派。

## 5. 留存与恢复矩阵

| 已有对象 | 取消/归档时必须保留 | 实际恢复入口 |
| --- | --- | --- |
| 议题、工作记录、准备关系 | 原 UUID、文字及命令历史；取消不是批量删除 | 会议的议题与准备、单题记录及历史 |
| 未开始的普通准备任务 | 默认保留；仅勾选且有权限的取消项才改为 closed | 原任务；需要恢复时明确改回 backlog/重新安排，不自动派发 |
| 活动 Agent/小队 Run | 默认继续；显式停止只针对预览集合，保留日志和取消结果 | 原 Run/任务入口，查询执行端状态；不自动新建替代 Run |
| 未 release 的纪要工作包 | 保留同一纪要任务/评审人/修订；取消状态阻止 ready→release | 明确“重新安排会议”，随后再确认事实/材料；若纪要任务被明确关闭，单独恢复 backlog |
| 已 release/已有正式纪要 | 正常情况下会议已确认结束，不可伪改为取消；版本和正式决定保留 | 原工作包、指定人评审、发布、交接等既有入口 |
| 已确认行动及其任务 | 不删除、不重新生成、不把取消会议当作行动撤销 | 原行动来源与任务；正式处置逐项明确执行 |
| 成果/验收/固定材料引用 | 原版本、hash、来源与评审责任不变；固定不等于通过 | 原成果/验收与固定版本读取入口 |
| NAS 已有文件和导出操作 | 不搬移、不删除、不改固定目标；归档不停止已授权的复制/恢复 | 原操作状态、固定路径和已有 retry；新目标必须独立确认新操作 |
| 仅登记了 base 路径的目录 | 不能宣称所有子目录已经准备成功，也不能借模板自动重试旧 provision | 当前资源入口；完整按步恢复须等待独立 NAS operation 能力 |

重新安排已取消会议使用同一会议 UUID、新的 key/revision 和原因，保留此前取消记录；只恢复发生状态/安排，不重放模板、不重启 Run、不重开所有任务、不改投 NAS。旧 readiness/end/release API 也必须经过这一权威转换，不能让旧客户端用 ended=true 绕过取消状态。

## 6. 归档与未完成工作分开

归档使用独立 `archived_at/by` 及原因，不复用 occurrence_state、Issue 状态或纪要 decision。归档/取消仍遵循 K 的成员与工作包管理权限，不从组织者自由文本推权限。

默认会议登记列表可隐藏归档记录，但必须有服务端 `archive=active|archived|all` 筛选和有界历史；精确 UUID、任务反向来源、图谱历史与固定引用仍可回看。未决正式评审、已授权运行、未完成行动及失败的处置操作继续出现在各自真实待处理队列，不能因归档或日期窗口消失。

归档可以发生在纪要/行动尚未闭环时，确认页明确展示剩余责任数量。它不撤销既有处理人的权限：原任务、指定人评审、已授权提交、NAS 重试继续沿既有规则办理。归档不应作为整个工作台全局 readOnly 的代用品。新增准备或再次套模板先明确取消归档；新旧客户端的写门禁都由服务端控制。

取消归档只恢复可见性/准备入口，不恢复旧运行、不修改任务状态、不重新发布纪要。未知操作结果保留相同 key，不能靠关弹窗换 key 再试。

## 7. 有界接口与最小持久化

接口均位于工作区 `/api/cockpit` 下；GET 不创建对象或产生效果：

- `meeting-templates`：模板元数据分页、单模板头、版本元数据页、单版本配置；默认 25、最多 100。写配置带 command_key 与 expected_revision，停用不删除历史版本。
- `meetings/{id}/template-applications/preview` 与确认创建接口；实例头/效果页分别读取，继续/跳过是独立显式命令。单实例效果最多 50，但不把每项的所有任务正文/运行历史带回。
- `meetings/{id}/cancellation/preview` 与确认接口；通过同一实例/效果读取合同回看准确逐项结果，不改变旧批量任务 API 的成功/错误语义。
- 生命周期的 cancel/reinstate/archive/unarchive 命令及历史；沿现持久 key 和固定回执，body 与当前状态分离。新增能力另加可用性字段；未知状态在旧客户端中只读，不以缺字段当允许。

模型使用 4 张新表：模板头、不可变模板配置版本、会议准备操作实例、操作效果。实例 kind 仅 `apply_template/cancel_preparation`，效果 kind 是本片固定清单，不能注册任意执行器或形成通用工作流引擎。实际对象 ID、状态、actor、修订与回执关系采用明确列；配置/冻结输入 JSON 有独立 schema/大小/hash 约束，不替代业务事实表。

会议本身增加取消与归档字段，主命令沿现生命周期 command ledger；取消历史通过命令保留，重新安排不伪删此前事实。模板应用实例关联固定模板版本；每效果保存稳定 slot/key 与实际议题/任务/引用/Run 身份，以便失败恢复和反向来源。

索引预算已冻结：需覆盖模板/版本 ID 与分页、版本幂等、实例 ID/meeting-command/meeting-template-version 唯一约束、实例分页、效果 ID/实例-slot 唯一约束、效果分页及实际目标反向读取。已分配 9076–9091：9076 结构、9077–9090 的 14 个独立索引、9091 新保护函数与约束。K 的 9066–9075 不改写。所有索引仍单文件 CONCURRENTLY，无 FK/级联；实例/效果由应用事务清理，已发生事实不能靠删除实例抹去。

## 8. 必须有的验收证据

1. 两客户端同时确认同一模板版本：一个实例，准确冲突/回执；同 key 响应丢失、操作者降级、模板新版本、已创建对象后来删除均不会重复造任务。
2. 第 3 个效果失败而前 2 个成功：界面保留前 2 个实际对象，显示剩余项；继续只推进原未完成项，进程重启/断网不变 key，也不自动运行智能体。
3. 预览后 L3 绑定、成员/私有执行权限、任务保护、运行集合或源固定引用变化：实际写拒绝对应旧计划，保留输入并可重读，不能换对象凑成功。
4. 取消尚未开始会议时，有普通准备、共享来源、正式 Review 和活动 Run：逐项真实权限与去向；正式结论不变，无未预览 Run 被停止，停止请求不冒称执行端已退出。
5. 已结束/已发布的会议不能取消成“未召开”；重新安排已取消会议不重启任务或 NAS，不重放模板。归档不隐藏未决正式评审/行动/失败处置。
6. 旧客户端仍可读原字段；面对取消/归档记录不能经旧 ready/release/create 入口绕过新门禁；新客户端未知 enum 失败关闭，并提供准确原对象入口。
7. 千模板/万实例历史仍元数据分页；效果、工作记录与运行按需读取。工作区 teardown 只清本工作区的新表，保留既有外部文件清理/迟到写入责任。

L 的定向事务、HTTP 与有界历史读取已取得 agent 3 运行证据；完整服务/HTTP 回归与真实浏览器链路仍以最终验收报告为准。本合同不宣称独立输入文件登记、可靠目录恢复或长程自动化已经交付，NAS 后续能力须另行验收。


## 9. 阶段 L 固定接口与线型

Go wire 定义以 `server/internal/service/cockpit_meeting_template_types.go`、`cockpit_meeting_disposition_types.go` 为准，生命周期仅向既有 DTO 添加字段。所有路径以下列 `/api/cockpit` 为前缀；当前成员读取，人类角色与事务校验写入。新能力分别为 `meeting_templates`、`meeting_disposition`。服务启动须具备完整 Issue/Task 事务和生命周期依赖才同时启用；测试及发布候选须完成本批验收，不借能力开关授予权限，不因缺少私有文件存储而关闭纯数据库准备功能。

| 方法与路径 | 输入 / 返回 |
| --- | --- |
| GET `/meeting-templates?q&include_inactive&cursor&page_size` | `CockpitMeetingTemplatePage`；25/100，metadata，不返回 config |
| POST `/meeting-templates` | `CockpitMeetingTemplateSaveInput`，首次 expected_revision=0；`CockpitMeetingTemplateSaveResult` |
| GET `/meeting-templates/commands/{commandKey}` | 当前成员中的原actor按key读 `CockpitMeetingTemplateSaveResult`，404仍未确认；不扫目录找回执 |
| GET `/meeting-templates/{templateId}` | `CockpitMeetingTemplateHeader` |
| POST `/meeting-templates/{templateId}/versions` | 同 SaveInput，expected_revision>0；每次全量保存含启停均生成不可变配置版本 |
| GET `/meeting-templates/{templateId}/versions?cursor&page_size` | `CockpitMeetingTemplateVersionPage`，number DESC |
| GET `/meeting-templates/{templateId}/versions/{versionId}` | `CockpitMeetingTemplateVersionDetail`，按需 config |
| POST `/meetings/{id}/template-applications/preview` | `CockpitTemplateApplicationPreviewInput` → `CockpitTemplateApplicationPreview`；无写入 |
| POST `/meetings/{id}/template-applications` | `CockpitTemplateApplicationInput` → `CockpitPreparationCommandResult` |
| GET `/meetings/{id}/preparation-operations?cursor&page_size` | `CockpitPreparationOperationPage`，最新优先 |
| GET `/meetings/{id}/preparation-operations/{operationId}` | `CockpitPreparationOperationHeader`，固定模板显示名/编号、当前负责人名称与真实办理能力 |
| GET `/meetings/{id}/preparation-operations/{operationId}/effects?cursor&page_size` | `CockpitPreparationEffectPage`，position ASC；25/100 |
| GET `/meetings/{id}/preparation-operations/{operationId}/effects/{effectId}` | `CockpitPreparationEffectDetail`，精确 effect/command_key/receipt，非当前状态猜回执 |
| POST `/meetings/{id}/preparation-operations/{operationId}/effects/{effectId}/apply` | `{command_key,authorization_key,authorization_revision}` 对应固定 effect 与当前明确 grant；`CockpitPreparationEffectResult` 同返 grant |
| GET `/meetings/{id}/preparation-operations/{operationId}/effects/{effectId}/authorization-preview` | `CockpitPreparationReauthorizationPreview`，仅失败未应用项，旧/新impact与固定intent hash |
| POST `/meetings/{id}/preparation-operations/{operationId}/effects/{effectId}/reauthorize` | 新 human key + effect expected_revision + context_token + reason；`CockpitPreparationCommandResult`，action=`preparation_reauthorize` |
| POST `/meetings/{id}/preparation-operations/{operationId}/control` | `CockpitPreparationControlInput`，transition=`pause/resume/skip/claim`；`CockpitPreparationCommandResult` |
| GET `/meetings/{id}/cancellation-impact?q&cursor&page_size` | `CockpitCancellationImpactPage`；任务去重、总数非当前页 |
| GET `/meetings/{id}/cancellation-impact/{issueId}/runs?cursor&page_size` | `CockpitDispositionRunPage`；准确 Run、原权限，不返回日志/配置 |
| POST `/meetings/{id}/cancellation/preview` | `CockpitCancellationPreviewInput` → `CockpitCancellationPreview`；≤50 selected effects，全范围计数 |
| POST `/meetings/{id}/cancellation/dispositions` | 同 `CockpitCancellationInput`；仅已取消会议，action=`preparation_dispose`，追加≤50效果计划，保留原取消事实 |
| POST `/meetings/{id}/cancellation` | `CockpitCancellationInput` → `CockpitPreparationCommandResult`；取消事实+处置实例原子提交 |
| POST `/meetings/{id}/lifecycle/disposition` | `CockpitMeetingDispositionInput` transition=`reinstate/archive/unarchive`，reason必填；原 `CockpitLifecycleCommandResult` |
| GET `/meetings/{id}/operation-basis` | `CockpitMeetingOperationBasis`；独立 delete/cancel/append_disposition/reinstate/archive/unarchive/add_preparation/apply_template，各 state/reason_codes 始终存在；最多3个真实 targets 与全量total |

### 模板配置及确认输入

`config.schema_version=1`，1–50 个 slot、配置与确认绑定合计最多 256 KiB。slot.kind 为 `agenda/preparation_issue/issue_reference/material_reference`；每个 slot 有稳定 slot_id、label。agenda 仅有 agenda defaults；其余必须引用本版本真实 agenda_slot_id，不能形成任意依赖图。preparation_issue 仅有 new_issue defaults；reference 仅有 purpose。无关字段必须 null/空，未知版本不可写。

title/label 非空且 trim，最多500 UTF-8字节；description/desired_outcome 最多16000字节、notes 最多65536字节，保留输入空白；priority 为 none/urgent/high/medium/low。模板编辑保存全量字段，关闭弹窗不丢精确 pending body/key。SaveResult.receipt 是固定完整 VersionDetail，可验证原 description/config；current 是后来可变化的头，不能代替原确认。

bindings 每 slot 恰一项，selected=false 的身份选择均为 null。agenda 允许 node_id/facilitator_user_id；任务允许 project/module/assignee pair/due_date；任务所依赖的 agenda 有 node_id 时，project/module 可 null，由服务端严格解析继承，非 null 必须相同。Issue 引用只接受 issue_id；材料只接受该会议已有 material_reference_id。引用不搬任务主归属、不改负责人。预览给真实解析范围和阻止原因，不从展示代码推 UUID。

operation.kind=`apply_template/cancel_preparation`，effect.kind 为以上四种加 `cancel_issue/change_due_date/link_meeting/stop_run`。每 effect 固定 command_key/slot/input/hash；初始授权持久后按依赖串行执行，exact receipt 和实际对象在同事务内提交。单效果失败保存 needs_attention，不偷换输入；resume 只允许重试原意图，改意图需独立重新预览。claim 仅现有会议管理者明确接手剩余效果，不伪造最初授权人。

### 取消的真实影响

Issue choices.action=`retain/cancel/change_due_date/link_meeting`，停止 Run 通过独立 run_ids 选择，不由 action=cancel 推导。未选择的任务/Run保留。预览的 affected_issue_total、unselected_issue_total、active_run_total、unselected_run_total 均覆盖会议真实准备范围；普通订阅停用、系统规则休眠、未启动 wakeup 取消、其它队列/运行保留分别计数。关闭任务不等于停止运行，重开任务不会重新启用普通订阅。

按条预览还固定 Issue revision、普通订阅身份/修订、系统规则集合、将取消的 wakeup 队列集合及相关 Run 状态。执行时新增会受影响的唤醒或运行不能偷纳入旧同意；该项 needs_attention 要求重读。停止指定 Run 只复用 canonical CancelTaskByUser 的授权、事务状态/恢复信号处理与提交后 reconcile/broadcast/NotifyTaskFinished；平台取消确认不冒称外部进程已退出。

### 回执、历史和分页

PreparationCommandReceipt 固定 context_token、template_version_id（取消为null）、operation_id、effect_ids、原 request_hash 与 occurrence（取消时非null）；不能用 current.operation 后来的状态确认最初命令。旧 key replay 先核当前membership及原actor/hash，再核原目标存续。成功 remove/skip 不因终态拒绝原回执，create/attach 原对象后删返回410不补造。

operation create/control 复用原 lifecycle command ledger，保存原 `CockpitLifecycleReceipt` envelope：revision/agenda_revision/request_hash 等K字段完整保留，新 preparation 子字段承载固定实例回执。归档命令同 envelope 返回 archive/previous_archive，发生取消/恢复同样保留 previous_occurrence。GET lifecycle/commands/{key} 继续返回原 Detail shape 的 additive字段；旧客户端未知action只读，不因新记录破坏整页。Effect详情由 effect自身唯一receipt读取，不将50个效果正文塞进历史 metadata。

列表25/100，游标绑定工作区/对象/过滤/页大小与排序。效果位置/集合确认后固定，执行状态变化不使顺序游标失效；当前页回读刷新状态。模板、操作和版本历史最新优先。Register 新 archive=`active|archived|all`，缺省active，并在响应回显；精确 UUID、反向来源、未决责任仍可读，归档不能藏掉待评审/待处理。

### 持久化预算与旧入口门禁

9076 四表 `cockpit_meeting_template`、`cockpit_meeting_template_version`、`cockpit_meeting_preparation_operation`、`cockpit_meeting_preparation_effect`；meeting 添 cancelled/archived 元数据，原 lifecycle command 添 operation/effect IDs。9077–9090：template id/page；version id、ws/template/number唯一、ws/command_key唯一；operation id、ws/meeting/command_key唯一、ws/meeting/template_version部分唯一、page；effect id、ws/operation/position唯一、ws/operation/slot唯一、ws/command_key唯一、issue反向索引。9091 新取消状态/准备历史保护；down 任一新增事实存在时整批拒绝，常规应用回退保留schema。

旧 occurrence/readiness/release、启用工作包、provision/import create_task、议题/准备新增和关系 append/replace 均重新核当前取消/归档事实；cancelled 禁止新准备/启动事实，恢复必须 reinstate；archived 禁止新增准备/模板，但不阻断既有正文修订、指定人正式评审/发布/交接、已授权运行或NAS恢复。已有准备operation历史与固定成果来源使单会议 delete 不可用；operation basis 给准确来源和归档入口。涉及实际会议/节点身份的实例、效果和取消/归档事实加入整板恢复保护；独立的工作区模板配置没有绑定且旧import不删除它们，因此仅有这些配置不能阻止整板restore，配置原样保留。Workspace teardown 显式事务清理新四表与账本；无数据库级联。


### 并发后的明确重新授权与分批处置

单 effect 的 command_key、原 input/hash、真实目标和业务字段不可改。初始 authorization_revision=1，authorization_key 为整组确认命令；当前 effect 保存独立 typed authorization snapshot/hash。需要处理时仅 `needs_attention` 且无成功 receipt 可 re-preview，展示上一授权与当前实际影响；applied/skipped 不可借新授权重做或复活。重新授权是新的 human command_key，锁定 workspace→meeting→operation→effect 后重读相关 Issue/wakeups/准确 Run 与权限，核 context_token/effect revision；在同事务写新 grant 与原 lifecycle ledger 的 fixed 前后授权回执。目标不存在仍410，改目标或业务意图仍是新操作。

Apply 必须携带 authorization_key/revision；即使 effect command_key 相同，旧在途请求也不能使用后来批准的作用范围。成功 receipt 固定同一 grant；旧未知请求遇到新 grant 的成功记录不能据此清草稿或当作旧请求成功。临时故障可 resume 原授权；预条件变化须显式 reauthorize。`can_resume` 与 `can_reauthorize` 分开，不能根据 userID 或状态自行推权限。

Cancellation preview 的 intent 明确为 `cancel` 或 `append_disposition`。首次 cancel 固定原取消事实；已取消会议可为未处理任务继续确认另一批≤50 effect 的处置计划，append_disposition 不重写最初 cancelled_at/by/reason。每批仍明确预览和确认，没有隐式遍历所有准备事项。

归档前已授权模板实例的未完效果可继续：验证 operation 与该 effect grant 的确认时刻不晚于 archived_at，仍核当下执行权限和固定输入。归档后不得产生新的模板准备授权；template effect 需要 reauthorize 时先解除归档。既有任务处置/停止运行可在归档期间继续或新增确认。已取消状态始终阻止模板准备效果，须明确 reinstate；直接旧创建/关联入口没有可传入的 bypass 标志。

普通关闭还会评估已有父任务规则；impact 返回 parent_issue_id 与 evaluates_parent_rules，提交后复用 canonical 子事件处理。此为既有授权规则的后续处理，不等于新建或暗中启用规则；不能宣称取消绝无后续自动工作。活动 Run 状态沿平台枚举 queued/deferred/dispatched/running/waiting_local_directory，can_stop与授权并核；未知状态只读。


### 显示身份、办理能力与实际范围

操作头固定 `template_title`、`template_version_number`（取消处置为空字符串/null），取不可变模板版本；`responsible_user_name` 为当前责任人的显示名。分页通过 JOIN 一次读取，不逐行读取配置正文。标题/姓名只用于辨认，命令确认仍核 UUID、key、revision 和固定回执。

`can_continue`、`can_resume`、`can_pause`、`can_claim` 与效果的 `can_apply/can_skip/can_reauthorize` 分别投影真实权限和会议事实。会议已取消时，旧模板实例的继续/恢复均禁用并给 `meeting_cancelled`；不能让用户只能点到 409。归档前的原授权可继续/恢复；模板重新授权是新确认，归档时必须先解除归档。处置实例沿自己的真实规则办理。`operation-basis.append_disposition` 是独立字段，仅已取消且有权管理者可建立后续处置，不从第一次取消按钮或第一页事项推断。

固定 NodeID 的项目/模块继承范围属于授权事实：同一 L3 的映射变化后，旧效果先进入 needs_attention，重新预览显示上一授权 scope 与当前 scope 的 UUID/名称；人明确确认后，新的 grant.Scope 控制创建范围，NodeID、原任务文字和效果 command_key 不变。无 L3 时显式 project/module 是原意图，不允许借重新授权换目标。前一效果新增议题、创建任务或停止同一确认集合中的运行，不作为后续效果的无关失效条件；新增未选运行、真实归属/权限/固定目标变化仍须重新确认。

所选 Run 的旧 `selected_run` 与新 `current_run` 明确返回同一准确 ID、status、can_stop。目标自然完成只记录 `changed=false` 与观察到的 terminal status，不能谎称本次停止；新出现的未选 Run 保持不变。实际效果回执的 `facts_hash` 覆盖真正发生的 Issue 快照、目标和完整受影响 ID 集合；两个 ID 数组各最多 100 个样本，真实 totals 不受样本限制，不能把样本当完整名单。

`GET /api/tasks/{taskId}` 和现有 messages 读取共同使用准确 task 的既有 VIEW 权限；单对象读取不扫所有运行、不需要 INVOKE，也不借成员身份越过私有执行者访问门禁。停止仍经过原 canonical 事务与提交后通知，不复制另一种取消实现。

会议登记页默认 active；计划 markers 同样回显并把 archive 筛选绑定游标，默认 active，可包括归档。节点详情及节点反向会议默认 all，Issue/正式来源保持全部历史。首页近期会议只显示 active，但正式待评审、未处理任务与失败处置不因归档消失。
