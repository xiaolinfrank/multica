# R1 实施合同：工作包解散与纪要任务关联多条化（2026-10-12）

依据[设计总纲](./design-principles-2026-10-12.md)原则 1/2/3，取代 [work-package-contract](./work-package-contract.md)（已注记）。本合同规定 R1 的目标模型与兼容边界；实现与验证记录进 implementation-status。

## 目标模型

1. **纪要任务绑定**：`cockpit_meeting_issue.roles` 数组含 `'minutes'` 即为纪要任务（多条允许；沿用 956 迁移的显式用途设计，不占用 role 单值列）。同一 issue 既有 provision 标记又有纪要用途时并存。
2. **会议属性**（`cockpit_meeting` 新列，全部可空或带默认，随确认命令双向可改）：
   - `minutes_reviewer_id`（评审人）
   - `minutes_focus_issue_id`（当前焦点纪要任务指针，可换可清）
   - `minutes_current_version_id` / `minutes_published_version_id`（版本指针）
   - `minutes_revision`（纪要流程乐观锁，默认 1）
   - `minutes_materials_ready` / `minutes_materials_confirmed_at` / `minutes_materials_confirmed_by`
3. **废除**：`cockpit_meeting_work_package` 整表、`released_at`/`release_task_id` 字段及其 guard 触发器。「已启动纪要任务」改为投影：焦点任务已离开 backlog（或存在任一 minutes 任务处于活跃态）。`guard_cockpit_meeting_end_fact` 保留，由 R2 处理。
4. **执行门禁**（原则 3 投影）：纪要任务在「会议未结束 **或** 材料未齐备」期间阻止自动执行（原 `released_at IS NULL` 的语义改为持续条件）；条件随属性变化实时生效，无一次性永久放行。人工推进任务状态不受此门禁限制。

## 命令映射

| 旧命令 | 新语义 |
| --- | --- |
| 启用工作包（选执行者/评审人/新建或接管 Issue） | 绑定纪要任务（关联行 roles+='minutes'）+ 设置焦点/评审人属性；可多次绑定不同任务，焦点可切换可清空 |
| （无） | 解绑纪要任务（roles-='minutes'；任务保留，普通 Issue 生命周期） |
| release（启动纪要任务） | 推进焦点任务 backlog→todo（普通状态推进+可选入队）；不写任何终态字段；就绪由门禁投影判断 |
| readiness（材料齐备） | 写 `minutes_materials_*` 会议属性（已有双向语义保留） |
| 提交/评审/发布版本 | 版本表不变（已挂 meeting）；current/published 指针写会议列，乐观锁 minutes_revision |

## API 兼容

`/api/cockpit/meetings/{id}/workflow*` 端点与响应形状保持：`enabled` 投影为「存在 minutes 绑定或任一纪要属性已设置」；`released` 投影为「焦点任务已离开 backlog」；旧客户端读写不破坏。桌面端 zod loose 透传。

## 迁移

`9144_cockpit_minutes_association.up.sql`（fork 9000-9999 段，单文件、无新并发索引）：
1. `cockpit_meeting` 加 8 列；
2. 工作包行数据搬入会议列（minutes_issue_id → focus 指针）；
3. 回填关联：已有 (meeting,issue) 行并入 `roles+='minutes'`，无行插入 `roles='{minutes}'`；
4. DROP release guard 触发器与函数、DROP TABLE `cockpit_meeting_work_package`。
数据搬迁在同事务内完成；无外键，无级联。

## 实施状态（2026-10-12）

**Server 侧已完成**（迁移 9144/9145/9146、SQL 14 文件、sqlc 重生成、service/handler 适配、执行门禁改持续投影、readiness 解除 release 后冻结、会议删除保护收窄为「存在已提交纪要版本」）：

- 迁移：9144（裸 DDL 8+1 列，sqlc 可见——BEGIN/COMMIT 块会被 sqlc 静默跳过，故 DDL 与数据搬迁拆两条）；9145（事务内数据搬迁+roles 回填+DROP TABLE+释放 guard 触发器，带多绑定回滚守卫的 best-effort down）；9146（执行门禁函数投影版：会议未结束或材料未确认期间，纪要任务对 agent 执行持续受限，无一次性永久放行）。
- 命令面：AttachCockpitMinutesIssueLink（ON CONFLICT 幂等并入 roles 数组）/DetachCockpitMinutesIssueLink（解绑）、SetCockpitMinutesSetup（焦点+评审人+首设 configured_by）、readiness/版本指针/revision 全部迁到会议列；Get/Lock/ForRead/Snapshot 统一别名列集，released 为投影（任务进入 todo/in_progress/in_review/blocked），ForRead 附 released_at（最近活跃时刻）与 release_task_id（最近任务）投影以兼容旧客户端响应。
- 语义变更：Enable 的接管/新建判定从 ErrNoRows 改为焦点指针 Valid；release 改为 CAS revision+推进任务（无终态字段）；「readiness 在 release 后冻结」按总纲解除（材料确认始终双向，门禁为持续投影）；无版本的会议可删除（清关联行）。

**验证**（协调机隔离库 multica_multica_cockpit_native_624，迁移 9100→9146 全部应用成功、9145 数据搬迁核验：表已删、roles 回填 2 行）：`go build ./...` 与 `go vet` 全绿；service/handler/migrate 的 `TestCockpit*` 定向组通过（handler 与 migrate 全绿；service 除 TestCockpitArtifactRuntimeReviewerHandoffKeepsAuthoritativeReverseContext——**已证明为测试库 collation 环境差异而非回归**：en_US.UTF-8(libc) 下 `artifact_version` 排序必然先于 `artifact:`，该测试所用 SQL/生成代码/测试文件本轮零改动，纯 SQL 复现于空库；需在 agent 3（C collation 或与历史验收一致的库）复验）。**未做**：全量 service/handler 测试（按环境约定应在 agent 3）、core/views 前端适配（R1b）、真实浏览器验收、生产部署。

**坑（后续注意）**：sqlc 静默跳过 BEGIN/COMMIT 块内语句（DDL 必须裸写或拆文件）；本机 `go test` 未设 DATABASE_URL 时默认连 `localhost:5432/multica`——**那是生产库**，必须显式设隔离库；测试库 collation 影响排序断言。
