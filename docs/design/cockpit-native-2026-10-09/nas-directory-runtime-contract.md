# N1 会议目录准备运行合同

日期：2026-10-11。状态：**N1 已实现并在 agent 3 验收、部署常驻**。9092–9104 包含三表、11 个独立索引与保护，共 13 对；26 文件已冻结并通过临时 schema 验证，专用测试库与常驻向前迁移完成，业务验收详见[验收记录](review-meeting-directory-2026-10-11.md)。本稿取代 [NAS 后端草案](nas-input-backend-contract.md) 中 N1 的未定部分，沿用 [交互草案](nas-input-interaction-contract.md)；保留已部署阶段 L 的会议准备与取消处置。

本片只有可靠目录准备：检查现有绑定、预览固定路径、保存一次明确授权、逐步骤补缺、准确回读与接手。没有文件候选浏览、复制输入、转写、Agent 派发或 NAS 发布。本片不创建 Issue；原 provision 里的任务行为仍使用原 canonical 入口并单独回报。

N2 **必须包含浏览器直接上传**，不能要求先去某个 Issue 上传附件。其输入身份、上传会话、私有固化、清单及 Run 来源另审预算；这里不一次申请前稿的 12–13 表/44–48 索引。

## 1. 不变边界

- `meeting.nas_dir` 仍是唯一当前绑定。operation 的原目标是历史意图，不是第二份可编辑会议路径；会议改名不改原目标。
- 在现有部署根声明上只新增 `prepare_subpaths: string[]`，缺省 `[]`。导出权限不自动授权目录准备，更不授权读取根内全部文件。N1 不新增 browse/read 子范围。
- 每个允许子范围为 root 内的规范相对目录；空值、绝对路径、`..`、分隔符别名及无法确认的符号链接拒绝。`.` 表示部署者明确授权整个已有 root 下的目录准备，不作为默认。
- root 与授权边界必须实际可访问；API 不能创建根、挂载点或根标识。挂载消失后遗留的同名空目录不成为替代根。
- 预览不写文件；可列目录不等于已验证可写。业务授权、连接检查与写入结果是不同字段，未知写能力不得当成功。
- 所有 mkdir 只有一个持久步骤执行器。旧 provision、旧导入的子目录补齐与新 API 都调用它；删除原来直接新增目录的分支，不保留第二套绕过持久回执的写实现。
- 目录计划不改变 materials_ready、会议发生事实、Issue 状态、执行者、正式成果或已有 NAS export 的固定目标。

## 2. 固定目标与绑定修订

新增 `meeting.nas_dir_revision bigint NOT NULL DEFAULT 1`，仅在 `nas_dir IS DISTINCT FROM OLD.nas_dir` 时增加；普通说明/标题/生命周期变更不增加它。所有写入口由同一数据库保护保证这一修订，旧客户端缺少 expected revision 仍按原 API 语义写路径，新目录计划能观察到变化。

`DirectoryTarget` 的固定字段：

| JSON 字段 | 类型和含义 |
| --- | --- |
| `root_id` | UUID；当前 workspace 的已授权 root |
| `root_path` | string；确认时服务器使用的绝对根位置，仅诊断显示，不作为客户端写输入 |
| `prepare_subpath` | string；命中的明确准备子范围 |
| `relative_directory` | string；固定会议目录相对 root 的路径 |
| `directory` | string；服务器解析的完整目标；只用于回执、打开/复制与绑定，不能反向信任为新授权 |
| `target_hash` | 64 位小写 SHA-256；只含 root 与规范会议目录，唯一性冲突仍核原字段，不靠 hash 猜相等；步骤全集另用 plan_hash |
| `root_config_hash` | 64 位 SHA-256；root 的 workspace/ID/路径/准备子范围及验证策略，配置变更必须重新核对 |

同一 root 下词法规范后的不同路径不因大小写被擅自合并；实际 I/O 用已验证目录描述符判断是否同一对象。授权子范围检查不能只做字符串前缀。已有目录的别名不得扩大原允许范围；无法确认时失败关闭。

每个计划固定 `observed_binding:{nas_dir,revision}` 与 `bind_after_base:boolean`：

- 接管当前已有目录时 `bind_after_base=false`，固定目标必须与当前已解析绑定相符，计划不改绑定。
- 为未绑定会议建立目录时 `bind_after_base=true`；换到另一个目录也必须在新预览中明确显示原/新绑定，不通过 retry 改目标。
- 基目录核验完成后，在同一短事务中锁会议，只有当前绑定仍等于该次准确 grant.observed_binding 才 CAS 更新 `nas_dir`，确认 attempt 成功、base satisfied 并首次保存 `accepted_binding_revision` 与 `binding_result=updated`。后续仅观察值与该成功 base grant 完全相同的步骤共享这一更新；**不能令同授权余下分区自失效，也不能给未选旧 grant 扩权**。
- 路径已是本计划目标时记录 `binding_result=unchanged` 与实际修订；不能声称本次修改了路径。
- 用户另行改路径、包括 A→B→A 后修订不同，记录 `binding_result=conflict`，暂停后续步骤；已满足目录步骤和原回执保留。base 尚未满足且原意图允许绑定时，可显式重新预览当前观察→固定目标并选择原 base 重授；同次新观察的子步可继续，未选旧授权仍拒绝。base 已满足或原意图不绑定时，只能显式恢复固定绑定或建立新计划，不静默改旧 target。
- 同一计划自己的步骤进度、绑定更新和日志，不冻结为每步的外部冲突条件。普通会议备注/议题改动也不要求重新授权。

