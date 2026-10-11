# N2 原始输入：最小后端实施草案

日期：2026-10-11。状态：**N2 实施准备中；第一版 Go DTO 已落，9105 起迁移草案范围待 root 审查/freeze，未应用、未开放能力。** N1 目录准备唯一合同为[目录准备运行合同](nas-directory-runtime-contract.md)，本文不再重复其状态机、表或权限。[交互草案](nas-input-interaction-contract.md)保留入口与恢复要求。

N2 首片必须同时交付：浏览器直接上传、受管 NAS 手动选择、独立输入身份与固定版本、会议/议题引用、已有 Issue 的版本化输入清单、真实 Run 的固定清单与交付门禁。无需 L3、纪要工作包、评审人或虚构 Attachment。登记不创建任务，不发起 Review，不自动确认材料齐备；转写、OCR、自动监视、递归摄取和任意 Agent 执行不在本片。

## 1. 必须先解决的源码缺口

| 边界 | 当前事实 | 最小改动 |
| --- | --- | --- |
| `internal/artifactcapture/capture.go` | Request 强制 AttachmentID；TargetKey 固定 artifact-versions；spool 已得 SHA 后先上传/Verify，最后才返回 Result | 抽出纯字节准备和写入核验两段，在两段间由领域层持久 pin；不得用假附件调用原成果 Capture |
| `internal/artifactcapture/verified_reader.go` | 一次读入有界临时 spool，核 size/SHA，再从同一 reader 输出 | 共享这一实现，保持锁外 I/O、Close 清理和 TOCTOU 保护 |
| `internal/service/cockpit_artifact_capture.go` | 上传前已有对象 intent，但内容 hash checkpoint 在 I/O 完成后；成功还通过 typed Create hook 建正式 Review Issue | 只共用 I/O/租约工具；输入有自己的 finalize，不能复用成果的评审终结 |
| `internal/storage/{private_artifacts.go,local_public.go}` | 本地匿名服务只明确封住 artifact-versions；S3 的私有能力为 false | 新输入 namespace 纳入同等拒绝/别名测试；不能用短签名掩盖公开 bucket/CDN |
| `internal/handler/file.go:UploadFile` | 通用上传创建 Attachment，100 MiB 限额，`io.ReadAll` 后上传 | 新输入上传必须独立、流式、有 session/object intent；可复用嗅探工具，不复用附件业务入口 |
| `internal/service/task.go`、`queries/agent.sql` | 自动 retry 复制父 context；指定 Run 的人工恢复经 enqueueRerunTask 重建参数；没有 input manifest 正式身份 | canonical 入队/恢复增加 typed pin，claim 只交付这个 pin，禁止临时读取当前 Issue 清单冒充历史 |

共享纯字节层保持小接口：`PrepareBytes(reader,size)` 得到可关闭 spool/size/SHA；领域事务 `PinContent(attempt,lease,size,sha)`；`WriteAndVerify(target,spool)`。服务先登记 owned storage key，后读取来源；写入失败也保留 pin。原成果业务仍调用自己的领域 wrapper，原 API、评审和 owner-L3 权限不变。

## 2. 权限、来源和不可变边界

- 输入头属于 workspace，登记 project_id 可空。无隐藏 Issue、无自由文本 owner 权限，不从名称/代码推 L3。
- 人类成员登记与上传；会议/议题新关系还核对应 `add_preparation`。归档不删除已登记版本或 Run 责任，新增范围需合法入口。原始位置与固定副本是否可用分别表示。
- NAS 仍是每 workspace 既有单 root，只增加独立 `input_subpaths`，默认空、最多32。prepare/export 都不授予读取许可。首片只有 API server 执行，不能把 desktop/daemon 任意文件系统当代理。
- NAS 列表与登记许可只限明确部署范围；逐组件 no-follow、根标识、挂载与文件描述符核验。控制文件、私有平台 namespace 和非普通文件不能入选。
- task_token 新命令必须来自可信且当前有效的准确 Run，在自身 Issue 或其直接准备关系的 Meeting 范围内登记上传字节、固定自身 Issue 的真实附件；当前 originator 仍为成员且有 Agent INVOKE。运行凭据 owner 不可替代 originator 授权。机器不浏览或摄取任意 NAS 路径。
- 机器读取只覆盖本 Run 的固定输入清单，以及同 Agent/source Issue/originator 精确授权来源自己登记的输入；同 Agent 不同发起人或 Issue 不能借历史复用。cloud_pat 无具体 Run 不新增输入、不取得私有文件。人类读沿当前 workspace/目标业务权限。
- 文件名、MIME、文件正文和文件内清单是数据，不是指令、权限或路径授权。默认附件下载，不内嵌执行 HTML/SVG/script。
- ready 只证明一次固定写入已经核验；当前 availability 是独立、可失败的观察，不伪撤销 ready 历史。所有同 key 重放先核当前成员、原 actor/意图及对象存续，再核会变的来源/配置。

### 首片明确的操作矩阵

| 操作 | 人类 | 可信 task_token | 无具体任务的 cloud_pat |
| --- | --- | --- | --- |
| 直接登记并上传文件 | 当前成员，显式目标权限 | 当前有效 Run 的自身 Issue 或直接准备 Meeting；上传者记录真实 Agent | 禁止 |
| 固定已有 Issue 附件 | 原附件 loader 与目标权限 | 仅该 Run 自身 Issue 的真实附件 | 禁止 |
| 浏览/手动选择 NAS 文件 | 独立 input_subpaths 与业务权限 | 禁止任意 NAS 浏览、路径摄取 | 禁止 |
| 初始 Meeting/agenda 引用 | 显式选择后事务验证 | 登记时可原子建立本次获准准备 Meeting/agenda 的准确初始引用 | 禁止 |
| 再引用到其他对象、编辑 Issue 清单 | 人类明确确认 | 禁止；不得通过第二个版本命令扩授权范围 | 禁止 |
| 读取固定私有内容 | 当前业务权限 | 本 Run 固定清单，或同精确授权来源自己产出的输入 | 禁止 |

