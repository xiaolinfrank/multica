# 成果与验收真实接口合同

2026-10-11。本文件收紧准备版 [成果合同](./artifact-acceptance-contract.md)，实施范围为 9000–9064 的 14 张领域表、50 个独立 concurrent 索引及正式任务保护；9065 独立修正保留关系查询的规模性能，旧文件保持冻结。完整运行时及候选 `092fcf059` 已通过 agent 3 隔离验收，能力只在完整装配且客户端明确声明协议时开放。常驻仍为 994；普通任务操作入口补齐后再发布。

## 协商与权限

新客户端的驾驶舱 context/detail 等范围化读取声明 query 参数 `client_contract=artifacts-v1`。服务完整就绪且认识该声明时才返回 `capabilities.artifacts/acceptance=true`；旧、缺省、未知声明均为 false，URL 参数区分响应缓存；该声明不进入业务游标指纹。旧服务忽略未知参数，避免自定义请求头使旧 CORS 拒绝现有读取。声明不授权任何操作，不能代替登录、工作区成员和业务权限。没有 producer_issue_id 的提交明确拒绝，不为准备版客户端猜生产任务。

- 登记成果：人类工作区成员；绑定有效叶子 L3，原始来源 Issue 与该 L3 项目/模块一致，不移动 Issue。
- 管理者：对象的真实创建者或当前工作区 owner/admin，且仍是当前成员。L3 条件首次配置仅 owner/admin；后续为定义创建者或当前 owner/admin。不从 owner/collaborators 自由文本推权限。
- 提交版本：人类管理者或当前授权生产 Issue 的人类执行者；Agent 仅能用绑定该生产 Issue/实际 Run 的可信任务凭据提交。Run 身份由服务推导，请求不能填任意 Run UUID。
- 正式评审：仅当轮指定人类成员。普通 Issue 改派、done、Agent 成功或管理员身份均不构成批准；交接是独立管理命令。
- 固定引用：人类成果管理者明确创建/撤销。引用提供上下文，不授予提交/评审权限，不转移所有权。

创建/提交/请求/交接/引用命令保留原 key 和规范化意图 hash。已成功同键重试先读取准确回执，再检查可能变化的当前 pin/目标成员；不同意图或操作者 409。当前身份仍须通过成员和凭据校验。数据库内原子提交业务事实、关联与正式人类任务，外部存储 I/O 不持业务行锁。

## 既有准备接口的收紧

基础路径均为 `/api/cockpit`，工作区由 `X-Workspace-ID` 选择。集合默认25/最大100，游标绑定工作区、对象、筛选、页大小；列表只含元信息，正文与完整反馈只按指定版本/请求读取。

| 接口 | 最终输入/读法 |
| --- | --- |
| `GET /artifacts` | 既有 project_id/module_id/node_id/source_issue_id/q/status/cursor/page_size；node_id 范围新增 relation=owned/referenced/all，默认 owned；非 node 范围只按所属 L3 筛选，不猜会议范围 |
| `POST /artifacts` | creation_key,node_id,source_issue_id,title,description,reviewer_id；原始来源及主 L3 不随以后生产责任更换 |
| `GET /artifacts/{id}` / `PATCH` | 读原始来源与当前生产任务；PATCH仅 expected_revision,title,description |
| `POST /artifacts/{id}/versions` | expected_revision 为成果头修订；submission_key,producer_issue_id 必填；payload 为 text/content 或 attachment/attachment_id；source_meeting_id/source_minutes_version_id 可选，后者必须匹配同会议固定已发布版本 |
| `GET /artifacts/{id}/source-attachments` | q/cursor/page_size；当前 producer 的平台附件，回显 producer_issue_id；已选附件单ID恢复也核该生产任务 |
| `POST /artifacts/{id}/versions/{versionId}/review` | expected_revision 为版本修订；decision=approved/changes_requested/rejected、feedback；非通过必须非空，最多16000 UTF-8字节 |
| `POST /artifacts/{id}/versions/{versionId}/capture/retry` | expected_revision 为版本修订；人类管理者只重试原版本/来源，不改目标或原始来源 |
| `POST /artifacts/{id}/archive` / `unarchive` | expected_revision 为成果头修订；只变当前归档状态及审计，不删除历史。未完成复制/待正式评审时不能归档；已有目标状态可幂等读回，不重复审计 |
| `GET /artifacts/{id}/versions/{versionId}/download-link` | 每次点击获取60秒单版本短签名；固定到工作区/成果/版本/hash。签名下载流式读取自有对象，沿用安全响应头，不重定向任意客户端URL |