`accepted_binding_revision` 是本计划观察/写入的依据，不是当前路径的权威副本。当前值始终从 meeting 读取。

## 3. 固定状态与权限

operation.state：`active | paused | needs_attention | completed | abandoned`。

step.state：`pending | running | retry_wait | satisfied | needs_attention | abandoned`。

attempt.state：`running | succeeded | failed | expired | abandoned`。失败 attempt 不覆盖先前 attempt；running 有独立 lease_token/expires_at。步骤 satisfied 只表示该次核验时的目录事实，不保证外部永远不删除目录。

初始确认接受当前人类成员或第 11 节明确验证的 task_token 委托；两者沿真实成员/会议权限与部署准备子范围校验。L 的取消/归档阻止新准备。计划责任人管理未完成项；原授权人或当前 owner/admin 可暂停、放弃、显式接手，接手记录新的 actor/key/reason。cloud_pat 无具体任务上下文，仅可查询已有计划，不可发起新授权；机器不得被标记为 Human=true。

归档前已授权的计划可完成原目标；会议 cancelled 时暂停尚未开始的步骤，重新安排后明确恢复。取消预览的 `directory_impact` 包含全部未完成数、本次将暂停数和至多 100 个计划 ID；确认后将实际 `directory_effect` 固定在原取消命令的 preparation 回执中，不能从后来的 pending 集合重算。正在执行的一个 mkdir 不能承诺撤销；晚结果记录已发生事实但不能授权更多步骤。权限撤回、责任人离开或根配置变化使下一步 needs_attention，不借后台 worker 继承已消失的业务权限。已接受的有限计划不因来源 Run 正常完成或其 token 到期而中断；Run 后续终态只作来源，不等于目录 pause/abandon。

能力分别返回 `can_retry/can_pause/can_resume/can_claim/can_abandon` 与 `blocked_reasons:string[]`；step 返回 `can_retry`。未知状态保持只读，未知原因保留通用提示；不根据当前 userID 猜能力。

`retry` 只针对服务端列出的可重授原步骤，包括失败项和暂停/受阻计划中需重新授权的 pending 项，不能重置 satisfied；目录在完成后被外部删除属于新的明确 repair 计划，保留旧 satisfied/完成回执。`resume` 只恢复相同授权且存在可推进步骤的暂停计划；若只剩失败父步骤与等待它的子步骤，返回 `directory_retry_required` 并引导选择重试。根/绑定等实质变化必须重新预览后以 retry 确认，目标本身改变只能新建计划。

## 4. Wire：读模型

所有新增路径在 `/api/cockpit`，当前 workspace 成员只读不初始化 board。UUID 均使用纯 UUID 边界解析；meeting 路径按已有 loader 校验对象与 workspace。默认页大小 25，最多 100；未知枚举保留但不能据此写入。

根选择使用 `DirectoryRootPage {workspace_id,page_size,items,total,next_cursor}`；item 为 `root_id,root_path,prepare_subpath_count`。保持现 `cockpitnas.Files.roots` 每 workspace 单 root，列表只返回0或1项、next_cursor恒null；不借N1扩为多root。单 root 详情返回最多32个 `prepare_subpaths`，支持恢复已选 ID。它是配置 metadata，不列 NAS 文件、不探测网络、不声称当前可写。prepare_subpaths 缺省空；配置变化使原 preview token 失效，用户选择保留。服务器不会要求用户手填未展示的 Root UUID。

`DirectorySummary`：

```text
workspace_id, meeting_id, generated_at
binding: {nas_dir:string, revision:int64}
binding_candidate:DirectoryTarget|null, binding_candidate_reason:string
capabilities: {available:bool, can_preview:bool, can_create:bool}
blocked_reasons:string[]
current:DirectoryOperationHeader|null
history_total:int64, unfinished_total:int64, needs_attention_total:int64
```

`DirectoryOperationHeader`：

```text
workspace_id, meeting_id, id, revision, state
command_key, request_hash, plan_hash, target:DirectoryTarget
created_by_type, created_by, created_by_name, source_principal:DirectoryPrincipal,
responsible_user_id, responsible_user_name, last_grant:DirectoryGrant
created_at, updated_at, finished_at:null|timestamp
observed_binding:{nas_dir,revision}, accepted_binding_revision:null|int64
bind_after_base:bool, binding_result:pending|unchanged|updated|conflict
counts:{total,pending,running,retry_wait,satisfied,needs_attention,abandoned}
can_retry, can_pause, can_resume, can_claim, can_abandon, blocked_reasons
```

current 不是写回执。Header 不返回全部尝试、错误堆栈或文件清单。`current` 选择最近未完成实例；全范围 unfinished_total/needs_attention_total 独立计数，不能以最近实例或第一页推断全部完成。有多个历史目标可从有界历史进入，不能隐藏失败的旧目标。

`DirectoryStepMetadata`：`id,operation_id,position,kind=ancestor|base|partition,label,relative_path,state,revision,grant_command_key,grant_revision,attempt_count,last_attempt_id,last_observed_at,outcome:null|created|observed_existing,last_error_code,can_retry,blocked_reasons`。一次计划最多 32 步，含授权子范围内实际需要的祖先目录、基目录与最多 16 个分区；每个待创建中间目录都在预览里，不能藏在递归 mkdir 中。超限明确拒绝，不截断。

路径最长 4096 UTF-8 字节，单组件最多 255 字节且不得为 `.`/`..` 或包含控制字符；总深度最多 16。根/允许子范围自身从不创建。默认分区为原“会议纪要与录音转写”“会议材料”“照片”，可以明确取消选择，首片不配置任意脚本或步骤类型。