机器初始引用仍核 `add_preparation` 与 agenda 所属 Meeting，不因任务相关就绕过取消/归档约束。输入 ready 和初始引用只表示登记与固定，不表示人已采纳、资料齐备或正式结论；不自动入新 manifest、不改变运行中 pin、不派发。

登记头、版本及 transfer 记录 typed `actor_type`（member/agent）、`actor_id`、`credential_owner_user_id`、`authorizing_user_id`，机器另记 `source_agent_id/source_run_id/source_issue_id`，不得以 JSON actor 或 Human=true 隐藏委托。来源准备 Meeting/agenda 如有也明确固定。originator、Agent、Run、运行端和 token tuple 均取可信服务端事实，客户端不提交这些身份。新机器 init/bytes/restart 必须重新核当前有效 Run 与准确来源；已接受字节的锁外核验不会因为正常 Run 终结就丢弃对象 intent，最终提交仍核原持久授权、当前成员/INVOKE及对象存续。停止 Run 不等于删除已固定输入。

## 3. 推荐模型：7 张表，不增加平行 Run 清单

下列是逐字段结构提案。JSON 只用于有界的不可变命令回执，不以 JSON 装可变正式关系、版本集合或任意执行计划。所有关系由应用事务验证，无 FK/级联。各 id 非空，唯一性由独立 CONCURRENTLY 索引实现。

| 表 | 正式字段与责任 |
| --- | --- |
| `cockpit_input` | id, workspace_id, title, description, project_id nullable, revision, current_version_id nullable, 上述 typed principal/source 列, creation_key/request_hash/creation_receipt, archived_at/by, created_at/updated_at。归档仅整理列表；无普通物理删除端点 |
| `cockpit_input_version` | id, workspace_id, input_id, number, submission_key/request_hash/submission_receipt, 上述 typed principal/source 列；source_kind、payload_kind、storage_origin；下述互斥来源列；source_filename/type/size；pinned_size/pinned_sha256/pinned_at；capture_state, active_transfer_id nullable, accepted_transfer_id nullable（首次固定，永不替换；借用为NULL）, current_transfer_id nullable（当前已核自有副本）, ready_at；独立 availability/verification 字段；created_at。内容 pin 仅 NULL→准确值一次，ready 后固定首次接受者/ready_at/hash/size/来源；当前副本只经准确同pin修复改变 |
| `cockpit_input_transfer` | id, workspace_id, input_id, version_id, number, kind=`direct_upload|source_capture`, command_key/hash/receipt, 上述 typed principal/source 列, state, revision, lease_token/expires_at, owned_storage_key, finalize_key/hash/receipt nullable, abort_key/hash/receipt nullable, observed_root_identity/file_identity/size/mtime_ns 与 after_file_identity/size/mtime_ns（来源捕获适用，显式列）, bytes_received nullable, content_pin_at nullable, io_finished_at/outcome, error_code/message, created_at/updated_at；browser 专用 session_expires_at；独立 cleanup_state/due_at/lease/verified_at。它同时就是上传 session 或捕获 attempt 及对象 intent，不另建三份同生命周期记录 |
| `cockpit_input_reference` | id, workspace_id, meeting_id NOT NULL, agenda_id nullable, input_version_id, purpose, creation_key/hash/receipt, actor_type/id及authorizing_user_id, created_at, removed_at/by, removal_key/hash/receipt。agenda 非空必须属于该 meeting；无 agenda 为全场资料，不用 polymorphic target JSON |
| `cockpit_issue_input_manifest` | workspace_id, issue_id，自然键；revision, current_version_id nullable, updated_at/by。只是可编辑清单的当前头；GET 不自动建头 |
| `cockpit_issue_input_manifest_version` | id, workspace_id, issue_id, number, command_key/hash/receipt, created_by/at, note, item_total, required_total, manifest_hash。每次保存追加，不改已存在版本 |
| `cockpit_issue_input_manifest_item` | workspace_id, manifest_version_id, position, input_version_id, purpose, required。最多200；同一固定版本只出现一次；行不可修改/删除，除授权 workspace/Issue 清理 |

### 来源与版本

`source_kind` 的第一版集合：`upload|nas_file|attachment|artifact_version`。

- upload：transfer/session 提供真实浏览器来源，保声明的文件名/大小/可选 client_sha256 与实际服务端 pin；没有 source_attachment_id。
- nas_file：source_root_id、source_relative_path、root_config_hash、root_identity、source_file_identity、source_size、source_mtime_ns 等明确列；不存凭据。NAS 读前后核同一打开文件及观察值；实际 spool SHA 才定义固定字节，不承诺 NAS 提供原子历史快照。
- attachment：source_attachment_id 及当时所属 source_issue_id nullable，经过原附件 loader/权限；只记录真实已有附件。源附件删除不等于固定副本删除。
- artifact_version：显式 source_artifact_id/source_artifact_version_id，只接受同 workspace 的 ready 固定版；payload_kind=text|file，pin 原版准确字节/hash/size。storage_origin=artifact_version，初次不建 transfer、不复制对象、不伪造 Attachment；无自有恢复副本时读取该固定版，不随成果 current_version 漂移。metadata 的 artifact_decision 是此固定版实际当前结论，ready/pending 可作资料但不等于 approved。输入清理从不删除借用对象；来源 Artifact/固定版本的删除与改写守卫必须识别这一 typed 引用。
- 原位置参考继续沿现有会议 NAS 位置入口，显示“未固定内容”；本片不为它制造 input_version，也不能进 manifest。

