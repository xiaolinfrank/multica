# 固定纪要的 NAS 导出合同

本批接续已实现的工作包、固定纪要、人工评审和责任交接。实现范围是“平台已发布版本 → 可追踪的 NAS Markdown 副本”；文件扫描、转写、通用成果库和跨 daemon 存储映射仍属后续阶段。

## 用户流程

- 发布已通过的当前版本时，可以勾选“同步已发布纪要到 NAS”。界面只在存在受管目录预览时默认勾选，传入用户看到的根ID和绝对目录。
- NAS 是否在线不参与发布数据库事务。发布和导出意图同事务保存，之后后台执行；文件失败显示“已发布 · NAS待同步/需处理”，不撤销发布或要求重新评审。
- 没有配置受管根、会议目录为空或超范围时，仍可单独发布平台版本。之后可明确导出已发布版本，不自动扫描或处理历史文件。
- 每份导出固定版本、内容hash和目标。目录变化不会重定向旧记录；明确导出到新目录会形成新的目标记录，同版本同目标请求复用已有记录。
- 重试只针对原记录。已有目标文件内容相同可确认成功；不同内容、链接、目录或异常对象均不会被覆盖。

## 位置与授权

部署参数`COCKPIT_NAS_EXPORT_ROOTS`为JSON数组，初版每个工作区最多一个受管根：

```json
[{"workspace_id":"<uuid>","root_id":"<uuid>","path":"/mounted/share/workspace","allow_local":false}]
```

不同工作区的根不能重叠，root_id不可重复。根由部署配置授权，不能由会议的可编辑路径创造授权。预置文件`.multica-root-id`的文本必须等于root_id；平台不创建根或身份文件。默认要求实际网络文件系统，显式`allow_local:true`仅用于受控本地存储或测试夹具，不是自动降级。

`meeting.nas_dir`必须是受管根内的服务器原生绝对路径；新导出请求与事务内当前会议目录比较，过时目标返回409。目录预览只验证配置和范围，不宣称NAS在线。会议目录必须已经存在；文件执行器只创建其下的“已发布纪要”目录。

输出名称固定为`已发布纪要/minutes-v0001-<完整版本UUID>.md`，数字为版本号且至少四位。文件是数据库版本的精确UTF-8内容，不加头部、不修改换行。根路径、会议目录、相对路径和完整目标路径随记录保存，根映射变化不会默默改投新位置。

当前执行位置为配置该根的服务器；仅macOS/Linux支持，其他平台明确报告不支持。名称标记是身份核对，不替代部署账户/NAS权限；不宣称平台已隔离拥有共享盘权限的Agent shell。

## HTTP

现有发布路径的body扩展为`{expected_revision, nas_export?:{root_id,directory}}`。省略nas_export保留原行为。目录/根输入不合法则拒绝请求；网络存储离线不属于这类输入错误。

| 动作 | 路径与body |
| --- | --- |
| 单独导出已发布版本 | POST `.../workflow/versions/{versionId}/nas-export`，`{root_id,directory}` |
| 重试固定目标 | POST `.../workflow/exports/{exportId}/retry`，`{expected_revision}`，使用操作自身修订 |

均要求工作区成员身份且为人类管理人或该版本的评审人，不接受机器凭据。单独导出可作用于仍保留批准/发布记录的旧版本。所有写入返回直接完整workflow DTO。

GETworkflow新增：

```text
nas_destination: {root_id,directory} | null
nas_unavailable_reason: string
can_export_nas: boolean  // 对当前published_version_id的能力提示
nas_exports: [{
  id,version_id,version_number,source_issue_id,content_hash,
  root_id,directory,target_path,status,attempts,revision,
  next_retry_at,created_at,updated_at,completed_at,
  last_error_code,last_error,size_bytes,can_retry
}]
```