`DirectoryAttemptMetadata`：`id,step_id,attempt_number,state,started_at,finished_at,error_code,outcome,observed_at`。单 attempt detail 才返回错误正文、准确 grant、原观察与迟到观察；错误正文和每份观察各有 16 KiB 上限，完整响应最多 64 KiB，不含凭据。记录 `created` 只在有该次 mkdir 成功证据时使用；重启后仅证明存在，返回 `observed_existing`。

页均回显 `workspace_id,meeting_id,operation_id/step_id,page_size,items,total,next_cursor`。历史按 `(created_at,id) DESC`；步骤按 position ASC；尝试按 attempt_number DESC。cursor 绑定 workspace/目标/筛选/页大小与排序，不绑定会自行增长的 progress revision。

## 5. Wire：预览、命令与固定回执

预览输入：

```text
DirectoryPreviewInput {
  mode: "prepare"|"repair",
  root_id:UUID,
  relative_directory:string,
  partitions:string[],
  observed_nas_dir:string,
  observed_binding_revision:int64,
  bind_after_base:bool
}
```

已有 nas_dir 接管也传明确 root/path，服务端解析当前绑定核等，不从会议新标题重算路径。预览输出包含 `workspace_id,meeting_id,target,observed_binding,bind_after_base,steps,counts,context_token,can_confirm,blocked_reasons,checked_at`。每步 `planned_state=exists|missing|conflict|unknown`；权限/写能力 `unknown` 不伪造存在性或成功。token 64 位 SHA-256，覆盖真正影响本计划的根、绑定、路径和检查事实，非鉴权凭据。

创建输入为预览输入加 `command_key:UUID,expected_revision:int64,context_token:string`；这里 expected_revision 是观察到的 **binding revision**，必须与 observed_binding_revision 一致，不借生命周期总修订表示目录冲突。请求上限 64 KiB。原意图精确持久，保留所选分区顺序形成固定 plan_hash；未知字段拒绝。

retry 输入：`command_key,expected_revision`（operation revision）、`step_ids:UUID[]`（1–32个，无重复）、`context_token,reason`；retry-preview 从原 operation 的固定目标和这些步骤生成，客户端不能传替换路径。允许当前未满足且无活动 lease 的 needs_attention/retry_wait 项，以及暂停/受阻计划中需显式重新授权的 pending 项，保存新的重试授权 key；旧在途 attempt 不能借新 key 接续写，Finalize 必须匹配自己尝试的 grant 与 lease。

control 输入：`command_key,expected_revision`（operation revision）、`transition=pause|resume|claim|abandon,reason`。claim/abandon 原因非空，其余可空；reason trim 后≤16000字节。abandon 仅阻止未完成步骤，已建目录不回滚，运行中的一步待实际核对结果。

固定回执：

```text
DirectoryCommandReceipt {
  directory_operation_id:UUID,
  directory_step_ids:UUID[],
  request_hash:string,
  plan_hash:string,
  context_token:string|null,
  target:DirectoryTarget,
  observed_binding:{nas_dir,revision},
  bind_after_base:bool,
  operation_revision:int64,
  state:string,
  responsible_user_id:UUID,
  authorized_at:timestamp,
  principal:DirectoryPrincipal,
  grant:DirectoryGrant,
  reason:string
}
DirectoryCommandResult {
  workspace_id, meeting_id, command_key,
  action:"directory_prepare"|"directory_retry"|"directory_pause"|
         "directory_resume"|"directory_claim"|"directory_abandon",
  replayed:bool,
  receipt:DirectoryCommandReceipt,
  current:DirectoryOperationHeader
}
```

创建回执固定“计划已登记/授权”，不假装步骤都完成。后续准确步骤结果从 step/attempt 读；current 的进度不能代替原 key/hash/target 核验。Retry receipt 固定所选 step_ids；pause 等无特定步骤时为空数组，不能按后来 pending 集合猜原授权。

同 key 重放先核当前成员、原 actor/request_hash，再核原会议/计划存续，早于当前路径、归档、角色或根可用性校验；读取历史回执不访问 NAS。原 create 对象已删除则410，不重新创建；abandon 原命令已使对象 abandoned 仍返回原回执。未知结果 GET 原 key，不自动生成新 key。

当前目标已有未完成计划，另一创建 key 返回409 `directory_operation_exists`，附严格 `workspace_id,meeting_id,root_id,directory_operation_id,command_key`；此 command_key 是本次提交值，不能用原实例 key 伪装新命令成功。允许人打开原计划并按能力接手/继续。不同 payload 复用 key 返回409 `command_conflict`。

## 6. HTTP 清单与生命周期兼容

| 方法与路径 | 返回/用途 |
| --- | --- |
| GET `/directory-roots?cursor&page_size` | DirectoryRootPage；仅部署已授权的准备范围，不是文件浏览或新的读取许可 |
| GET `/directory-roots/{rootId}` | 当前workspace的单root配置详情，含≤32 prepare_subpaths；无NAS I/O |
| GET `/meetings/{id}/directory-preparation` | DirectorySummary，未登记返回 current=null，不 mkdir、不创建 board |
| POST `/meetings/{id}/directory-preparations/preview` | DirectoryPreview；锁外只读 I/O，有总 deadline |
| POST `/meetings/{id}/directory-preparations` | DirectoryCommandResult |
| GET `/meetings/{id}/directory-preparations?cursor&page_size` | operation metadata 历史 |
| GET `/meetings/{id}/directory-preparations/{operationId}` | header；不重复返回历史 body |
| GET `/meetings/{id}/directory-preparations/{operationId}/steps` | 全部≤32固定 step metadata，精确 counts |
| GET `/meetings/{id}/directory-preparations/{operationId}/steps/{stepId}/attempts?cursor&page_size` | 有界尝试 metadata |
| GET `/meetings/{id}/directory-preparations/{operationId}/steps/{stepId}/attempts/{attemptId}` | 单尝试详情 |
| POST `/meetings/{id}/directory-preparations/{operationId}/retry-preview` | `{step_ids}` 的原目标重验与新 token，无写入 |
| POST `/meetings/{id}/directory-preparations/{operationId}/retry` | DirectoryCommandResult |
| POST `/meetings/{id}/directory-preparations/{operationId}/control` | DirectoryCommandResult |
| GET `/meetings/{id}/lifecycle/commands/{commandKey}` | 沿既有精确命令读取，receipt.directory 承载新固定回执 |