人类创建输入沿当前成员权限；metadata/新版本/放弃未完版本由该输入的人类creator、机器登记的authorizing user或当前owner/admin管理。机器在有效同 Agent/Issue/originator 来源内可继续自己的上传/新版本，不能接管其他来源。引用按目标会议/Issue权限。上传bytes只准当前transfer的真实actor和准确来源；管理员接手必须形成有自己的actor/新key的restart，不冒用原上传者。文件实际固化者通过accepted_transfer的actor读取，不能把最初登记人说成实际上传者。

capture_state：`awaiting_upload|queued|capturing|ready|needs_attention`；payload_kind=file|text。旧 ready 内容暂时失联不改为 needs_attention，使用 availability=`unknown|checking|available|unavailable` 和 checked_at/error。新 key/new version 是内容变化的入口，不能在原版本悄悄换字节。

verification 字段属于当前存储观察缓存：generation、lease、due_at、checked_at、proof_expires_at、provider_object_identity、last_error。它们不改正式内容 pin/版本号。后台逐文件核验，多个清单可复用同一固定版本的有效证明；无强对象身份时不能把一次 HEAD/mtime 相同冒充新 SHA 校验。实际交付仍验证准确字节。

### 为什么不单建 run_input_manifest

在 `agent_task_queue` 添加 nullable **input_manifest_version_id**，是这个 Run 唯一输入清单指针；没有平行 run_manifest 表或第二份 item 拷贝。引用的是不可变 manifest_version，已包含≤200个固定版本及 manifest_hash。该队列表当前没有 workspace_id，所有读取继续用真实 Task/Issue/Agent workspace loader；写入在 canonical tx 核 manifest 与 Run 所属 Issue/workspace。

运行前准备结果可用同一 Run 的 typed 列：`input_preparation_state=not_recorded|pending|preparing|required_ready|failed`、`input_preparation_hash`、`input_prepared_at`、`input_preparation_error_code`。只有准确 runtime/task/dispatched_at claim 的准备确认能改这些字段。NULL pointer 必须 `not_recorded`；不按当前 Issue 清单补旧 Run，不把准备结果写成“模型已阅读”。若未来要求一个 Run 多轮材料增补，届时才需要另立 Run 输入版本领域；本片不做。

人工成果溯源已由 root 批准纳入本片，用一个 typed `cockpit_artifact_version.input_manifest_version_id` nullable 列闭合，无新表：机器提交从可信 producer_run 的固定 pin 派生；人类必须显式选择有权读取的固定清单版本，省略保持 NULL。禁止从 producer Issue 当前清单倒填。此列只表达来源，不把原始输入自动变成果或绕评审。此列纳入本次结构/索引/不可变守卫；NULL 的历史来源不倒填。

## 4. 第一版迁移预算：7表、35个索引、37对迁移草案

所有新增索引每个独立单 statement `CREATE [UNIQUE] INDEX CONCURRENTLY`。root 已允许从9105起准备草案；下列完整范围须先经 root review/freeze，不能据此应用任何数据库。

| 表 | 索引及直接服务的查询 |
| --- | --- |
| input：6 | unique(id) 精确头；unique(workspace_id,creation_key) 未知新建回执；(workspace_id,created_at DESC,id) 25页；(workspace_id,project_id,created_at DESC,id) 明确登记项目；(workspace_id,lower(title) text_pattern_ops,id) 有界标题前缀检索。首片 q 明确前缀，不宣称任意全文搜索；(workspace_id,source_agent_id,source_issue_id,authorizing_user_id,created_at DESC,id) 为机器同精确来源的有界页，不扫全 workspace 再逐条判权 |
| version：6 | unique(id) 固定版；unique(workspace_id,input_id,number) 倒序版本页/序号；unique(workspace_id,input_id,submission_key) 原提交确认；(verification_due_at,id) WHERE ready 且需核验；(verification_lease_expires_at,id) WHERE核验进行中。后两者仅调度观察，不把 ready 改掉；(workspace_id,source_artifact_id,source_artifact_version_id,id) WHERE source_kind=artifact_version，为来源 Artifact/版本保留守卫提供索引，不扫全部输入版本 |
| transfer：8 | unique(id) session/attempt；unique(workspace_id,version_id,number) 尝试页；unique(workspace_id,command_key) 上传/重试原命令；unique(owned_storage_key) 明确对象唯一归属；unique(workspace_id,version_id) WHERE 非终态避免两个有效上传；(next_attempt_at,id) source_capture到期与awaiting_bytes session过期维护；(lease_expires_at,id) 失联接收/捕获恢复；(cleanup_due_at,id) 非完成清理责任 |
| reference：6 | unique(id)；unique(workspace_id,creation_key)；unique(workspace_id,meeting_id,COALESCE(agenda_id,zeroUUID),input_version_id,purpose) WHERE removed_at IS NULL；(workspace_id,meeting_id,created_at DESC,id) 全场聚合；(workspace_id,meeting_id,agenda_id,created_at DESC,id) 单题页；(workspace_id,input_version_id,id) 固定版被引用依据/反向分页 |
| manifest head：1 | unique(workspace_id,issue_id)，既是精确头也支持 workspace cleanup，不再给它无用途UUID/第二索引 |
| manifest version：3 | unique(id)；unique(workspace_id,issue_id,number) 历史页；unique(workspace_id,issue_id,command_key) 保存原回执 |
| manifest item：3 | unique(workspace_id,manifest_version_id,position) 顺序页；unique(workspace_id,manifest_version_id,input_version_id) 禁重复；(workspace_id,input_version_id,manifest_version_id) 引用保护/使用位置 |