成果头新增 `created_by,producer_issue,can_assign_producer,can_reassign_reviewer,can_reference,can_restore,evidence_version`。`source_issue` 始终是原始来源；`producer_issue` 才是允许新提交的任务。`evidence_version` 仅在明确 node_id 查询范围，且该 L3 是成果所属者或对当前 approved 版持有活动引用时返回该固定元信息，否则 null。验收候选只用此 pin，不能看到旧 v1 引用后自动采用未被该 L3 引用的 v2。

版本元信息新增 `producer_issue_id,producer_issue_identifier,producer_issue_title,producer_run_id,source_meeting_id,source_meeting_title,source_minutes_version_id,source_minutes_version_number`；ID与当时的最小来源标签在提交时固定。旧历史不随 Issue 名称、生产责任或会议纪要版本改变。文件未固化时 content_hash/size_bytes 可空，decision=not_requested，review_issue=null；202仅确认持久意图。

单版本详情另返 content_available/content_unavailable_reason；验收详情另返 evidence_available/evidence_unavailable_reason。需要存储核验时，先读固定 key/hash 投影并结束读事务，在业务锁外验证，再进入事务核对同版本、hash、pin、条件与权限。can_review 表示当轮指定人的正式决策资格；内容不可用或验收条件/证据过期只阻止 approved，不阻止该人以必填反馈提交 changes_requested/rejected 来结束本轮。仅通过命令依赖锁外核验及锁内当前事实复核；不可用不会改写旧批准，晚到核验不能使新版本获得通过资格。

文本固化及 Review Issue 同事务创建；文件经持久 capture/attempt、独立对象键和事务外复制/回读，再在同一业务事务核租约并进入 ready/pending 与创建 Review Issue。源附件不可用、租约失效、评审人失效时保持可恢复事实，不伪称待评审。对象清理使用返回错误的 DeleteObject；工作区删后仍保留必要清理意图直至确认，不删除 NAS 团队副本。

## 生产责任与评审责任

| 接口 | 命令/结果 |
| --- | --- |
| `POST /artifacts/{id}/producer` | expected_revision,command_key,reason，加 issue_id 或 new_issue 二选一；已有任务不改状态/归属/执行者。new_issue 为 title,description,assignee_type,assignee_id,priority?,due_date?，项目/模块由成果归属确定；经 canonical Create 同事务新建 backlog 任务及授权关联，不自动派工 |
| `GET /artifacts/{id}/producer-history` | cursor/page_size；独立分页，原/新 Issue、操作者、原因、时间和结果修订 |
| `POST /artifacts/{id}/reviewer` | expected_revision,handoff_key,reviewer_id,reason；改未来默认评审人；当前 ready/pending 版另建人类 Review Issue、取消旧责任并更新该版正式绑定；当前 decision=not_requested 的固化中/失败版本可同版本更新指定人，不建虚假Review |
| `GET /artifacts/{id}/reviewer-handoffs` | cursor/page_size；保留旧/新正式评审人与任务，历史决定不变 |

原因 trim 后须1–16000 UTF-8字节。同人交接拒绝为无效命令。生产授权改变不改旧版本，不撤销旧 Run，也不让旧任务继续提交新版本。正式评审交接不改内容/hash/版本ID/提交键；退休 Review Issue 永久保留执行与删除保护。

生产命令返回 `{workspace_id,artifact,assignment,to_issue}`，to_issue 是该命令准确目标的当前轻量事实；评审交接返回 `{workspace_id,artifact,version,handoff}`，version 是关联版本的当前元信息或 null，handoff 是该 key 的固定回执。历史重试以 ledger 的 to/from 身份确认命令，不把当前版本后来发生的再次交接冒充原命令结果。

assignment 字段：`id,artifact_id,command_key,from_issue_id,to_issue_id,reason,created_by,created_at,revision`。

handoff 字段：`id,artifact_id,handoff_key,from_reviewer_id,to_reviewer_id,version_id,version_number,from_review_issue_id,to_review_issue_id,reason,created_by,created_at,revision`。当前 decision=not_requested 版本尚未建立正式任务时，version 指针有值而两 Issue 指针都为 null；交接只改变指定人/修订，不重提内容。没有当前版本或当前已有正式终态时，version/Issue 指针为 null，只改变未来默认值。

