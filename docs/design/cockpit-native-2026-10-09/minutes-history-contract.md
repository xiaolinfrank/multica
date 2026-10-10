# 纪要工作台与长期历史读取

日期：2026-10-10。本批围绕已有纪要、评审、发布、交接和 NAS 操作改造读取方式，不另建版本系统；最终验证见开发进度及对应验收记录。

## 工作面

工作台保留两项独立事实：“当前工作版本”用于正在进行的修订或评审，“正式纪要”指向已发布版本。新提交不会遮蔽仍然有效的正式版本。

版本列表只载入元数据，每页默认 25、最多 100。点击版本才读取该份正文及评审反馈；默认打开会议不下载全部正文。评审控件与成功加载的准确当前正文相邻；历史正文只读。阅读期间产生新版本，保留原来的阅读对象和反馈草稿，不能把已有反馈转交给新版本。

评审交接与 NAS 操作历史分别分页。关掉历史区域不继续拉取下一页，也不为显示版本号而下载所有正文。名称、原因及路径按容器换行，列表和阅读区有明确滚动范围，筛选与翻页操作保持可达。

## 新读取合同

以下路由均以 `/api/cockpit/meetings/{meetingId}/workflow` 为前缀，需工作区成员权限；GET 不创建驾驶舱或改变会议状态。

| 路径 | 结果 |
| --- | --- |
| `GET /summary` | `representation: summary`；工作包头、权限、当前与正式版本元数据、三类历史数量及活跃 NAS 操作数；不含历史数组或正文 |
| `GET /versions?page_size&cursor` | 版本元数据页，按版本号倒序；不含正文及反馈文本 |
| `GET /versions/{versionId}` | 一个固定版本的正文、反馈和当前权限；不替换为“最新版本” |
| `GET /reviewer-handoffs?page_size&cursor` | 交接记录页，含对应版本号；按交接 revision 与 ID 倒序 |
| `GET /exports?version_id&status&page_size&cursor` | NAS 操作页，附来源版本元数据；可按版本或状态筛选，`active` 指 queued/running/retry_wait |

列表统一返回 `workspace_id`、`meeting_id`、`workflow_revision`、`items`、作用域总量 `total` 和 `next_cursor`。游标绑定工作区、会议、筛选与页大小。每次读取反映当前数据库快照，不承诺跨页冻结历史；翻页不能把别的会议或筛选结果当作本页。

摘要中的 `published_nas_export` 是当前正式版本与当前配置目标的准确自然键匹配，不是列表中“最近的一条”。不存在匹配时不得因为旧操作恰好不在第一页而误认为已经同步。`nas_active` 支持选中会议的有限轮询；解析目标仅检查配置和路径，不在摘要读取时探测物理文件系统。

## 写入回执与兼容边界

新客户端在已有工作流命令上显式请求 `?response=compact`，返回：

```text
representation: compact
workspace_id / meeting_id
workflow: 当前 Summary
receipt:
  action: 已确认的命令种类
  version: 本次命令对应的一个完整版本，或 null
  handoff: 本次 handoff_key 对应记录，或 null
  nas_export: 本次目标对应操作及来源元数据，或 null
```

精确回执与当前摘要分别承担职责。重放第 1 版提交时，当前可以已经到第 35 版；仍须确认原 submission_key、原文及版本身份。提交沿用既有服务端规则，去除正文首尾空白后固化，CLI 按同一规范核对内容与 hash。交接重放也不能只检查“当前评审人是不是目标人员”，必须核对原 handoff_key 的结果。NAS 重试核对同一操作及固定目标，不把另一次导出当作成功。

实现从数据库按命令键获取有限对象，不在读取全部历史后裁切回包。旧 `GET /workflow` 和未选择 compact 的写响应保留既有完整合同，供已安装客户端和已有脚本使用；新 Web/Desktop 工作面不依赖旧完整读取。

会议关联增加只读 `required_roles`，从正式纪要任务、当前/历史评审与交接事实计算。旧评审任务即使不在当前历史页，必要用途仍受保护；可编辑的用途标签不充当保护依据。后端既有删除和解除保护继续执行。

## 客户端状态与恢复

摘要、单版本正文和历史页分属工作区隔离的 Query 缓存。命令回执只更新准确对象，不把加载过的全部历史塞回工作包摘要。当前版本更新使原位权限重新求值，旧正文不会突然变成可编辑的新版本。

筛选、页码、展开位置和未提交草稿属于客户端上下文；服务器版本内容留在 Query。未知枚举、错误范围或无法确认的回执不能解锁批准、发布或导出操作；失败保留用户输入并允许核对后重试。

## CLI

```bash
multica cockpit meeting workflow summary <meeting-id>
multica cockpit meeting workflow versions <meeting-id> --page-size 25
multica cockpit meeting workflow version <meeting-id> <version-id>
multica cockpit meeting workflow handoffs <meeting-id> --page-size 25
multica cockpit meeting workflow exports <meeting-id> --status active
multica cockpit meeting workflow submit <meeting-id> --revision <n> --submission-key <uuid> --content-file ./minutes.md --compact
```

旧 `show` 和默认写输出保持兼容，新调用使用有界命令和 `--compact`。读取不会自动批准、发布、派工或重试 NAS。

本批不改变正式状态机、发布条件、幂等键或文件写入协议；没有真实 NAS/Agent 执行授权的扩大。旧全板引用数组、通用成果与自动提取仍是独立后续工作。