复用 `cockpit_meeting_lifecycle_command`，新增 `directory_operation_id UUID NULL`、`directory_step_id UUID NULL` 及 `actor_type TEXT NOT NULL DEFAULT 'member'`；metadata 与 Detail 同步 additive 字段。目录记录的 actor_id 是真实人类或 Agent ID，actor_name 按 actor_type 一次JOIN真实名称；原K/L记录保持member默认值。**L 的 operation_id/effect_id 始终留给 preparation，不借用**。没有单步 control 时 directory_step_id 为空；多步 retry 的全集在固定 receipt.directory.directory_step_ids 中。

旧 `CockpitLifecycleReceipt` 的 revision/agenda_revision/request_hash 等基字段保持，新增 `directory:DirectoryCommandReceipt|null`；revision 仍记录当时真实 lifecycle revision，不改成 operation revision，后者在 directory 子体明确返回。旧客户端未知 action 只读，不能把目录命令误导航到 L 模板实例。

现 `GET lifecycle/commands/{key}` 返回 envelope，因此新客户端 ACK guard 从 `receipt.directory` 验 key 对应的 request_hash/target/step_ids，不能只核 current。无需另建第四张目录命令表。

来源 target additive `directory_operation_id` 仅配 `kind=meeting,view=resources`；它与 L 的 operation_id 互斥。精确导航使用独立 `directory_operation` 查询参数，不能写进 preparation。父会议 destination identity 不因此改变，旧客户端仍可打开资源页。

WS 使用新 scope=`meeting_directory`、entity=`{meeting_id,directory_operation_id}`，仅失效 directory/lifecycle/history 与真实绑定读；不写入 Zustand。新 capability=`meeting_directory_preparation` 表示完整实现与事务/worker依赖已就绪，缺省 false。根未配置或后来撤销只改变具体会议的 can_create/can_retry 等和 `prepare_not_configured`，不能关闭历史读取入口；不能调用旧写实现兜底。部署验收完成才开启正式可用性。

## 7. 三表与查询/索引预算

所有正式身份与状态使用列；JSON 只装不可变原命令、固定回执及有界 FS 诊断。无 FK/级联，不内联索引。以下为 9092–9104 的实际结构。

| 表 | 必须列 |
| --- | --- |
| `cockpit_meeting_directory_operation` | id,workspace_id,meeting_id,creation_command_key,request_hash,plan_hash,revision,state,root_id,root_path,prepare_subpath,relative_directory,directory,target_hash,root_config_hash,observed_nas_dir,observed_binding_revision,accepted_binding_revision,bind_after_base,binding_result,created_by_type,created_by,credential_owner_user_id,authorizing_user_id,source_run_id,source_issue_id,source_agent_id,source_runtime_id,source_task_token_id,source_relation_kind,source_agenda_reference_id,last_grant_command_key,responsible_user_id,created_at,updated_at,finished_at；固定 input 与不可变创建receipt；任务仍由原会议关系独立读取，不成为目录计划控制对象 |
| `cockpit_meeting_directory_step` | id,workspace_id,meeting_id,operation_id,position,kind,label,relative_path,path_hash,state,revision,grant_command_key,grant_revision,attempt_count,last_attempt_id,next_attempt_at,lease_token,lease_expires_at,last_observed_at,outcome,last_error_code；固定父步骤ID与意图hash |
| `cockpit_meeting_directory_attempt` | id,workspace_id,meeting_id,operation_id,step_id,attempt_number,grant_command_key,grant_revision,lease_token,state,started_at,finished_at,outcome,observed_at,error_code,error_message,receipt,late_receipt,late_observed_at；receipt保存当次根/目录身份与结果，终态后不可变；late_receipt只允许从NULL填入一次迟到报告，不覆盖原终态或推动step |

**11 个独立 CONCURRENTLY 索引**：

1. operation unique(id)。
2. operation(workspace_id,meeting_id,created_at DESC,id DESC)：头历史与计数范围。
3. operation unique(workspace_id,meeting_id,root_id,target_hash) WHERE finished_at IS NULL：同固定目标唯一未完计划；target_hash只覆盖根/目录，plan_hash另覆盖步骤全集。
4. operation(workspace_id,meeting_id,created_by_type,created_by,plan_hash,created_at DESC,id DESC)：无key旧请求精确复用查找，不扫全历史。
5. step unique(id)。
6. step unique(workspace_id,operation_id,position)：固定顺序和≤32头部聚合。
7. step unique(workspace_id,operation_id,path_hash)：同计划不能重复目标步骤；发生hash冲突还核完整路径。
8. step(next_attempt_at,id) WHERE state IN ('pending','retry_wait') AND next_attempt_at IS NOT NULL：公平到期领取。
9. step(lease_expires_at,id) WHERE state='running'：过期尝试恢复。
10. attempt unique(id)。
11. attempt unique(workspace_id,step_id,attempt_number)：精确尝试和倒序分页，所有尝试不可覆盖。

