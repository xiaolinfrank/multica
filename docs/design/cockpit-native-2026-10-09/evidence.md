# 现状证据与设计边界

日期：2026-10-09。来自当前工作区源码只读审计，不是生产数据盘点或性能测试。历史根计划记录含已过时的 Run 图谱设计；本提案以当前 L3 模型为准。

## 已核实的事实

| 事实 | 源码定位 | 设计影响 |
| --- | --- | --- |
| CockpitNode 使用 parent_id 树且没有 project_id/module_id | `packages/core/types/cockpit.ts` 的 CockpitNode | L1/L2 对应关系需明确身份，不能只靠显示名称 |
| 节点归档通过展示行号查找模块名称 | `packages/core/cockpit/node-filing.ts:7`、`:79` | 排序/改名不能再改变归属含义 |
| 会议 minutes/decisions/actions 为文本 | `packages/core/types/cockpit.ts:156` | 可保留原文，但需结构化版本/决议/行动建议驱动闭环 |
| 会议 Issue 角色仅 task 或空值 | `packages/core/types/cockpit.ts:199` | 需会前/纪要/行动/参考等类型，历史空值不可猜测 |
| 会议与节点已有关系表/数组 | `packages/core/types/cockpit.ts` 的 CockpitMeetingNodeLink / CockpitBoard | 复用多对多基础，不强制单父级会议 |
| 驾驶舱整板读取，包含节点/付款/里程碑/会议/关系 | `server/internal/service/builtin_skills/multica-cockpit/references/cockpit.md:12`；CockpitBoard 类型 | 可增量增加范围摘要和分区读取，保留原合同 |
| 会议 provision 分别报告 task/dir 成败，NAS 根未挂载须失败 | 同上参考文档 Meetings 段落 | 保留部分成功语义，增加持久恢复而非整包重跑 |
| 节点变更已有人工提案队列，支持 agent ingest | 同上参考文档 Pending changes 段落 | 沿用治理入口，强化冲突、来源版本和成组影响 |
| 已有持久唤醒和阶段协作 | `docs/engineering/issue-wakeups.md`；`server/internal/service/builtin_skills/multica-platform/references/issues.md:318`、`:421` | 新业务事件接既有执行体系，不新建 runtime |
| 当前驾驶舱视觉基于共享 theme token，保留 13px 密度与圆角 | `packages/ui/styles/cockpit.css:1` | 可以局部升级视觉，不必重建全局主题 |
| issue 中文规范为“任务”，agent task 产品用语为“运行” | `apps/docs/content/docs/developers/conventions.zh.mdx`；英文 conventions §2 | UI 不用同一个“执行任务”指 L3、Issue 和 Run |
| Module 必属一个项目；列表 project_id 可选只是查询范围可选 | `server/migrations/923_module.up.sql:19`；`server/internal/handler/module.go:193` | 保留已有 Project → Module 契约，核对节点映射，不新增“跨项目模块”概念 |
| 当前成果聚合按评论附件的文件名与 MIME 判断版本 | `packages/core/attachments/deliverables.ts:2`、`:32` | 原入口和附件历史要保留，升级稳定成果身份与可验收版本 |
| 会议表单为窄面板，后段文本框承载议程/纪要/决议/行动 | `packages/views/cockpit/components/cockpit-meeting-panel.tsx:140`、`:464` | 改为阶段性工作台，基础信息不占据协作首屏 |
| 会议创建分配给 Agent 后会立即启动 Run | `packages/views/cockpit/components/cockpit-meeting-create.tsx:601` | 建立任务与满足条件后启动必须分离 |
| Issue 详情同时挂载新旧会议区块，跳转不同 | `packages/views/issues/components/issue-detail.tsx:2895`、`:2963`；`packages/views/issues/components/cockpit-meetings-section.tsx:112`；`packages/views/issues/components/issue-linked-meetings.tsx:59` | 合并重复上下文，所有入口定位具体会议 |
| 页面有 node/meeting 深链，但 tabs/筛选多为本地状态 | `packages/views/cockpit/components/cockpit-page.tsx:227`、`:259`、`:598`；`packages/views/cockpit/components/cockpit-meetings.tsx:115` | 保留已完成深链，扩展可恢复视图状态 |
| 无 board 与 loading 共用骨架分支 | `packages/views/cockpit/components/cockpit-page.tsx:864` | 请求失败需要明确状态与恢复 |
| 导入/恢复删除原节点、会议、关系和变更，再新建节点 UUID | `server/internal/handler/cockpit.go:2361`、`:2415` | 基线与业务历史分离，改差异恢复 |
| provision 直接创建 Issue 再写关联，当前路径未见已有任务复用检查 | `server/internal/handler/cockpit_meeting.go:798`、`:1108`、`:1150` | 自动化之前建立幂等业务操作与部分失败恢复 |
| 事实事件事务性捕获，Autopilot 有 durable admission/worker | `server/internal/service/issue_wakeup.go:26`；`server/internal/service/builtin_skills/multica-platform/references/autopilots.md:8` | 接既有可靠执行设施，避免平行引擎 |

