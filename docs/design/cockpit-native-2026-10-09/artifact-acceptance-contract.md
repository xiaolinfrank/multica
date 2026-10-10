# 通用成果与 L3 验收合同

本合同承接 proposal 中的“执行与证据链”。代码候选已通过 agent 3 隔离验收，尚未部署常驻或生产；实际状态见[开发进度](./implementation-status.md)。新增 fork 编号范围已确认扩至 9000–9999，本批为 9000–9064，另以 9065 修正保留关系查询；不修改已应用迁移，不将正式成果混入纪要版本表，不把附件名称分组当作版本身份。

此前准备版 API 以固定 `artifact.source_issue` 与单一主 L3 为首条路径，并非[主提案 §7.1](./proposal.md#71-逻辑对象与物理存储分离)的完整交付。最终模型必须让每个版本分别记录生产来源 Issue、Run 和会议，且同一成果可被多个 L3、会议显式引用。

本批最终合同见 [真实接口与权限合同](./artifact-runtime-contract.md)。保留成果最初来源不可偷换；版本另设 `producer_issue_id` 及可空的来源 Run/会议身份，并校验 Run 属于该生产任务、附件属于本轮生产任务、范围与权限一致。来源会议还应能固定到相应纪要版本，避免后来纪要改版改变出处。多 L3/会议引用使用独立关系，不用覆盖主归属或复制成果身份实现。新任务生产后续版本须有明确选择与授权，现有首条 API、已写客户端合同在协调前不静默扩展。

## 固定事实

- 成果有稳定 ID、主 L3、来源任务、标题和指定的人类评审人。来源任务可尚未纳管主归属，但必须属于该 L3 已绑定的项目、模块；登记成果不移动任务。其他 L3 可以明确引用同一已批准版本作为验收证据。
- 一个版本保存一份文本或一个文件。多份必要成果以多个成果对象表达。文本保存精确 UTF-8 字节；文件从明确选中的平台附件复制到独立受控对象，不能仅保存源附件 URL、NAS 路径或内容 hash。
- 文件复制先有持久意图，之后在数据库事务外读写。每次尝试使用独立对象键，旧租约不能完成新尝试。复制、回读核验成功后，版本与正式人类评审任务在同一业务事务中进入待评审；失败不得出现待评审或可验收假象。
- 复制状态与业务评审结论分开。评审任务完成、Agent 运行完成、复制成功都不代表成果获批或 L3 已验收。
- 评审只允许当轮指定的人类成员作出通过、退回修改或拒绝。任务的普通改派不转移正式评审权限；评审任务进入 done 不批准版本。评审人离职必须走显式责任交接，不能默认授予管理员代批权限。
- 当前版本正在固化或待评审时，不允许新提交悄悄替代它。正式评审仅针对当前已固化版本；历史版本只读。通过可不填反馈，退回修改或拒绝必须提供非空原因，最多 16000 个 UTF-8 字节。
- 退回修改只登记此版本的正式反馈与结论，结束当轮人类评审任务；不反向修改可能承载多份成果的来源任务状态，也不自动派发 Agent。界面提供“在来源任务处理反馈、提交修订版”的真实入口。来源任务完成不等于成果通过，评审任务完成也只表示评审工作结束。
- 修订通过明确授权的生产任务提交；原始来源任务不可改写。新建或接管修订任务必须走下文生产责任交接命令，不因新增普通参考关系自动取得提交权。每次提交明确携带生产任务 ID，并固定该版来源。
- L3 验收请求固定验收条件修订及明确的成果版本集合。全部必要条件须有已批准、可回取的版本证据；最终结论仍由指定的人作出，不按任务完成比例计算。
- 后续新版本、条件变更会显示影响提示，但不改写旧评审与旧验收事实。L3 的正式验收状态与旧自由文本状态、人工进度分别展示。
- 新验收请求及通过时，证据必须仍为各成果的当前已批准版本。评审前条件或证据已更新时，保留原快照并阻止通过；新请求显式传入 `supersedes_request_id`。服务同事务取消旧人工验收任务、登记旧请求被替代时间并创建新请求；不伪造拒绝结论。

## API

下列路径均位于 `/api/cockpit`，沿用工作区成员校验及 `X-Workspace-ID`。所有 UUID 输入必须明确解析；机器凭据只能提交其实际来源任务的成果，不能代替人类评审或验收。

| 请求 | 输入与行为 |
| --- | --- |
| `GET /artifacts` | `project_id,module_id,node_id,source_issue_id,q,status,cursor,page_size`；元信息分页 |
| `POST /artifacts` | `creation_key,node_id,source_issue_id,title,description,reviewer_id`；明确登记独立成果，不合并同名文件 |
| `GET /artifacts/{artifactId}` | 头信息、当前/已批准版本元信息、数量和操作能力；无全历史正文 |
| `PATCH /artifacts/{artifactId}` | `expected_revision,title,description`；来源、主 L3 不随普通编辑移动 |
| `GET /artifacts/{artifactId}/versions` | `cursor,page_size`；版本元信息分页 |
| `POST /artifacts/{artifactId}/versions` | `expected_revision,submission_key,producer_issue_id,source_meeting_id?,source_minutes_version_id?,payload`；payload 为 `{kind:"text",content}` 或 `{kind:"attachment",attachment_id}`，不得夹带另一类型字段 |
| `GET /artifacts/{artifactId}/versions/{versionId}` | 单版本详情。文本包含正文；文件包含受控下载入口；反馈按此版本读取 |
| `GET /artifacts/{artifactId}/versions/{versionId}/download` | 校验成员权限与固定内容后取文件；不接受任意 URL/路径 |
| `GET /artifacts/{artifactId}/versions/{versionId}/download-link` | 每次点击时获取短时可直接下载链接，返回 `workspace_id,artifact_id,version_id,url,expires_at`，不依赖浏览器携带 API token |
| `GET /artifacts/{artifactId}/source-attachments` | `q,cursor,page_size`；只查询本成果当前授权生产任务的附件元信息，并回显 producer_issue_id，不加载该任务的全部附件 |
| `POST /artifacts/{artifactId}/versions/{versionId}/capture/retry` | `expected_revision`；只重试原来源/版本，不能换文件或目标 |
| `POST /artifacts/{artifactId}/versions/{versionId}/review` | `expected_revision,decision,feedback`；指定人类评审，decision 为 `approved/changes_requested/rejected` |
| `GET /nodes/{nodeId}/acceptance` | 当前定义修订、当前/最后通过的验收元信息、数量、变化提示与能力 |
| `GET /nodes/{nodeId}/acceptance/criteria` | 条件、定义修订、配置能力；限制一次定义规模，避免无界表单 |
| `PUT /nodes/{nodeId}/acceptance/criteria` | `expected_revision,criteria`；稳定条件 ID、标题、说明、顺序；被历史验收引用的条件保留身份 |
| `GET /nodes/{nodeId}/acceptance/requests` | `cursor,page_size`；验收历史元信息分页 |
| `POST /nodes/{nodeId}/acceptance/requests` | `request_key,expected_criteria_revision,reviewer_id,evidence:[{criterion_id,version_ids:[]}],note,supersedes_request_id?`；固定条件与证据，并原子创建人工验收任务；替代失效的待审请求时必须明确旧请求 ID |
| `GET /nodes/{nodeId}/acceptance/requests/{requestId}` | 单次验收的固定条件、证据、正式结论与当前变化提示 |
| `POST /nodes/{nodeId}/acceptance/requests/{requestId}/review` | `expected_revision,decision,feedback`；只有指定人类可以通过/退回/拒绝 |

默认每页 25、最多 100；游标绑定工作区、对象、过滤条件与页大小。列表返回 `workspace_id,scope,items,total,filtered_total,next_cursor`，正文与完整反馈不塞入列表。`module_id` 必须真实属于所选项目；不存在或跨工作区范围返回 404，不能伪装成空集合。

成果列表 `status` 筛选当前团队事实：空值为全部（包括归档）；`draft` 为无版本，`capturing` 为当前复制排队/执行/退避，`needs_attention` 为复制需处理，`pending` 为当前固定版待评审，另有 `approved/changes_requested/rejected/archived/unknown`。它不是“待我评审”；当前待审版与最后已批准版分别显示。列表的 `can_create` 仅对允许登记的人类返回 true。

写响应返回明确的目标对象与回执：创建键/提交键/验收请求键、目标 ID、版本号、修订和固定内容 hash；没有依赖“本次对象恰好在第一页”的确认逻辑。成果创建/编辑返回成果头；版本提交/评审/复制重试返回 `{workspace_id,artifact,version}`，其中 version 是该请求准确对应的单版本详情，历史提交键重放也不能改回当前 pin。异步复制受理返回 202，只代表已登记意图。相同键相同意图返回原对象，不同意图 409；对象归档或来源任务被删除后不能复用旧键制造第二份成果。

## 读模型

成果头：`id,workspace_id,creation_key,node_id,node_label,project_id,module_id,source_issue,title,description,revision,reviewer_id,archived_at,current_version,approved_version,version_count,can_edit,can_submit,can_archive`。

版本元信息：`id,artifact_id,version_number,submission_key,revision,payload_kind,source_attachment_id,filename,content_type,size_bytes,content_hash,capture_status,capture_error_code,capture_error,decision,reviewer_id,review_issue,submitted_by_type,submitted_by_id,created_at,reviewed_at,has_feedback,can_review,can_retry_capture`。

`capture_status`：`queued/running/retry_wait/ready/needs_attention`。文本直接进入 ready。`decision`：`not_requested/pending/approved/changes_requested/rejected`。文件未完成固化时 review_issue 为 null，decision 为 not_requested；不能显示评审人已收到可评审文件。

验收头：`node_id,criteria_revision,current_request,last_approved_request,request_count,can_edit_criteria,can_request,needs_reacceptance`。验收历史记录保留 `request_key,criteria_revision,evidence_hash,reviewer_id,review_issue,decision,feedback,created_by,created_at,reviewed_at`。`needs_reacceptance` 是当前定义/必要证据与旧验收的差异提示，不抹掉旧的通过结论。

可直接用于客户端接线的 Go DTO 与输入结构见 `server/internal/service/cockpit_artifact_contract.go`。验收定义最多 50 条，每条引用 1–20 个固定成果版本，一次验收最多 200 个不同版本；定义返回 `max_items`。当前条件都属于必要条件，不引入未定义权重的百分比。后续若需要可选条件或加权验收，应独立说明业务口径。

允许显式保存空条件定义以清空当前要求并推进修订；旧验收快照保留。没有条件时不允许发起验收。

## 复用与新增数据

复用现有 IssueService.Create、权限/配额/归因、人工任务与禁止 Agent 执行的门禁、附件上传与存储读取/流式上传接口、已有文件预览安全头。正式版本拥有独立受控副本，源附件删除不删除成果版本。外部存储动作不进入持有业务行锁的事务。

新增职责分明的成果、版本、验收条件、验收请求、证据关系、文件固化意图。旧 source_context 表要求评论锚点和来源任务捕获生命周期，不能借其记录通用成果；其复制/清理模式可复用。评审责任交接沿用已有“保留历史、创建新人工评审任务、撤销旧责任”的语义，本批使用独立交接账本保留正式责任变更。

任务、节点、项目/模块、工作区删除和快照恢复都要覆盖新事实的保护与清理。工作区删除清理数据库事实与平台自有成果对象；不删除 NAS 上的团队副本。已有 Issue 成果区继续显示原附件和来源，并增加明确登记入口。

## 验收重点

同名不同文件不自动合并；网络失败后同键不生成重复版本/评审任务；冻结副本可回取且与 hash 一致；源附件改变/删除不改变已评审版本；普通任务 done/改派不能代替正式决定；批准 v1 后新提交 v2 不改变 v1 证据；条件变更不改写已通过验收；并发请求/交接/删除保持同一责任与证据链；大量成果、历史与候选都用服务端分页。运行验证仅 agent 3，所有存储测试使用测试对象或临时夹具，不访问真实 NAS 或运行真实 Agent。

## 最终来源与多处引用模型

下列结构补足 proposal §7.1，已按 9000–9064 落表并在 agent 3 隔离测试库验证。真实服务和新版 UI 正在联调；旧准备版客户端不会通过能力协商取得新入口，不能把 isolated 测试结果当作已部署或全部验收。

### 原始来源、生产责任、版本来源分别记录

- `cockpit_artifact.source_issue_id` 保持登记时的原始来源，普通编辑和后续生产责任转移都不得覆盖它。`owner_node_id` 保持唯一所属 L3，供管理范围和登记责任使用。
- 新增 `authorized_producer_issue_id`，初始与原始来源相同。它表示允许提交下一版的实际工作任务，不是历史来源。转移只能由人类管理者显式执行，携带 `expected_revision, command_key, issue_id, reason`；不能靠给任意任务新增参考关联来取得提交权。
- 新增 `cockpit_artifact_producer_assignment` 审计表：`id, workspace_id, artifact_id, command_key, command_hash, from_issue_id, to_issue_id, reason, created_by, created_at, resulting_revision`。同键同意图返回原回执，不同意图冲突；从已有任务接手不隐式改其项目、模块、状态或执行者，不启动 Agent。新建修订任务时使用现有 IssueService typed hook 同事务创建任务和授权关联。
- `cockpit_artifact_version` 增加不可变的 `producer_issue_id NOT NULL`、`producer_run_id NULL`、`source_meeting_id NULL`、`source_minutes_version_id NULL`。提交时固定当时的授权生产任务；后续转移只影响新版本，不改旧版本、文件 hash、评审任务和已经通过的验收。
- Agent 的 `producer_run_id` 由经过验证的任务凭据推导，并核对该 Run 的 Issue、工作区与 `producer_issue_id`；不接受人类请求任意填一个 Run UUID 来冒充执行来源。人类提交或平台无法证明实际 Run 的文件，Run 字段留空，提交者信息仍单独记录。
- 会议来源显式选择，不从任意 meeting_issue 关系猜测。填写 `source_minutes_version_id` 时必须同时指定对应会议，并验证它是同工作区该会议的固定已发布版本；会议本身作为背景来源不等于已固定其所有可编辑说明。提交载荷包含这些来源字段，幂等意图 hash 同时覆盖它们。
- 文件源附件必须属于本版本的 `producer_issue_id`；附件分页端点随明确的生产任务读取，不能继续固定读取原始来源任务后假称支持跨任务修订。工作包材料、原始来源和新生产任务在界面分别命名，不用一个“来源”标签混为一谈。

生产责任转移接口独立为 `POST /artifacts/{id}/producer`；成果头增加 `producer_issue` 与 `can_assign_producer`，版本元信息增加上述不可变来源 ID 和最小可读标签。现有 `source_issue` 字段保持原始来源语义。待评审版本的评审人与正文不会因生产责任转移而变化；正在进行的旧 Run 不获得新提交权限，也不会因转移被偷偷取消。它若随后提交新版本，服务端按当时授权拒绝并提供当前责任信息。

### 引用固定版本，不转移所有权或验收结论

新增两个专用关系表，不采用通用实体关系引擎：

| 表 | 关键列与含义 |
| --- | --- |
| `cockpit_artifact_node_reference` | `id,workspace_id,artifact_id,version_id,node_id,purpose,reference_key,command_hash,created_by,created_at,removed_by,removed_at`；某一 L3 明确引用一个固定版本 |
| `cockpit_artifact_meeting_reference` | 同样的固定版本与审计列，以 `meeting_id` 代替 `node_id`；会议资料/评审背景中的成果引用 |

`version_id` 必填，必须真实属于同工作区的 `artifact_id`，由已完成固化的版本提供固定文本或可回取文件。引用不会把成果主 L3 移走，不改变来源 Issue，也不传播批准或验收状态。历史已批准版本可被明确引用；界面注明是否仍是该成果当前已批准版本。更新到新版本需显式建立新的引用，不静默改变旧引用。

新增和移除引用是明确的人类命令；移除采用带操作者和时间的撤销记录，旧键不重新激活旧记录。活动引用的自然键按 `(workspace_id,target_id,version_id,purpose)` 去重；命令键按 `(workspace_id,reference_key)` 独立唯一。旧引用被验收证据使用后，撤销引用也不能删除那次验收的固定证据。L3 请求验收时可选择其所属成果或明确引用的成果，但证据仍须是每份成果当时的当前已批准版本，审批前再次检查；跨模块引用不暗改任何项目/模块归属。

引用集合、反向使用处、生产责任历史均独立分页，默认 25、最大 100；不回填进全量 cockpit board 或成果头。范围筛选明确区分 `owned/referenced/all`，汇总去重按固定成果身份，不将一次多处引用重复算成多个产出。公开命令分别落在 `/artifacts/{id}/node-references`、`/meeting-references`，撤销使用该关系的 ID；准确回执包含关系 ID、固定版本、目标及命令键，不依赖对象恰好出现在第一页。

### DDL 与保留规则

除本合同前述成果、版本、文件固化意图/尝试、验收定义、请求、证据和正式评审交接结构外，最终模型需要以上生产责任账本与两个专用引用表。各表主键/命令唯一键/自然键/工作区分页索引分开建 concurrent migration；不能为迁移编号不足把关系或权限塞进任意 JSON。新 fork 迁移使用已确认的 9000–9999 范围；本批按已审清单使用 9000–9064，额外编号须先协调，不重排既有 900–999 文件。

原始来源与生产任务受明确的应用级删除保护，不能通过删除任务消除来源或提交门禁。归档成果保留固定版本、评审和引用历史。Run 保留期结束后可以按既有留存策略清理执行日志，但版本中的 Run 身份和当时可验证的最小生产者/时间元信息保持，界面明确日志不可用，不能把空日志解释为从未执行。工作区整体删除在事务中清理上述领域关系与账本，存储清理继续按持久化文件意图执行；没有 FK 或级联删除。