原 lifecycle ledger 的 workspace/meeting/key 和 history 索引继续用于命令；无新增通用 command 索引。每次 operation 头/step counts 用一个有界聚合，人员名称一次批读；不对每个 step 发额外请求读所有尝试。

查询最小集合：GetSummary、List/CountOperations、Get/LockOperation、FindOpenTarget、FindLegacyExactPlan、ListSteps/CountStates、GetStep/LockStep、ListDueCandidates、ClaimOneStep、RecoverExpiredAttempt、InsertAttempt、FinalizeAttemptCAS、UpdateBindingCAS、RetrySelectedSteps、ControlOperation、List/Count/GetAttempts、HasDirectoryIdentityHistory、DeleteDirectoryFactsByWorkspace。每个 scoped SELECT/UPDATE 带 workspace。

worker 先无锁读最多16个到期候选标识，然后各自短事务按 workspace→member→board/meeting→operation→step 顺序取得锁、重核资格；不能先锁 step 再等 meeting，与 pause/retry 形成反向锁序。最终针对该 operation 用 MATERIALIZED candidate + FOR UPDATE SKIP LOCKED + LIMIT 1 领取唯一 step，返回数量严格为0或1，避免旧 UPDATE 重扫误租多条的已知问题。候选被别人领取则跳过，不把它误作命令失败。

operation 暂停、需人处理或放弃时，同事务清空未执行步骤的 next_attempt_at；恢复原授权才为可推进步骤重新排期。队列索引因此不反复扫大量暂停计划；Claim 仍 JOIN 核 operation.active，不能只信排期字段。依赖未满足的步骤不预先排期，父步骤 satisfied 后才为其子步骤排期。

结构迁移一份，11 个索引各一份，保护/约束一份，合计 **13 对迁移**（9092–9104）；旧9091及以前保持冻结。新增 meeting binding revision 及 lifecycle metadata 列在结构迁移内；冻结清单与临时 schema 验证和公共数据库迁移分别记录，不把临时验证算作部署。

## 8. Worker 和事务边界

1. 命令短事务锁 workspace→member→board/meeting→operation，核原 key/意图/绑定与权限，保存固定 plan/steps/ledger 后提交。
2. Claim 一个到期 step 时同序锁并核 parent satisfied、当前责任与外部事实检查需求；插 attempt，记录 grant/lease 后提交。不会在数据库锁内等待 NAS。
3. 锁外通过可信 root/子范围描述符逐组件检查与 mkdir；已存在普通目录可满足，文件/符号链接/根身份变化需处理。每次 I/O 有 deadline，但无法强行中断已进入内核的 NAS 调用。仅有两个固定执行 loop，文件系统全局槽位仍为2；原 loop 继续持有该尝试直到返回，不按超时遗弃无限 goroutine。独立的 DB lease sweep 不被 NAS 调用阻塞；晚结果只归其原尝试。
4. Finalize 短事务核同 step/attempt/grant/lease 与会议存续；保存实际结果，再推进计数和基目录绑定 CAS。旧租约晚结果只进该 attempt 诊断，不覆盖新状态、不推进下一步、不复活已删除对象。
5. 短暂连接故障可在同授权内有限退避，最多 3 次自动尝试；超过则 needs_attention。路径/权限/身份冲突不自动换目标重试。显式 retry 生成新 grant 与清楚回执；不把旧 unknown 默认为失败重发。

workspace 删除先在事务内冻结未完成计划并清业务事实；NAS 目录不自动删除。mkdir 可能在删除并发间隙完成，不能声称外部可回滚；关闭租约阻止后续步骤，晚结果不复活。目录没有上传对象需要 GC，因此首片不增加文件 tombstone/对象清理表。若要求删除后保留运维审计，应使用现事件/日志保留规则，不能悄悄把新四张领域表塞进“三表”预算。

整板 restore 与 meeting delete 必须保护仍关联目录 operation/attempt 的身份；包括完成与放弃历史。operation basis 给精准会议资源/目录实例入口与归档路径，不只让删除按钮最后遇到409。工作区 teardown 是明确授权的整体清理，不删除外部目录。Down 只允许三表及该批 ledger 事实均空；先在任何索引删除前拒绝有事实的整批回滚。

## 9. 旧 provision / import 的唯一实现

保留旧 `create_dir/create_task/remember` 缺省和既有字段，原 tasks 仍通过 canonical 幂等入口；新目录专用 API 永远没有 create_task。旧 handler 只负责解析原请求、解析当前部署准备范围和调用同一 Plan/Execute/Read 服务，不保留 `provisionMeetingArchive/createMeetingSubdirs` 的直接写分支。

旧客户端没有 command_key：在 workspace/meeting 锁内按原 actor + 精确固定 target/plan_hash 找已有计划；相同请求复用原 operation，不能把别人的授权暗中接手。机器的自然复用还须由可信同工作区 Run 核对原 Agent、source Issue 与 originator；未完成计划的当前责任人也必须仍是该授权人。此处只延续原 grant，不要求原 Run 仍运行；需要新的 prepare/repair 授权时仍检查当前有效委托。已有 nas_dir 优先作为精确目标，不能因会议改名重新派生另一目录；明确 BaseDir/FolderName 改目标仍是新意图并按新权限核对。自然冲突返回旧 response 的可读 dir_error 和 additive directory_operation_id，不伪造新成功回执。