## 待实施前验证

- 实际节点映射是否与模块既有项目归属一致，是否存在因无外键而遗留的悬空引用；本轮未盘点业务数据。
- 重复 provision 的 Issue/link 行为需用隔离回归测试证实；当前判断是源码路径审计。
- 现有目录的主机挂载差异、NAS 版本能力、断线与权限语义需要环境验证。
- 全量渲染属于结构性规模风险，未测得实际慢请求/低帧率；提案性能数字是目标，不是当前基准。
- 抖音内容的访问结果与 GitHub 许可见独立参考记录；未下载到的内容不视为已观看。

## 本轮验证范围

### 第二轮设计深化

- 更新主图并增加 Issue 执行模型、NAS 协作空间、独立 UI/UX 专题；跨文档核对评审任务/正式结论、会签、版本与发布边界。
- 7 份设计文档的 54 个本地链接和源码行号边界检查通过；代码围栏、图片占位与尾部空白检查通过。
- 3 张 Mermaid 图在浏览器中的 Mermaid 解析和 SVG 渲染通过；已查看主架构图实际渲染。
- 10 张实际研究图片均通过浏览器解码，文档中的 20 处嵌入均有对应文件；合计 878,649 字节。图片有来源和时间点，没有生成冒充参考的图片。
- `git diff --check` 通过；新增未跟踪设计文件另由上述内容检查覆盖。
- 首轮交互预览本轮未修改。新 Review Issue、多席位评审、NAS 状态尚未纳入该示例原型，UI/UX 文档明确记录覆盖边界；未将文档验收清单当作已经实现的产品能力。

### 第一轮设计与原型

已完成：

- 四份文档的本地链接、源码路径、代码围栏与尾部空白检查；无错误。
- `git diff --check` 通过；设计文件为新增未跟踪文件，另用上述内容检查覆盖。原有根计划文件追加本轮记录，未覆盖历史。
- 独立交互预览的 Playwright 检查：1024px 浅色、320px 暗色；五个 tab、三个会议阶段、确认后状态、L3 详情、财务和产物预览均无横向溢出，JavaScript 运行错误为 0。
- 本地模拟主流程：评审纪要 → 复用/新建/不执行 → 确认预览 → 本地确认 → 首页同步；并验证草稿往返、范围冲突禁用确认、不同成果预览、不同 L3 落点与重置复演。主代理查看了总览和会议截图。
- 四个 MP4 的音视频流/时长及三张图像核验；最终文件清单含 SHA-256。未获取第 2 条需登录视频，不声称其内容已核验。

没有修改产品代码、执行迁移、启动真实 Agent、修改生产数据或部署。未运行应用代码测试，也未对真实业务权限、网络故障、多人并发或性能目标做验证；这些仍是提案中的未来实施验收项。概念预览仅有示例状态，不代表功能已经实现。