表内合计 **6+6+8+6+1+3+3=33**。另加 `agent_task_queue(input_manifest_version_id,id) WHERE input_manifest_version_id IS NOT NULL` 和 `cockpit_artifact_version(workspace_id,input_manifest_version_id,id) WHERE ... IS NOT NULL`，完整预算 **35个索引**。相比上一草案34，增加的唯一索引服务已批准的 artifact_version 借用来源保留，不增加第8张表。

| 草案编号 | 内容 |
| --- | --- |
| 9105 | 7张正式表；Task typed manifest/preparation字段；ArtifactVersion nullable input_manifest_version_id；无索引、无FK |
| 9106–9111 | input 6索引 |
| 9112–9117 | version 6索引 |
| 9118–9125 | transfer 8索引 |
| 9126–9131 | reference 6索引 |
| 9132 | manifest head自然键 |
| 9133–9135 | manifest version 3索引 |
| 9136–9138 | manifest item 3索引 |
| 9139–9140 | Task pin与Artifact输出来源各1索引 |
| 9141 | 内容pin/来源/清单/回执/Run pin不可变及借用来源保留守卫；不替换旧冻结文件 |

共 **9105–9141，37对**。正式 down 必须由 runner 在删除第一个索引前核全批事实/cleanup tombstone和借用/Run来源，空态才允许逆序；新增对象条件迁移均记录账本，后续依赖用IF EXISTS/IF NOT EXISTS并明确缺表拒开放。

恢复上界必须实测：35不是已证明查询计划最优。服务增长列表25/100，manifest已选恢复按100 IDs分最多两批；metadata不读文件/大正文。不能为了减少索引让全部读取扫描正文或回退全数组。

## 5. 浏览器上传 session：从头重传，不做 chunk 引擎

一个 direct_upload transfer 就是一个明确上传 session（浏览器或获准 task 的完整字节上传），绑定 input/version、操作者、声明长度、owned key 和过期时间。建议 session 有效期24小时、单请求8分钟 I/O预算；实际值在 capability 明示，部署可下调。默认上限沿共享固化500 MiB；旧通用上传100 MiB限制不据此提升。

| state | 进入条件与下一步 |
| --- | --- |
| awaiting_bytes | init命令已持久化身份/owned key；原浏览器或获准 task 可发送一次完整请求，不表示已有字节 |
| queued | source_capture已登记等待有限worker，不接受浏览器bytes |
| reading | 精确session/revision领取上传lease；流式进入有界磁盘spool，有限并发和磁盘预算，数值进度只能取真实received bytes |
| pinned | 完整spool后短事务首次固定version size/SHA，或严格匹配既有pin；同commit进入pinned。已有pin时必须准确匹配。中间没有可误认为已固定的spooled状态；失败不得上传 |
| writing | 使用同一个spool写原attempt key；上传前已存在object intent和内容pin，不重新读浏览器/NAS来源 |
| verifying | 回读原key核size/SHA；未知结果先验证已知key，不能直接重发覆盖 |
| awaiting_finalize | 原key的I/O验证证据已持久，但版本尚未ready；浏览器自动接续finalize，刷新后仍可从此恢复，无须重传 |
| verified | Finalize事务核租约、版本/pin、成员与存续，ready指向这个accepted_transfer；不建评审Issue |
| failed / abandoned / expired | 原尝试终态与错误保留；可能存在对象由自己的cleanup责任处理；新尝试不能改写原结果 |

精确state集合为 `awaiting_bytes|queued|reading|pinned|writing|verifying|awaiting_finalize|verified|failed|abandoned|expired`。direct_upload从awaiting_bytes进入reading；source_capture从queued进入reading，来源是准确NAS descriptor或已有附件reader。kind约束禁止source_capture出现awaiting_bytes、禁止direct_upload被worker当作NAS源领取。每个leased状态有有界心跳续期；进程失联由独立lease维护变为expired，不能覆盖原完成回执。session_expires_at只限制尚未接收完整字节的会话；已核验且awaiting_finalize的对象保留准确后续入口，不因浏览器离开就自动当未上传。

中断后的真实恢复：用户重新选择原文件，从头发送到**新 transfer**，明确说明不续传已显示的百分比。新的 retry command_key 固定同 version及已知pin，保留原session结果；新session拥有新storage key，旧在途上传不能覆盖它。首次完整spool前没有内容pin，只能称“尚未固定”；不得声称能证明部分上传曾包含的全文件内容。pin之后，任何不同SHA必须返回 source_changed 并要求新版本。客户端可提供初始SHA提高早期识别，但服务器仍自行计算，不能信客户端当验证结果。

同pin恢复是明确命令：restart.mode=`retry_source|upload_matching_bytes`，写入固定receipt。后者只准当前管理权human，借用artifact和自有对象均可：重选完整原字节、严格匹配原size/hash、登记全新input自有transfer/key，绝不写回来源artifact。borrowed初次没有transfer时previous_transfer_id=null；其余必须回显原准确attempt。source/size/hash/ready_at/首次固定者不改，accepted_transfer_id始终保留首次值，active_transfer_id仅在途，current_transfer_id在精确当前lease+版本修订下指向新verified副本。读取优先current自有副本，否则原borrowed descriptor；旧attempt终态保留，晚成功不能替换更晚current。availability证明随副本换代，固定manifest与Run pin不变。正常source retry不从新路径或新NAS观察偷换来源。