directory和target_path均为绝对路径；旧响应默认空目的地/空数组/false。状态为queued/running/retry_wait/succeeded/needs_attention，未知状态只读。响应确认核对操作ID、版本、hash、根和目录；“请求成功”不等于“文件已写入”。后台仅改变操作revision，不改变工作包revision，客户端按各操作修订合并，避免旧HTTP响应覆盖新状态。

## 可靠执行

- PostgreSQL记录自然去重键（工作区、版本、根ID、相对路径），不为确定性文件复制创建新Issue。
- 领取使用数据库时间、SKIP LOCKED与租约令牌；只领取本执行器已配置的根。状态落库必须匹配本轮令牌，旧执行器不能覆盖新尝试的结果。
- 每轮最多8次自动尝试，按退避延迟推进；手工重试保留累计attempts、重置本轮预算，不改变固定目标。重试要求操作修订一致，旧修订返回409。
- 文件执行在数据库事务之外。打开根目录句柄并核对挂载和标记，逐段NOFOLLOW打开既有会议目录；临时文件使用操作ID/租约令牌区分，写入和同步后原子、不覆盖地提交。文件系统不支持该提交能力时明确拒绝，不能退回覆盖式rename。
- NAS系统调用可能在内核中阻塞。执行器并发受限，不用不断派生的goroutine假装实现可取消I/O；租约与固定内容、不覆盖写入共同处理重复执行和重启恢复。
- 数据库记账失败但文件已提交时，重新核对相同路径/内容后收敛；不因响应丢失再创建版本或任务。
- 删除工作区清理导出记录，但不自动删除团队NAS文件。已领取的外部I/O可能在删除时完成，不能宣称数据库删除会原子撤回共享盘写入；其晚到结果不能恢复已删除记录。

## 验证范围

全部运行测试在agent 3。首轮使用allow_local临时夹具、专用multica_test库及Redis实例，覆盖事务回滚、并发去重、离线/恢复、原目标重试、超过预算、过期租约、异常提交后对账、路径逃逸/符号链接/内容冲突、工作区删除和实际浏览器发布/重试/路径展示。

随后经用户授权使用真实`/Volumes/人机协作空间` SMB挂载验证，发现当前macOS挂载不支持独占rename，正式导出验收未通过；普通读写和目录同步成功不能替代该能力。平台保持安全拒绝，不回退覆盖写入。复现方式、失败与保护行为见[真实NAS验证记录](../../development/agent3-real-nas-tests.md)。

## CLI

三个入口都返回完整 workflow JSON，不把请求已受理当作文件已完成。会议、版本、导出操作与根使用 UUID；目录为从 `workflow show` 获取的服务器绝对路径。

```sh
multica cockpit meeting workflow publish <meeting-id> <version-id> --revision <workflow-revision> --nas-root-id <root-id> --nas-directory '/mounted/share/workspace/meeting'
multica cockpit meeting workflow export-nas <meeting-id> <version-id> --root-id <root-id> --directory '/mounted/share/workspace/meeting'
multica cockpit meeting workflow retry-nas <meeting-id> <export-id> --revision <export-operation-revision>
```

发布时两个 NAS 参数可一起省略，保留仅平台发布；不能只传其中一个。单独导出不传工作包修订。重试只读取 `nas_exports[].revision`，不接受改投新目录；409 后先重读原操作并核对意图。三个写入口均沿用服务端的人类凭据与管理人／版本评审人权限检查。

CLI 还核对回执中的操作 UUID、版本、根、规范目录和固定内容 hash；重试核对操作 ID、修订及已排队／执行中／成功状态。旧后端忽略发布的 NAS 参数或回执不完整时返回错误，并明确提示平台发布可能已经成功，应先重读确认；不自动重发，也不更换凭据。

副本状态描述最后一次成功核验，不持续监控外部修改；检测到提交期间目录移动或替换会拒绝确认原路径。进程硬退出可能遗留本轮隐藏临时文件，文件名含操作/租约ID，不被当作正式成果；本批不做跨目录临时文件清扫。
