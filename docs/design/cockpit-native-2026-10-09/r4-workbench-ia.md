# R4：会议工作台信息架构重组（阶段即导航）

状态：**统一导航版已实现**。第一刀的「阶段条 + 平行 tabs」两层级设计被用户否决（点击阶段无反馈、映射隐式、两个层级难以理解），本版把两者合并：**阶段分段控件就是 tabs**，点阶段=切工作面，一套导航。依据 [proposal §9.3](./proposal.md)、[ui-ux-design S05–S09](./ui-ux-design.md)、[设计总纲原则 3](./design-principles-2026-10-12.md)。

## 统一模型

```text
会议标题  状态徽标 · 时间          [主动作：随阶段变化]  … 删除 关闭
┌──────────────────────────────────────────────────────────┐
│ (1 准备✓) (2 会议记录) (3 纪要确认) (4 行动跟进)  资料 信息 │ ← 唯一导航
├──────────────────────────────────────────────────────────┤
│ 阶段工作面                                                │
│  准备/会议记录 → 议题与发生事实（发生事实区随状态变形）      │
│  纪要确认/行动跟进 → 纪要任务、版本、行动、发布             │
│  资料 → 关联任务/L3、材料、输入、NAS 目录                   │
│  信息 → 会议属性编辑、联系人、折叠的历史记录                 │
└──────────────────────────────────────────────────────────┘
```

- **一套层级**：阶段分段=tab。点阶段切换下方工作面，反馈即时（同屏变化 + 分段高亮）。
- **选中态 vs 完成态分离**：分段高亮=正在查看的面；序号圆圈变 ✓=业务事实已越过该阶段（ended 后准备/记录打勾）。回看早期阶段是查看历史，不改状态（S05「回看不改变已结束事实」）。
- **阶段投影不变**（原则 3）：当前业务阶段由 occurrence 状态 + 发布指针实时投影；打开会议无显式 view 时自动落位当前阶段。
- **主动作在标题行**（proposal 原型「[主要下一步]」位置）：准备=检查材料、会议记录=结束会议（实心）、纪要确认=纪要任务、行动跟进=未完成行动。
- **辅助内容降级**：「资料」「信息」两个小段靠右，不再是平级 tab；词汇全部用户语言（无「工作流」）。

## URL 与兼容

- `CockpitMeetingView` 扩展为 `preparation | recording | minutes_review | followup | resources | details`。
- 旧 URL 拼法 `meeting_view=agenda` → `preparation`、`=workflow` → `minutes_review`（读侧归一，收藏链接不失效）。
- 发生事实徽标链接不再携带 view——打开会议按阶段落位（「打开就看到现在该做的事」）。
- 议题路径保持当前阶段视图（在记录中打开议题不把用户扔回准备）。

## 实现清单

- `meeting-stage.ts`：阶段投影 + `meetingStageDefaultView` + 完成序 `meetingStagesBefore`。
- `cockpit-meeting-stage.tsx`：`CockpitMeetingStageTabs`（分段 trigger：序号/✓ 圆圈、primary 选中态）+ `CockpitMeetingStageAction`（标题行主动作）。
- `cockpit-meeting-panel.tsx`：TabsList 替换为阶段分段+辅助段；6 个 TabsContent（准备/记录懒挂载各自的 Agenda 实例；纪要确认/行动跟进各自的 Workflow 实例）；主动作入 header。
- `navigation.ts`：view 类型扩展、旧值归一、写点更新。
- 写侧链接 6 处更新（卡片徽标、处置映射、取消项、议程、输入检查器、面板 href）。

## 第二刀（待做）

- S07 三栏布局：议题列表 / 当前议题（目标、材料、记录）/ 相关（L3、任务、已有决议）；「会议记录」视图与「准备」的可见差异深化（记录模式）
- 全幅工作台入口（避免窄侧栏内再开窄抽屉）
- S06 准备区主动作「查看缺口」/「进入会议工作台」随材料齐备切换

## 验收（agent 3，2026-10-13）

- 本机：投影函数 5/5；navigation 19/19；lifecycle/agenda/issue-links/preparation-request/cards/meetings 定向全绿（「names the meeting」为基线预存在）；views 全量单 worker 18 失败 = 基线逐一对账一致；typecheck 干净。core 全量失败 5 个 = 基线一致；service 仅既证 collation；handler `TestCockpit*` 全绿。
- agent 3 双包 `TestCockpit*` 全绿（C collation）；浏览器全场景：
  - 未排期会议无 view 打开 → 落「准备」+ 主动作「检查材料」（标题行）；
  - 点「纪要确认」→ URL `minutes_review` + 分段高亮 + 工作面即时切换；
  - ended 会议无 view 打开 → 落「纪要确认」+ 纪要工作面（纪要任务/就绪与执行），已完成阶段（准备/会议记录）序号变 ✓；
  - 未配置纪要的会议在纪要视图 → setup 引导（评审人/新建纪要任务/启用），不再显示加载失败。
- 过程中修复两个被暴露的服务端缺口（`b1a25eac3` + `3661bf59c`）：
  1. lifecycle 命令 bump minutes_revision 只是缓存戳，不能作为「纪要已配置」的证据（此前 `Revision > 1` 判定让任何动过生命周期的会议 enabled=true、又因无纪要任务被客户端校验拒绝，显示「无法加载」）；配置证据改为 `minutes_configured_by` 或任一指针。
  2. 未配置会议的 summary 早退分支 nil slice 序列化成 `null` 数组，客户端 schema 拒收；改为显式空数组。
- 截图：[统一导航·准备态](./implementation/r4-unified-preparation.png)、[统一导航·已结束](./implementation/r4-unified-ended.png)。
## 收敛（R4 collapse，2026-10-13 用户三问后）

用户问：三个确认（安排/开始/结束）是否各有必要？是否值得维护成本？回答收敛为一确认：

| 确认 | 判定 | 依据 |
| --- | --- | --- |
| 确认结束（end） | **保留**，唯一强确认 | 纪要结论的事实门槛；R2/R3 已驯服为可逆 |
| 确认开始（start） | **删除**（迁移 9149） | 无人会前点按钮；in_progress 无消费者；「进行中」= 时间窗投影（meet_date/start_time/end_time 实时算，原则 3）；unstart 随之失去对象一并删除 |
| 确认安排（schedule） | **收窄** | 人工创建即 scheduled（列默认值+导入路径钉死）；仅 NAS 扫描行保持 unconfirmed 待人工核对，schedule/unschedule 服务该路径 |

- 新建即已安排：创建动作本身就是安排确认（创建可逆=删除/取消）。
- 实际时间一律走 correct_times（前置放宽到 scheduled）；实际结束仍以确认结束为前提。
- 快照恢复的会议落 scheduled（快照从不携带发生事实），detected 布尔继续管文件夹猜测核对。
- **线性流程**：创建（已安排）→ 开会（可补记实际时间）→ 确认结束 → 纪要 → 行动。整个生命周期一个对话框。
- **视图差异化**：recording 视图的发生事实区 emphasized（primary 边框+底色+全宽结束按钮）——「你在会中」由表面自己说，不靠存储状态。

验收（agent 3，2026-10-13）：双包 TestCockpit\* 全绿（迁移 9149 后）；API 创建即 scheduled（can_schedule=false/can_end=true）；时间窗内会议自动落「会议记录」阶段且发生事实区 emphasized、准备段 ✓；unconfirmed（扫描语义）会议显示「确认会议安排+确认会议已结束」、无开始/更正开始按钮；测试会议已清理。本机：views 单 worker 全量 18 失败=基线；core 5=基线。