输入身份与session登记分明：`POST /inputs`先原子建立独立头，current_version=null；`POST /inputs/{id}/versions`的upload来源就是init，原子建立待上传版本和第一transfer/session。UI一次“上传并固定”授权可连续完成登记→init→bytes→finalize，不再要求第二次人工审批；每步保留自己的准确命令与已成功ID，任何失败不回滚成“资料未登记”。

bytes请求只传完整文件流，完成后返回固定接收/pin摘要及session状态，不以HTTP传输完成宣称版本ready。`POST /.../transfers/{id}/finalize`携command_key、expected_revision及预期pinned_sha256：先核原key，锁外必要复核已知object；再同事务写不可变finalize receipt和ready。原session只有一次成功finalize，丢响应读取`GET /.../transfers/{id}/commands/{key}`；这一步已有准确session ID，不需增加全局command索引。后台source_capture可在原捕获授权内用同一Finalize实现完成，不经过Review逻辑。浏览器关闭在awaiting_finalize时，回到session直接继续这一确认，不重选/重复上传。

cancel在API命名上对应`abandon`，是独立一次性abort_key/hash/receipt，不把HTTP断开自动当业务取消。自动重试不能取消用户正在上传的新session。session初始未知结果按init key查询；finalize/cancel未知按已知session+原key查询，不能只看可变input头。

同 init/retry key 重放直接返回固定 session IDs；网络未知先 GET命令/原session。404、连接断开和缺字段都不是创建新key许可。Abort只终结该session，一次性abort_key/hash/actor/reason与回执可存该transfer，不另建通用command表；晚对象只归原cleanup intent。

pending File 对象/字节不持久化到前端草稿；只存用户文本、选定ID、声明元信息、观察修订、精确pending命令。刷新后明确要求重选，不能假称仍握有本地文件权限。重选错误不丢已登记 input/version。

## 6. Meeting/agenda 固定引用和任务清单

统一 reference 表，保持两种明确读取：全场 `meeting_id` 聚合，单题再限制 exact agenda_id。同一固定版本可在会议及多个议题各有自己的引用；不得按input当前pin替换。全场聚合可按固定version去重显示来源徽章，解绑必须指向准确reference ID，不删除其它议题关系。自然重复不同key返回409+existing_reference_id；原key重放已removed行不复活。

purpose 首片为 `material|recording|supporting`，只是人为用途，不代表已转写/评审。来源期望为录音却是非音频可以提示，不自动执行解析器或拒绝合法业务文档。位置参考沿现有位置入口，不进入文件清单。

Issue manifest 保存完整≤200个有序item，单次 `expected_revision` 校验；同command_key固定原版本；首片只有人类可确认保存，机器上传不触发此命令。空清单合法，旧Run仍保原版本。每项写 input_version_id/purpose/required，服务从版本读取准确 input/hash/size，不相信客户端标题和hash。只能添加已经有不可变size/hash的固定file版本；awaiting_upload/capturing/尚未固定的内容不能当固定材料入清单。已ready但当前失联的版本可以保留并标缺口；保存不等于允许运行，不能为存储暂不可用强迫用户清除历史。manifest_hash覆盖有序版本ID、固定内容hash/size、purpose及required，不包含可变标题或可用性缓存。

登记、引用、保存清单均不派发 Agent。用户另用既有显式运行入口；人类执行者无需创建假 Run。L3页面可显示其真实任务使用的清单来源，不声称已有直接input→L3归属；若要原始输入直接引用L3，须另审明确node关系与预算。

## 7. Run pin、核验进度与实际交付

1. 在 canonical enqueue 事务锁定当前清单头，选定一个 immutable manifest_version，写入新task.input_manifest_version_id；资料与Run同commit，任何失败不能留下“已绑定”假回执。未记录的旧/无关Run保持NULL。
2. 自动重试在 `CreateRetryTask` 的同一 INSERT ... SELECT 复制这个typed指针，新的准备状态重新从pending开始，不继承父Run的required_ready；FailTask与MaybeRetryFailedTask两个调用点一致。指定源Run人工恢复经 `RerunIssue→enqueueRerunTask` 继承源pin，即使当前Issue清单已改。明确新运行才能选择新修订；不可用必需资料不能通过换清单假装恢复原Run。
3. `buildClaimedTaskResponse/finalizeClaimDelivery`只读取task pin，返回manifest identity/hash/计数和有界读取入口，不临时展开当前meeting全材料。现QuickCreate/chat未接此清单时维持not_recorded，不补造旧事实。
4. 大文件核验在业务锁外由有限后台步骤进行，metadata页显示checking/失败/准确缺口。有效内容证明只能在同一固定对象身份下复用，不能每次同步HTTP持锁重hash200份500MiB文件，更不能用20秒超时宣称完整解决。
5. 真正启动前需在 `internal/daemon/daemon.go:runTask` 的Prepare→StartTask边界准备原清单：分页获取、校验下载/本地固定缓存hash、保留明确进度；必需项失败不启动Agent backend。只有实际准备好的集合可给准确task/runtime/manifest交付ACK。服务端StartTask再次核同pin/hash与准备状态，不能只靠daemon忽略字段后的旧行为。
6. 新daemon能力 `fixed_input_manifest_v1` 必须真实协商。旧daemon不接需要此能力的任务，不静默漏材料；提示可达升级/改执行端入口。任务已入队不等于材料已交付，更不等于模型已阅读。

在逐个 canonical入口、恢复与实际daemon准备都接通并验证前，`run_input_manifests` capability保持false。不能只写Task列和界面就称整链完成。默认测试用fake backend/私有fixture，真实Agent仍需单独授权。