已有精确完成计划若所有目录当前仍存在，返回可核的原结果；发现外部删除/冲突时，旧 create_dir POST 自身只能明确发起同目标 repair 授权，历史完成回执不改写。新 UI 始终用 preview+key，旧无key保证有限自然幂等，不宣称具备新客户端的完整未知结果确认协议。

兼容 handler 可在请求总预算内调用同一持久 step 执行器推进最多 32 步；超时则返回仍在处理的状态，不另起一套同步 mkdir。旧 `dir_created=true` 仅表示基目录已确认可用（保持旧语义），分区未完成时 `dir_error` 必须非空；新 additive `directory_operation_id,directory_state` 表达真实整体进度。`task/task_error` 与目录结果仍独立，不重建已存在的会议任务。

旧导入在登记会议后需要补分区时，同样建立/复用该持久计划；扫描仍只读。响应新增逐会议 `directory_results`，说明计划身份、状态及准确目录错误；`task_errors` 单列任务创建失败。`skipped` 只包含真正未导入的目录，不能把已经创建的会议写成导入失败。部署升级必须预先显式配置 prepare_subpaths，不能从旧 export 许可自动推导；缺省空时旧接口返回明确的未配置目录结果，绝不转回原裸 mkdir 兜底。

旧 provision 不加全局 RequireHumanActor：新目录分支调用第11节同一 DirectoryPrincipal 门禁，合法 task_token 可提交受限委托，不另开机器写实现。cloud_pat 的目录分支只回读已有结果，目录新增/重试返回明确任务上下文缺失；原 task 分支仍受它自己的既有授权规则约束，不借本片改造偷偷扩大或取消任务权限。

## 10. 错误和验收

稳定业务错误：`prepare_not_configured`、`prepare_path_outside_scope`、`meeting_preparation_closed`、`binding_changed`、`root_config_changed`、`directory_operation_exists`、`command_conflict`、`target_gone`、`permission_revoked`。

实际 I/O 错误：`root_unavailable`、`root_identity_mismatch`、`mount_unavailable`、`permission_denied`、`path_is_file`、`symlink_not_allowed`、`directory_identity_changed`、`io_timeout`、`io_failed`、`unsupported_storage`。错误码只描述已证实事实；不能把任意 ENOENT 都写成掉线，未知只给通用原因与单次诊断。SQL/网络未知不能清 pending command。

必要具名回归：无prepare_subpaths时旧/新两入口均不写；新目录API零Issue/Run；原provision任务不重复且目录走同账本；基目录绑定自更新后余步骤不失效；外部A→B→A路径变化阻止旧授权；部分成功/进程退出后只补未完成原步骤；自然存在目录 observed_existing 不假称created；同key/同目标并发不双计划；grant/lease晚回执不覆盖；暂停/归档/取消/撤权/工作区删除并发；文件/符号链接/挂载冒名拒绝；33次历史25+8页；旧生命周期页新增目录记录可解析且不误导航到L实例。

真实 I/O 验收仍只在 agent 3 授权的独立 NAS 测试根；文件系统具名回归已由 agent 3 在私有临时根执行；真实数据库与浏览器结果另以验收报告为准，不启动真实 Agent。

## 11. 可信委托与逐步骤授权

具体任务中的 Agent 可完成已部署许可的确定性目录准备。权限来自可信任务身份、实际委托人和固定授权；来源 Run 结束不自动撤销已受理计划，也不允许凭据所有者冒充人类确认。

### 1）新命令验证任务委托，不把凭据所有者当授权人

源码事实：

- [Auth](../../../server/internal/middleware/auth.go) 清除用户伪造的 actor headers，经 `GetTaskTokenByHash` 校验未过期 token 后填入 Agent、Task、workspace、user 身份；workspace 中间件优先采用该绑定，不能用请求参数换工作区。
- [finalizeClaimDelivery](../../../server/internal/handler/daemon.go) 在 runtime 行锁内把 token.user_id 写为 **runtime owner**。这不是 Run 原始发起人，更不是该人确认了本次目录计划的证据。
- [任务来源](../../../server/internal/service/task.go) 的 `originator_user_id` 承载授权链。`accountable_user_id`、rule_owner、owner_fallback 只作审计，不能补成授权者；已有 `ResolveAutopilotTriggerPrincipal` 负责在派发时确定合法 trigger principal，N1 不从最新规则或姓名重新推人。
- [成果提交](../../../server/internal/handler/cockpit_artifacts.go) 已接受服务端任务身份，并在服务里核准确 Run/Agent/producer Issue，拒绝 cloud_pat 冒充 producer。N1 复用这类可信身份入口，但不声称现 artifact 验证已等价完成 N1 的活动状态、目录范围和持续委托检查。

task_token 创建、retry、resume 等**新授权**必须全部满足：live task_token 与服务端请求上下文一致；Run.status 为 `dispatched|running`，非 chat Run；Run.AgentID/IssueID/RuntimeID 与当前 Agent/运行环境事实相符；准确 Issue 和会议同 workspace；存在一个当前有效的准备关系；Run.originator_user_id 非空且该人仍是当前成员、具备该会议目录操作权限，并仍可 INVOKE 该 Agent。

当前有效准备关系只接受：work package 的 minutes_issue、active agenda 的 active `issue/preparation` 引用、直接 meeting_issue 中的 preparation，或 canonical 旧 task 关系。同项目/相同L3/文件名相似、纯 material/reference 和可编辑 Issue 描述不是委托范围证据。现有 `CockpitMeetingHasPreparationIssue` 可复用集合，但需补一条有界单事实读取来保存关系 kind/准确引用身份；不扫描全文。

