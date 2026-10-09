# 会议行动与 L3 任务跟进

本批从已发布纪要形成可确认的行动，并复用现有 Issue 执行。一个 L3 可承接大量任务；会议、行动、任务选择器和历史入口同样按大量数据设计。本批不修改 NAS 写入合同。

## 业务与规模边界

- 行动来源固定到已发布纪要版本、内容指纹和可选原文引用；原文引用必须确实存在于该版本。
- 首版由有权限的人登记、编辑、确认建议，不宣称已实现 AI 自动提取。
- 确认时选择新建任务、复用已有任务或不执行。新建任务进入 backlog，默认归当前人，不自动启动 Agent；复用任务不改其内容、执行状态、负责人或期限。
- 新建、复用要求来源仍为当前已发布且已批准版本；过时的待处置建议可以明确不执行。已接受的旧版行动及其任务继续保留来源。
- 一项 Issue 至多一个主归属 L3。主归属用于唯一计数，旧参考关联保持可见；普通关联不搬迁任务，不推断已有链接的业务角色。
- 主归属节点为具备有效项目/模块继承关系的执行叶子。Issue 项目/模块须一致；不一致或复用时已有另一个主归属，返回冲突。
- 新主归属不装入全驾驶舱 `issue_links` 数组。列表按当前节点或会议按需读取，默认每页 25 条、最多 100 条，服务端筛选与游标分页。
- L3 默认 `category=active`，只排除已完成、已关闭；未知旧状态保守保留。摘要仍分别显示五个生命周期分类，“未结束”计数为总量减已完成和已关闭。
- 状态摘要覆盖当前关系范围的全部任务，不只统计当前页；已完成、已关闭与未知状态分开。任务执行状态始终来自 Issue，不另存行动执行状态。

## API 合同

所有路径均在 `/api/cockpit` 下；写入要求人类身份，服务端检查成员、管理人或版本评审人权限。提案键与决定键记录完整意图；重放同一请求返回已有结果，不重复创建任务。

| 动作 | 路径 | 参数 |
| --- | --- | --- |
| 分页读取行动 | GET `/meetings/{meetingId}/workflow/actions` | `version_id,status,q,cursor,page_size` |
| 按需读取单条行动 | GET `/meetings/{meetingId}/workflow/actions/{actionId}` | — |
| 新建建议 | POST `/meetings/{meetingId}/workflow/versions/{versionId}/actions` | `proposal_key,title,description,source_quote` |
| 编辑待处置建议 | PATCH `/meetings/{meetingId}/workflow/actions/{actionId}` | `expected_revision,title,description,source_quote` |
| 确认处置 | POST `/meetings/{meetingId}/workflow/actions/{actionId}/resolve` | `expected_revision,decision_key,outcome:create\|reuse\|dismiss,node_id,issue_id,assignee_type,assignee_id,priority,due_date,reason` |
| L3 任务列表 | GET `/nodes/{nodeId}/tasks` | `q,status,category,relation:primary\|reference,cursor,page_size` |
| 从 L3 原子新建任务 | POST `/nodes/{nodeId}/tasks` | `creation_key,title,description,priority,assignee_type,assignee_id,due_date`；返回任务与原创建键 |
| 查看主归属 | GET `/issues/{issueId}/primary-node` | — |
| 查看任务的来源行动 | GET `/issues/{issueId}/actions` | `cursor,page_size`；只读来源页，不装入全板关联数组 |
| 设置或清空主归属 | PUT `/issues/{issueId}/primary-node` | `node_id:UUID\|null,expected_revision`；首次修订为 0 |

`create`、`reuse` 要求 `node_id`；`reuse` 指定现有 Issue；`dismiss` 要求理由。复用不接受新任务的负责人/期限等字段。显式变更主归属可在同一项目/模块范围内进行，旧主归属保留为参考；普通 Issue 编辑、资源删除和计划结构修改须维护关系一致性。

行动记录包含：`id,meeting_id,version_id,version_number,source_content_hash,source_quote,title,description,status, resolution,revision,proposal_key,decision_key,node_id,node_code,node_name,issue,reason,created_by,created_at,updated_at,resolved_by,resolved_at,can_edit,can_resolve,source_superseded`。`status` 为 `draft/accepted/dismissed`；`resolution` 为 `create/reuse/dismiss/null`，`issue` 为当前任务的轻量事实。