## 8. 第一版准确 Go wire 与 HTTP

字段式 DTO 已落在 `server/internal/service/cockpit_input_types.go`、`cockpit_input_manifest_types.go`、`cockpit_input_nas_types.go`。以这三文件为实际字段名；下文缩写只说明概念。接口尚未注册、能力保持false。

通用命令：`command_key:UUID`、`expected_revision:int64`（新建无既有头时省略）、完整typed意图。回执 `{workspace_id,command_key,action,replayed,receipt,current?}`；receipt固定ID、request_hash、精确来源/选择，current不参与未知结果确认。输入创建命令不要求会议ID；可选择在同一事务明确创建一条meeting/agenda引用，不能隐式关联所有当前会议材料。

```text
InputHeader {workspace_id,id,title,description,project_id?,revision,archived_at?,
             current_version:VersionMetadata|null,can_submit,can_archive}
VersionMetadata {id,input_id,number,source_kind,filename,content_type,size_bytes?,
                 capture_state,content_hash?,ready_at?,availability,checked_at?,
                 unavailable_reason,can_download,can_retry}
TransferDetail {workspace_id,input_id,version_id,id,number,kind,state,revision,
                received_bytes?,expected_bytes,pinned_hash?,lease_expires_at?,
                error_code,error_message,can_upload,can_restart,can_abandon}
InputReference {workspace_id,id,meeting_id,agenda_id?,input_id,input_version_id,
                version_number,content_hash?,purpose,created_at,removed_at?,can_remove}
ManifestHeader {workspace_id,issue_id,revision,current_version_id?,item_total,
                required_total,available_required_total,unknown_required_total,
                unavailable_required_total,can_edit}
ManifestVersion {workspace_id,issue_id,id,number,manifest_hash,item_total,
                 required_total,created_by,created_at,note}
RunInputManifest {workspace_id,task_id,manifest_version:ManifestVersion|null,
                  preparation_state,preparation_hash?,prepared_at?,error_code}
```

各metadata增长列表为 `{workspace_id,scope,page_size,items,total,next_cursor}`，25默认/100上限；manifest items最多200、按25展开；已选恢复ids最多100/批。单体正文、source完整诊断、transfer错误按需读，不塞进列表。未知enum禁止危险写，API错误与空结果分开。

| HTTP草案（/api/cockpit，Task读沿现/api/tasks） | 精确用途 |
| --- | --- |
| GET `/input-spaces`；POST `/input-spaces/{rootId}/entries` | 单root配置+一个目录只读候选；q只在当前目录有界检索，不递归 |
| GET/POST `/inputs`；GET/PATCH `/inputs/{id}` | metadata页、独立登记、准确头、非内容文本修改 |
| GET `/inputs/commands/{key}` | 新建丢响应仍能读固定创建receipt，无须知道inputID |
| POST `/inputs/{id}/versions`；GET版本页/单版 | 固定来源意图；upload返回awaiting_upload及准确transfer，不声称ready |
| GET `/inputs/{id}/version-commands/{key}` | 精确原版本命令，不扫历史 |
| GET `/inputs/{id}/versions/{versionId}/transfers`、`/{transferId}` | 25页尝试元数据与单session详情 |
| PUT `/.../transfers/{transferId}/bytes` | 一次完整有界流，exact session lease；无客户端storage key、无任意URL |
| POST `/.../versions/{versionId}/restart`；GET `/.../transfer-commands/{key}` | 显式从头重传/原来源重读新attempt；固定pin不变 |
| POST `/.../transfers/{transferId}/finalize`；GET `/.../transfers/{transferId}/commands/{key}` | 精确固定pin的ready提交/原finalize或abandon回执；不重传 |
| POST `/.../transfers/{transferId}/abandon` | 只终结该尝试，不撤回已ready版本或删除NAS源 |
| POST `/.../versions/{versionId}/verify` | 调度准确固定内容的可恢复核验，不创建新内容版本 |
| POST `/.../versions/{versionId}/download-link` | 60秒短签名，独立input capability域；兑现重核人/Task scope并用同一verified spool |
| GET/POST `/meetings/{id}/input-references`；POST `/{referenceId}/remove` | agenda_id可空的统一固定关系；移除不删除输入 |
| GET `/meetings/{id}/agenda/{agendaId}/input-references` | 精确单题读取，同表，不另建第二份关系 |
| GET/PUT `/issues/{issueId}/input-manifest`；GET `/versions/{versionId}/items` | 当前头/追加版本/固定items页，不派发 |
| GET `/issues/{issueId}/input-manifest/commands/{key}` | 固定保存receipt与current分开 |
| GET `/api/tasks/{taskId}/input-manifest` | 实际task pin与必要资料准备状态；人用现Run VIEW，机器只能自身准确Run |

NAS页DTO明确为 `{workspace_id,root_id,relative_directory,root_config_hash,observation_token,page_size,items,total:null|int64,has_more,next_cursor}`；`has_more=true`必须有非空cursor，false必须cursor=null，每项带其文件观察token。下一页保持同scope/q，游标过期/目录变化保留已选ID和原观察；重新浏览的新文件不能替代旧确认中的来源。

NAS目录分页不能直接 `os.ReadDir` 全量排序。建议有界、短时只读枚举会话：固定root/目录descriptor，至多32个打开会话、每次最多100条，游标绑定workspace/actor/root/path/config/目录身份与观察。服务重启、目录变化或会话过期返回cursor_expired/changed，保留用户选择后显式回首页。可返回total=null/has_more，不伪造完整总数。若支持q，另限每页检查条目预算并披露仍有后续，不能为填满25命中扫描整棵根。

## 9. 错误、清理与实施门槛