INVOKE 复用 `memberMayInvokeAgent` 的真实判定并保留 DB 错误与拒绝的区别；不复用允许 admin 查看/取消的 `MemberMayViewAgent` 来扩大私有执行权限。独立验证成员存续与 Agent 非 archived；owner 分支的快捷允许不能替代 workspace membership。task 没有 originator 时只能查看可读对象或交人处理，不能拿 runtime owner、accountable 或当前管理员补授权。现 A2A 对 public_to workspace 的无originator调用例外不是一个具体人的 NAS 目录授权，本片不将它扩大为文件系统权限。

cloud_pat 没有准确 Run，允许当前权限内的 summary/history/detail/原命令读取；禁止 preview、新建、retry、resume、claim、abandon，也不作为 root 选择/能力发现的绕道。人类 JWT/个人凭据沿原人类权限，真实人类确认才记录 confirmed_by_user_id。

### 2）身份 wire 与账本必须如实区分三个人/机器事实

完整 wire 已落 `server/internal/service/cockpit_meeting_directory_types.go`；以下身份定义均由服务端生成；命令 body 不接受这些身份字段：

```go
type CockpitDirectoryPrincipal struct {
    Source                string  `json:"source"` // human | task_token
    ActorType             string  `json:"actor_type"` // member | agent
    ActorID               string  `json:"actor_id"`
    ActorName             string  `json:"actor_name"`
    CredentialOwnerUserID string  `json:"credential_owner_user_id"`
    AuthorizingUserID     string  `json:"authorizing_user_id"`
    AuthorizingUserName   string  `json:"authorizing_user_name"`
    ConfirmedByUserID     *string `json:"confirmed_by_user_id"`
    RunID                 *string `json:"run_id"`
    IssueID               *string `json:"issue_id"`
    AgentID               *string `json:"agent_id"`
    RuntimeID             *string `json:"runtime_id"`
    RelationKind          string  `json:"relation_kind"`
    AgendaReferenceID     *string `json:"agenda_reference_id"`
}

type CockpitDirectoryGrant struct {
    Kind                  string `json:"kind"` // human | delegated_task
    CommandKey            string `json:"command_key"`
    Revision              int64  `json:"revision"`
    ResponsibleUserID     string `json:"responsible_user_id"`
    Principal             CockpitDirectoryPrincipal `json:"principal"`
    TargetHash            string `json:"target_hash"`
    RootConfigHash        string `json:"root_config_hash"`
    AcceptedAt            string `json:"accepted_at"`
}
```

human：actor/credential owner/authorizing/confirmed_by 均为真实当前人，Run/Issue/Agent/Runtime/reference 为 null，relation_kind 为 `none`。task_token：actor/Agent 为可信 Agent，credential owner 来自 token，authorizing 为准确 Run.originator，confirmed_by 为 null；其余真实来源非空，relation_kind 为 `work_package|agenda_preparation|direct_preparation|legacy_task`，agenda_reference_id 仅对应 agenda_preparation 时非空。不伪造 token owner 与 originator 相同。

operation.source_principal 是不可变来源；last_grant 只是最近授权的显示摘要。每个 step 的 grant_command_key/revision 才指向该步骤的准确当前授权，worker 从同一生命周期固定 receipt.directory.grant 读取；不能拿 header 最近一次针对少数步骤的授权覆盖全部步骤。创建来源字段用 operation 的显式列保存，固定 receipt 复制当时的 typed projection；人类接手后来源仍保留，而全部未完成 step 的 grant 改为真实 human grant。task_token_id 只在内部保留凭据身份用于原请求核对，不向 UI 返回 token hash/原文；existing task_token.id 已有主键，无需新索引。

原 lifecycle.actor_id 对目录命令存真实 actor ID；新增 actor_type 默认 member 保持 K/L 原行为，metadata actor_name 按类型解析。目录 constructor 用专属 admission 与 replay，复用原存储查询/固定 envelope；**不放宽 `newLifecycleCommand` 的 K/L human guard，不传 Human=true，也不让 agent ID 去冒充 member 行锁**。membership 锁以已验证的人类 principal 取得；精确 replay 还核 source/actor/run/hash，不能只看共享 owner 的 user ID。

### 3）持久计划独立于来源 Run 的寿命，授权仍可撤回

新 task_token 命令的准入验证必须在短事务内完成；接受后是一个固定 Root/path/步骤集合的持久授权，不依赖 token 保持在线。来源 Run 后来 completed、failed、cancelled 或 token 过期，只更新可读来源状态，**不自动撤销目录计划，也不重启 Run**。要停止目录剩余步骤使用明确的 pause/abandon；停止 Run 的原确认不能伪称已经回滚 NAS。

每个新 step claim 检查当前责任人 membership、准确目录目标和 root 权限、当前会议事实。delegated_task grant 还核原 authorizing user 对 source Agent 的当前 INVOKE/Agent 存续，不要求 source Run 继续活动，不借运行环境 owner 的权利顶替。权限失效进入 needs_attention；Human claim 对剩余固定步骤明确生成新 grant，不再借用原 Agent 权限，旧 source_principal 仍保留。不能把 claim 仅做改负责人文本。

source Issue/Run/关系是原接受时的来源，不能因删除普通引用而改写历史；后续控制的权限取当前责任与 grant，不能倒推当前关系等同最初同意。新的 Agent 需要自己的有效 Run 和明确命令，不能借老计划的 command_key 获得新授权。