行动列表返回 `items,total,filtered_total,next_cursor,can_add`；L3 列表返回 `items,total,filtered_total,next_cursor,summary,eligibility`。`summary` 包含 `total,by_status,by_category,done,closed,unknown`；`eligibility` 明确节点是否可作主归属以及其项目/模块。页游标不能跨工作区、对象或过滤条件混用。

## UI/UX 验收

- L3 默认任务工作区：全量摘要、可点击的状态筛选、搜索、紧凑行列表、分页。计划字段保留在独立分区，不把几百个 Issue 铺成卡片，也不展开到甘特的每个节点下面。
- 会议行动使用独立分页列表，区分待处置、已接受和不执行；确认面板展示固定来源及本次真实效果。
- 复用 Issue 的选择器按需搜索与分页，保留已选项，不一次加载整个工作区。
- Issue 详情以单独分页读取正式行动来源，能够返回来源会议/行动；正式来源没有“解绑”操作。图谱从主归属与行动表投影连线，不双写到旧关系表。
- 游标与对象、筛选条件绑定；首次进入对象或实际更换筛选从首页开始，返回同一对象的同一筛选则保留页码。加载失败不能被显示为“没有任务”。
- 未确认写入保留用户输入及原幂等键；成功后刷新计数与列表。旧响应不覆盖新确认结果。
- 从 L3 新建任务的 `creation_key` 在任务后续移归属、解除归属或删除后仍保留防重复语义；重放不得将它移回原 L3，已删除的任务不得被重新创建。
- 大量数据原则适用于其他改造界面：资料、版本历史、待办、关系选择器同样需要有界读取、明确筛选范围与返回位置。尚未改造的区域不宣称已完成规模验收。

## 验证边界

运行测试均在 agent 3。至少验证 120 个 L3 Issue 的跨页、不重复、搜索与准确摘要，会议行动重复确认、复用、不执行、来源过时及权限冲突。新的实际界面同时检查宽窄屏、长标题、空态与请求失败。协调机仅编译与静态检查；不部署生产，不运行真实 Agent。

## 数据库回退边界

正常应用回退保留数据库 schema、行动历史及创建回执，通过回退应用版本或停用入口处理；不能为了回退界面删除已确认的业务事实。

本批 **979–988 是完整数据库降级单元**，不支持任意单文件 down 后直接 up。986 使用已有唯一索引提升主键；PostgreSQL 删除主键约束时会一并删除它拥有的索引，因此只降级 986 再重上，会缺少 980／983 原先创建的索引。不能用普通非并发建索引、修改迁移历史或暗中重建索引来掩盖这个依赖。

物理降级仅用于这两张表均为空的隔离环境，或已制定并验证整库备份恢复计划的维护窗口。必须停用访问该数据库的新应用和所有测试进程；不会自动清业务记录来满足空表条件。若需要恢复完整升级状态，应完整降级至 978，再重放 979–988，最终核对 schema 版本、两个主键、七个索引和三个完整性守卫。

**迁移器的 `down` 会处理当前目录发现的全部迁移，不能在仓库／suite 的完整迁移目录执行。** 演练必须创建独立临时目录，只向其 `migrations/` 复制 979–988 的 20 个 up/down 文件，确认文件清单、目标为专用 `_test` 数据库且工作负载已停止后，在该临时工作目录调用相同迁移器 `down` 和 `up`。通过该进程的环境变量显式设置 `DATABASE_URL="$TEST_DATABASE_URL"`，不得读取应用或生产配置。中途失败就保留日志并停止，不继续运行应用；恢复时仍以整批边界处理。

回退演练与业务回归分开记录。前向迁移成功、代码编译通过或本地目录测试，均不代表整批 down/up 已验证；实际执行及恢复至 988 的证据以 agent 3 验证日志为准。

本批实际完成 agent 3 整组回退/恢复演练，已恢复至 988，索引/主键/守卫与原有迁移账本核对通过；记录见[验收汇总](./implementation/agent3-actions-validation.json)。