| 稳定错误 | 真实恢复 |
| --- | --- |
| private_storage_required / input_scope_not_configured | 部署配置说明；不自动切到公开URL或导出权限 |
| source_changed / content_hash_mismatch | 保原版本pin；明确提交新版本或重选匹配原字节，不能清未知命令重发 |
| upload_incomplete / upload_session_expired | 读原session；明确新attempt、重新选择文件从头发送 |
| upload_in_progress / transfer_lease_changed | 核原session/command；不并行覆盖同一owned key |
| input_unavailable / verification_pending | 原固定对象核验进度、来源/存储恢复入口；历史ready不撤销 |
| manifest_changed / reference_exists | 保草稿，读准确当前版本/已有固定关系后明确确认 |
| input_runtime_unsupported / required_input_unavailable | 已记录Run pin不换；升级实际runtime、恢复必要版本，或明确发起使用新清单的新Run |
| permission_revoked / target_gone | 当前权限与对象入口；晚回执不复活；HTTP未知绝不按确定拒绝清草稿 |

workspace teardown先撤销运行/版本关联，再把每个transfer保留为cleanup责任并清业务头/关系/清单。 transfer兼有命令与对象意图，因此teardown必须同事务转为最小cleanup tombstone，清除用户文本、来源路径及完整命令receipt，仅保留owned key/必要ID、lease和I/O对账字段。普通写仍不可改历史；这一整批授权清理转换须精确绑定被删除workspace，不能提供通用绕过开关。只删平台自有私有对象与临时spool，绝不删NAS源或N1团队目录。上传late return按原owned key补记，不能生成新版本；没有上传结束证明的对象责任不能因短TTL就丢弃。具体保留时限与清理证明沿现artifact安全规则定案，不承诺全表立即0。

普通Issue删除必须同时处理自己未被保留的manifest头/版本/items；有真实Run/人工成果或借用成果来源需要保留的固定版本则提供权威operation-basis与真实办理入口，不能只新增一个409死路。纯输入归档不清引用。应用回退保留新增schema；任何内容pin、正式引用、Run pin或cleanup责任存在时，整批down先拒绝，再考虑一致备份恢复，不能先删索引。

实施顺序：①冻结本稿来源/权限/7表+35索引与上传协议；②共享纯字节层、私有namespace及直接上传恢复；③会议/议题引用与清单；④canonical Run继承、daemon准备/交付门禁与溯源；⑤完整真实接口、浏览器上传/刷新重选及故障验收后再开cap。迁移仅准备9105–9141草案，尚未freeze/apply。

必要回归包括：无L3/reviewer/工作包直接上传零Issue/Run；机器有效源登记并原子建立准确初始Meeting引用；同Agent跨originator/Issue拒绝；撤成员/INVOKE后零来源读取，cloud_pat拒私有文件，机器不得改manifest/跨对象引用；完整spool后上传失败仍保hash；未知上传成功先核原key；重选不同字节不能改原版本；源删除但固定副本可读；匿名/编码/alias私有拒绝；撤权/删除/晚上传无复活；会议+多个议题重复引用可分别移除；200items两批恢复/25分页；Run选旧清单、当前清单修改后自动和手动恢复仍旧pin；旧daemon不启动缺材料任务；必需内容失败不启动fake backend；500MiB与磁盘/并发预算、非真正冷缓存说明和owned清理证据。

本稿仅源码核对与设计，不构成N2能力已实现或已验证的声明。


## 10. 首轮实现交接：路由、ACK、分页与状态

基础 `/api/cockpit`；所有业务读写由可信 `CockpitInputRead` 注入身份并核 workspace。纯UUID输入，命令JSON最多256KiB，title≤512/description与note/reason≤16000/filename≤255，均UTF-8字节；保留文件正文与用户description/note原始空白，只有title、filename与reason按明确规则规范。`payload_kind` 是file|text，不由文件名推断。新能力建议 `inputs`（完整输入链）及 `run_input_manifests`（canonical+daemon全部接通），均默认false。