## 固定版本引用

| 接口 | 输入/行为 |
| --- | --- |
| `GET/POST /artifacts/{id}/node-references` | GET cursor/page_size；POST reference_key,version_id,node_id,purpose |
| `GET/POST /artifacts/{id}/meeting-references` | 同上，目标改为 meeting_id |
| `DELETE /artifacts/{id}/node-references/{referenceId}` | 明确撤销，保留历史，重复撤销返回原记录，不重新激活 |
| `DELETE /artifacts/{id}/meeting-references/{referenceId}` | 同上 |

purpose 为 input/output/evidence/reference。目标须同工作区且真实存在；节点目标须有效叶子 L3。版本必须 ready，可明确引用候选或历史已批准版，但引用不批准它，也不保证它符合当前验收条件。

关系字段：`id,artifact_id,version_id,version_number,content_hash,reference_key,node_id|meeting_id,target_label,purpose,created_by,created_at,removed_by,removed_at`。创建/撤销返回 `{workspace_id,reference}`，集合返回 `{workspace_id,artifact_id,items,total,next_cursor}`；保留撤销行供追溯。自然键与命令键分别去重；再次使用曾撤销的 key 不新建、不恢复。

## L3 验收

沿用准备接口 `/nodes/{id}/acceptance`、`/criteria`、`/requests` 及 `/requests/{requestId}/review`。验收从不改普通 L3 状态/进度，也不自动推进 Agent 或下游工作。

- 条件修改 expected_revision 对应定义修订；可显式清空当前定义，但无条件不能发起请求。最多50条，每条证据1–20版，一次最多200个不同固定版；note/feedback最多16000 UTF-8字节。
- 请求固定条件文字/顺序、版本证据与 evidence_hash；request_key、expected_criteria_revision、reviewer_id、evidence、note，以及明确的 supersedes_request_id（仅替代已经失效的当前 pending 请求）。
- 发起和通过时都重新核对：当前条件修订、每份成果当前 approved pin、固定内容可回取、所属/活动引用资格。过期请求保留原快照并拒绝通过；新请求原子取消旧人类任务、记录替代关系并新建任务。
- 评审 expected_revision 是请求修订，只有该请求当前指定人可以提交正式结论；条件/证据过期只阻止通过，不阻止退回/拒绝；已通过历史不改写。之后版本/条件变化标 needs_reacceptance。
- `POST /nodes/{id}/acceptance/requests/{requestId}/reviewer`：expected_revision,handoff_key,reviewer_id,reason；只交接当前 pending 请求，不修改已决历史。
- `GET /nodes/{id}/acceptance/reviewer-handoffs?cursor&page_size`：独立历史页。回执含 request_id 和原/新 Review Issue，响应 `{workspace_id,acceptance,request,handoff}`，request 是对应请求详情。

验收头增加 `can_reassign_reviewer`，请求详情继续保留 definition_changed/evidence_outdated。新的评审任务由 canonical IssueService 创建；归属/负责人/状态的普通编辑不能恢复已交接的正式权限。

## 集成与完成条件

`GET /issues/{issueId}/artifacts?cursor&page_size` 提供权威反向上下文；先使用 Issue/工作区 loader 校验权限。返回 `{workspace_id,issue_id,items,total,next_cursor}`，25/100 分页。item 见 `CockpitIssueArtifactContext`：`kind=artifact|artifact_version|acceptance_request`，`id` 是对应领域对象 ID；包含 roles、小型可读标签和明确的 artifact_id/version_id/version_number 或 node_id/request_id，不返回正文。游标按 kind+id，绑定当前 Issue/工作区/页大小。

同一对象或固定版本只出现一行，roles 去重，取值 origin/current_producer/former_producer/version_producer/review/retired_review/acceptance_review。former_producer 保留曾获生产授权但未提交版本的责任历史。一个 Issue 生产十万版本时仍是分页十万条，不把所有版本塞进单个数组。is_current_review 表示该 Issue 仍承担当前 pending 的正式责任，不表示任意访问者有审批权；历史角色和取消后的任务保持可追溯，入口不提供假解绑。

