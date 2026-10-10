# 稳定 UUID 计划快照与只读差异

本切片复用 `cockpit_snapshot.payload`，不新增 DDL，不批准正式计划基线，也不提供成组恢复命令。

## 保存

`POST /api/cockpit/snapshots` 沿用原来的可选 `label` 和响应格式，仍保存整个工作区。新手动保存及普通编辑后的自动快照在同一个 REPEATABLE READ 事务读取数据；工作区/板身份锁避免保存到已经删除的板。

payload 保留既有 import 文档字段，额外写入 `plan_identity`：`schema_version:1, workspace_id, cockpit_id, complete:true, counts, board, nodes, payments, milestones`。每个计划实体包含稳定 `id`、可读编号/名称，以及明确白名单内的计划字段。新增字段不会自动进入同一个 schema version。预算等数值保持数据库精度。

保存仍承担原全板快照的读取与存储成本，本切片没有把旧保存格式改成只含计划。新差异 SQL 只取 `payload.plan_identity`，不把旧会议正文或任务关系数组传到比较服务；它不等于已经解决所有历史快照的存储增长。

会议、Issue 关系、Run、纪要、正式验收不在计划差异范围内；它们原有的快照/业务保护不因此放开。导入与 restore 前的保护快照保持旧格式，其写入事务没有承诺该项新一致性，不能给它补上假的完整 UUID 标识。现有 50 份保留上限不变；这不是长期保留的正式基线档案。

原 restore 仍按旧文档语义执行，忽略 `plan_identity`；绑定节点、主归属及正式工作流的服务端 restore/import 拒绝逻辑保持。稳定 UUID 元信息只供比较，不指示服务端复活旧对象。

## 读取

`GET /api/cockpit/snapshots/{snapshotId}/diff?cursor=&page_size=25`。

- 工作区成员可读，快照 ID 严格限定当前工作区；GET 不创建板、不写快照、不改计划、不派工、不访问 NAS。
- scope 固定为 `workspace`。提供 project_id/module_id 返回 400，避免把完整工作区历史冒充当前筛选范围。
- 默认 25，最多 100；超限返回 400。当前与快照均限制 5000 节点、25000 付款、2000 里程碑，超限返回 413 `snapshot_diff_limit`，不做截断后比较。
- 比较方向为“当前计划相对保存快照”：added 为当前新增，removed 为当前缺失，modified 为同一 UUID 字段变化。排序按 board/node/payment/milestone，再 UUID。items 不包含 unchanged；counts 统计全量实体，包含一条板计划头。
- 新增/缺失项只返回可读身份，不携带全文。修改项返回字段、before/after；每值是 JSON 标量，字符串最多显示 512 Unicode 字符，`truncated` 明示截断，`sha256` 对完整原始 JSON 值计算。编号/名称标签最多 160 字符加省略号，不能用摘要反向 apply。
- 忽略更新时间、操作者等审计噪声；数字按精确数值比较，不把 `1.0` 与 `1.0000` 当业务变化。改名/改编号不会改变 UUID 配对；同编号的不同 UUID 仍是新增与缺失。
- `comparison_token` 固定两侧计划内容。游标绑定工作区、快照、页大小、内容令牌和位置；跨范围/页大小误用返回 400，计划在翻页期间变化返回 409，重新读第一页。不同请求仍可能看到不同时间点，服务不声称有跨请求长事务。

响应 DTO 见 `server/internal/service/cockpit_snapshot_diff_types.go`。可比结果：reason 为空、token 为 64 位十六进制、两侧 complete 且同 cockpit；不可比结果：`comparable:false`、明确 reason、items 空、total 0、next_cursor null、token 空，不得在 UI 显示成“计划没有变化”。

| reason | 含义与动作 |
| --- | --- |
| legacy_identity_missing | 旧格式或导入/恢复保护快照没有稳定身份；继续查看旧历史，另存新快照后比较；不猜 code/name 映射 |
| unsupported_identity_version | 当前服务不认识该身份版本；保留记录，使用支持该版本的服务 |
| incomplete_identity | 未承诺完整身份集合；不能计算完整差异 |
| invalid_identity | 身份、字段、数量或作用域损坏；不自动修复，不猜匹配 |
| cockpit_missing | 当前驾驶舱已不存在；读取不会重新创建 |
| cockpit_replaced | 当前板与保存时不同；不能把新板同名节点当原对象 |

本批验证包括同名不同 UUID、重命名、精确预算、长文本截断、跨工作区、陈旧游标、旧/坏格式、空板不创建、读取零副作用及原 restore 保护。运行验证仅在 agent 3；本文件的合同不代表测试已完成，结果由该轮验证报告登记。