| 方法/准确路径 | 输入 → 输出 |
| --- | --- |
| GET `/inputs/capabilities` | 无 → CockpitInputCapabilities |
| GET `/inputs` | Scope各字段；ids重复参数≤100；page_size25/max100 → CockpitInputPage |
| POST `/inputs` | CockpitInputCreateInput → CockpitInputCreateResult |
| GET `/inputs/commands/{commandKey}` | 原创建命令 → CockpitInputCreateResult，无需知道input ID |
| GET/PATCH `/inputs/{inputId}` | 读头 / CockpitInputEditInput → CockpitInputHeader |
| POST `/inputs/{inputId}/archive` | CockpitInputArchiveInput → CockpitInputHeader，true归档/false解除 |
| GET/POST `/inputs/{inputId}/versions` | 页 / CockpitInputVersionSubmitInput → VersionPage / VersionResult |
| GET `/inputs/{inputId}/version-commands/{commandKey}` | 固定提交回执 → CockpitInputVersionResult |
| GET `/inputs/{inputId}/versions/{versionId}` | 单版按需正文 → CockpitInputVersionDetail |
| GET `/inputs/{inputId}/versions/{versionId}/transfers` | 页 → CockpitInputTransferPage |
| GET `/inputs/{inputId}/versions/{versionId}/transfers/{transferId}` | 准确session → CockpitInputTransferDetail |
| PUT `/inputs/{inputId}/versions/{versionId}/transfers/{transferId}/bytes` | 全文件stream、`X-Input-Transfer-Revision`正十进制int64 → CockpitInputUploadResult |
| POST `/inputs/{inputId}/versions/{versionId}/restart` | CockpitInputRestartInput → CockpitInputTransferResult |
| GET `/inputs/{inputId}/versions/{versionId}/transfer-commands/{commandKey}` | 原restart → CockpitInputTransferResult |
| POST `/inputs/{inputId}/versions/{versionId}/transfers/{transferId}/finalize` | CockpitInputFinalizeInput → CockpitInputTransferResult |
| POST `/inputs/{inputId}/versions/{versionId}/transfers/{transferId}/abandon` | CockpitInputAbandonInput → CockpitInputTransferResult |
| GET `/inputs/{inputId}/versions/{versionId}/transfers/{transferId}/commands/{commandKey}` | 原finalize/abandon → CockpitInputTransferResult |
| POST `/inputs/{inputId}/versions/{versionId}/verify` | 无body，幂等调度观察 → CockpitInputVersionMetadata |
| POST `/inputs/{inputId}/versions/{versionId}/download-link` | 无body → CockpitInputDownloadLink，60秒准确版本/用户或task签名 |
| GET/POST `/meetings/{meetingId}/input-references` | agenda_id可空/页 / CockpitInputReferenceCreateInput → ReferencePage / ReferenceResult |
| GET `/meetings/{meetingId}/agenda/{agendaId}/input-references` | 精确单题页 → CockpitInputReferencePage |
| POST `/meetings/{meetingId}/input-references/{referenceId}/remove` | CockpitInputReferenceRemoveInput → CockpitInputReferenceResult |
| GET `/meetings/{meetingId}/input-reference-commands/{commandKey}` | 准确创建/移除receipt → CockpitInputReferenceResult |
| GET/PUT `/issues/{issueId}/input-manifest` | 当前头 / CockpitInputManifestSaveInput → Header / Result |
| GET `/issues/{issueId}/input-manifest/commands/{commandKey}` | 原保存 → CockpitInputManifestResult |
| GET `/issues/{issueId}/input-manifest/versions` | 页 → CockpitInputManifestVersionPage |
| GET `/issues/{issueId}/input-manifest/versions/{manifestVersionId}` | 固定版note按需 → CockpitInputManifestVersionDetail |
| GET `/issues/{issueId}/input-manifest/versions/{manifestVersionId}/items` | 页 → CockpitInputManifestItemPage |
| GET `/input-spaces` | 单root元数据0/1 → CockpitInputSpacePage，仅human |
| POST `/input-spaces/{rootId}/entries` | CockpitInputNASBrowseInput → CockpitInputNASPage，仅human |
| GET `/api/tasks/{taskId}/input-manifest` | 精确Run pin → CockpitRunInputManifest；人VIEW/机器自身task |
| POST `/api/tasks/{taskId}/input-preparation` | CockpitRunInputPreparationInput → CockpitRunInputManifest，沿现runtime/task/dispatched_at claim门禁 |

Run准备沿现canonical claim的 `task_id/runtime_id/dispatched_at`，不新造task lease UUID；Task追加input_prepared_dispatched_at以拒绝上次claim迟到准备ACK。新claim/自动retry重新准备，不能复用旧required_ready。每项安全交付名从固定version UUID/position及受限扩展生成，既不信来源标题，也不拼输入路径。

创建receipt.input_revision固定1；提交版本receipt.transfer_revision固定该次首transfer修订（通常1，借用成果为null）。链式恢复只用固定receipt中的修订，不把replay.current后来的修订倒填成原授权。只有创建/版本/transfer/引用/manifest命令承诺持久key回执。可逆metadata编辑与归档沿revision CAS，未知响应保客户端草稿、回读再确认，不借一个可覆盖last_key伪装完整命令历史。引用自然重复不同key409 `reference_exists` + existing_reference_id；同key移除已removed仍返原remove回执，创建原对象已彻底不存在410，不重新建立。

引用页支持q（输入title/固定filename前缀）及purpose精确过滤并原样回显；total是过滤后行数。ReferenceSummary不随q/purpose变化，按active全scope统计：total=ready+pending+needs_attention；ready仅表示已固定，ready=available_ready+unavailable_ready+unknown_ready（checking归unknown），不等于全部可下载。原source.issue与submitted_by.issue_id分别为文件来源和登记任务来源。NAS目录进入只凭`kind=directory && can_open_directory`，不能用reason空串推权限。

下载兑现只用相对签名路径 `/api/cockpit/input-files/{versionId}/download?token=...`；token绑定workspace/input/version/hash/size及真实人或准确task principal，60秒。兑现重核当前权限后用同一verified reader，不导航任意object_url。metadata/签名发放不能伪造内容已回取。

byte body Content-Type固定application/octet-stream；声明文件名/MIME/长度/client SHA来自原init，不能由上传头改写。Go在读取body前核principal、session、revision并领取唯一lease；不是awaiting_bytes立即拒绝、不读流。专用web流式路由500MiB/8分钟/有限2并发，不提升旧全局100MB缓冲。已接受bytes后只有awaiting_finalize可完成版本，不以传输HTTP成功冒充ready。

Page cursor固定workspace/actor授权scope/filter/页大小及keyset；metadata追加页最新优先(created_at,id DESC)，manifest items按position ASC。版本/transfer状态变化不使无关后续页游标失效；NAS观察cursor另按真实目录身份/范围变化失效。错误时保原选择/草稿，不静默替换原NAS观察。查询不初始化input/manifest/board。

WS 使用 `scope:inputs`、entity_id=inputID；引用变化附meeting_id/agenda_id；`scope:input_manifests`、entity_id=issueID。只失效Query；字节进度限频且来自实际server读，不写Zustand服务数据。后台核验/cleanup始终保固定身份，全部能力在真实链路验收之前false。