会议 cancel 暂停未开始目录步骤，已有目录/正在发生的一步不自动回滚；取消预览要披露这一影响及真实目录未完计数。reinstate 后明确 resume。归档不阻断归档前已授权的步骤，但不授权新目标/分区。根/范围撤销、人员退出、Agent权限撤回阻止下一次 claim；已经在锁外执行的一步可能晚完成，只记录实际结果，不据此推进后续。恢复路径为修好原权限后确认 retry，或有权限的人明确接手；不要求新建会议/Issue。

### 4）缩小配置与锁的变化，保持同一执行器

保持每 workspace 现有单 root，根选择0/1；仅新增 prepare_subpaths，默认空，不升级目录浏览权限。三表、11索引、结构及保护共13对预算不变；principal/actor_type 为新增列，不新增授权表或通用权限引擎。

新 task_token 准入先从可信 auth context 取 token ID，再在事务内读 live token 与准确 Run。需要稳定 active/status/runtime 身份时，保持 workspace/member→board/meeting 前缀，再依 canonical runtime→agent→task 的内部顺序重核并锁住准入事实；随后 operation/step。不能先锁 Task 再等待 meeting，与 L 的确定运行处置形成反锁。多个人类成员行按确定顺序读取，绝不在持锁期间访问 NAS。

建议最窄 helper：`resolveDirectoryPrincipal`（HTTP可信context，不读body身份）、`authorizeDirectoryCommand`（当前准入）、`authorizeDirectoryGrant`（持久计划继续），共享现 `GetAgentTaskInWorkspace`、成员锁、INVOKE、准确准备关系和 root 解析。身份 context 可由 Auth 附加内部 typed value，不能引入可由客户端伪造的 headers。不要用吞 DB 错误的布尔 helper把暂时故障说成永久拒绝。

文件系统 deadline 只限制等待/调度，不宣称可以中断已进入内核的 mkdir；保持有限 worker 并发和迟到结果处理。重试仍是同固定路径 ensure，不能为超时操作启动无限并行执行。业务取消、成员撤回和 I/O 结果分别显示。

### 5）准确回执先于新授权检查，旧接口不再有第二条写路径

同 key POST 先验证当前请求本身合法、当前 workspace 读取权限及已存原 principal/hash，再返回固定回执；新授权用的 Run 活动状态、现目录可写性不得阻断一个已完成命令的回读。token 本身过期仍由 Auth 拒绝，用户可凭当前合法身份从命令详情读取事实，不能靠过期 bearer 例外通过。cloud_pat 仅 GET，不允许用“重放”伪装 POST。

旧 provision 仍解析原字段；合法 task_token 通过同一个目录 admission 登记有限计划，不能因为账本复用被全部禁止。无key旧请求按 actor_type/actor_id + 精确 target/plan_hash 复用，不按 credential owner 合并两台 Agent 的意图；自然已有实例可读返回，但不能假装另一机器确认了原命令。机器的 expected revision/预览由相同业务服务获取并在事务重核，不增一套 mkdir 或伪造 Human。

权限专项回归：伪造body/header身份；同runtime owner不同originator；跨workspace/无准备关系；source Run已终结时拒新授权但旧receipt可读；无originator不降级accountable；Agent私有权撤回与admin仅VIEW不能代替INVOKE；计划受理后Run结束仍完成；Human claim只转换未完授权；cloud_pat只读；原Run/Issue不被目录流程重建。

实现补充：preview/receipt/header 都带 plan_hash，客户端以精确预览的 plan_hash 确认固定步骤意图；step 页固定上限32，不制造续页游标。retry-preview 明确 operation_revision 与 step_ids。失败预览 principal 可null，不能将缺身份当确认许可。HTTP、router 和启动依赖已接线；部署可用性须经完整验收后开启。


### 固定授权、读取与恢复的共同约束

新命令按当前可信 task token 准入；同一 Agent、同一原准备 Issue、同一责任/授权成员的新有效 Run 可以明确重试或控制原计划。原命令的精确 key 重放仍绑定原 actor/Run/request hash，原 source principal 不随新授权改写。已受理授权不因原 Run 终态失效。

每一步使用自己的 grant.observed_binding 和 root_config_hash。固定 base 唯一一次成功 CAS 通过 `base.last_attempt_id → succeeded attempt → grant_command_key → 不可变 grant.observed_binding` 证明。仅观察值相同的兄弟步骤采用 accepted_binding_revision。首次 accepted 值须为这次成功 grant 的观察修订+1且与当前 meeting 已更新目标一致；不强行等于 operation 初始观察+1，之后仍不可清空或重置。外部 A→B→A 和部分重授不会让未选旧 grant 借用新观察。

允许部署收窄 prepare_subpaths 后对仍在新范围内的原步骤明确重授：固定 root/path 不变，不要求旧 matched subpath 字符串仍相同。新的逐步授权固定新配置 hash，未选步骤保持旧授权。根实际位置移动仍需新计划。

操作列表不读取 input 或完整历史 receipt；grant 批量只取固定 grant 子体。单 attempt 按需详情保留错误正文≤16k、每份观察≤16KiB，完整响应≤64KiB。准备器在触及文件系统前拒绝无法完整写入观察回执的路径，绝不裁掉路径或伪造成功。


归档前已登记的未完成 operation 可对原固定步骤明确 retry/claim，必须同时满足 `operation.created_at <= meeting.archived_at` 与当前成员/委托/根/范围条件；这不新增目标或分区。新 prepare/repair 计划仍须解除归档。取消始终阻止新的逐步授权，须先恢复会议；pause/abandon 仍可收束已有计划。

公开创建预览及重试预览在权限失败时先返回，不访问文件系统。旧接口恢复仅在原精确来源与固定计划匹配后允许终态 Run 回读；当前成员资格、调用许可、任务关系及原授权身份仍须有效。