后端写入、状态机、存储 worker、签名下载、两域交接、引用和验收真实闭环全部通过后，才允许协商后的 capability 返回 true。删除 Issue/节点/项目/模块、绑定/父级变更、导入/restore 与工作区删除均守卫新事实；不在触发器做隐式清理或状态推进。

复用 source Issue 的归档审计只记录操作事件，正式状态仍在 artifact 表；不能把版本、批准、证据或权限塞入活动 JSON。新字段与方法须同步 core/schema/客户端与 CLI；准备版 UI 不通过省略字段的兼容猜测接入正式服务。所有运行验证在 agent 3，文件测试使用测试对象，不接触真实业务附件或 NAS。

### Bounded evidence restoration and new producer task input

`GET /artifacts` accepts one comma-separated `ids` parameter containing at most 100 distinct artifact UUIDs. Normalize and sort `scope.ids`; omit it as an empty array. It can combine with `node_id` and `relation=all` so evidence restoration uses the authoritative `evidence_version` pin. It cannot combine with nonempty `q` or `status`. The cursor binds the complete scope and ID set. Single-artifact GET also accepts `node_id`; without a node context `evidence_version` is null. No fallback to the globally approved version establishes L3 evidence eligibility.

For producer assignment `new_issue`, use the existing planning Issue field semantics: title/description, optional priority (`none`, `urgent`, `high`, `medium`, `low`; default `none`), optional assignee pair, and optional due_date. Both assignee fields omitted/null default to the human command actor; this path does not create an unassigned task. An explicit assignee requires a known member/agent/squad type and nonempty UUID. An absent/null due_date means no due date; an empty string is invalid. Project/module come from the artifact, status is backlog, and no Agent run is dispatched. Command ACK uses the fixed assignment key and to_issue_id; the returned Issue is a live projection whose title and status may have changed since initial success.

### Runtime recovery and bounded projections

File finalization is an effect of a durable, previously authorized submission. It does not require the original submitting member to remain in the workspace; it still rechecks the live workspace, current version, lease and current designated reviewer. An explicit human retry/handoff requires current membership and manager authority. A verified attempt is reused after reviewer or quota recovery without rereading a deleted source attachment. Replacing a failed, never-reviewed version schedules its abandoned objects for cleanup; approved/ready historical versions retain their fixed objects.

Object cleanup intents outlive workspace deletion. Only attempts whose storage call has returned are eligible for automatic deletion. A crashed call with no completion fact keeps its intent for reconciliation rather than claiming cancellation. Deleted-object intents remain as minimal tombstones and are rechecked daily, so an ambiguously late provider upload remains owned and can be removed; this is eventual cleanup, not a claim that a provider timeout undid external I/O. Stored NAS exports are outside this object-store cleanup domain.

Artifact list headers batch version pins, Issue facts, owner labels and evidence eligibility. No version body is loaded for a list. With node_id, project/module identify the target L3 and are validated against its explicit ancestor bindings. References to artifacts owned by another project/module remain visible under relation=referenced/all; the artifact header continues to report its true owner scope.

Issue reverse-context pages include a nullable, authoritative `formal_review` independently of pagination: `{kind,stage,node_id,artifact_id,version_id,request_id}`. Its stage (`pending`, `done`, `closed`) comes from the same domain facts as the database guard. Clients must not infer absence of a formal review from the current page. The formal relationship fixes assignee and primary L3; ordinary status changes cannot finish a pending review or reopen a decided/retired one.

### Synchronous verification budget and remaining large-file work

A fixed-content probe has a 20-second total deadline, shorter than the synchronous HTTP request budget. Acceptance shares one deadline across the entire evidence set rather than restarting a timer for each file. Cooperative storage readers are closed on timeout/cancellation. No detached goroutine claims it cancelled a provider operation. Detail responses use `verification_timeout`; the designated reviewer retains the ability to return/reject with feedback, while approval requires a successful proof. Historical approved conclusions remain unchanged.

This fail-fast bound does **not** complete the large-materials requirement: the permitted extreme of 200 × 500 MiB can repeatedly exceed it. A required follow-up is durable, batched verification with recoverable progress and reusable proofs bound to immutable version/key/hash plus current storage identity. Before accepting those proofs, the business transaction must still recheck the exact current request, criteria, referenced versions and reviewer. This batch does not invent such progress, weaken the hash check, lower the allowed evidence count silently, or label an incomplete synchronous probe successful.
