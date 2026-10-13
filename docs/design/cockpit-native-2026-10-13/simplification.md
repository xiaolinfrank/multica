# 会议管理简化

2026-10-13 用户裁定；替代 R4 议题工作台以及此前准备模板、会议输入资料收集、会议固定成果关联和行动跟进的交互方案。三条总纲仍成立：关联即属性、确认可逆、投影而非状态机。

## 唯一主流程

**新建会议并建目录 → 准备 → 会议记录 → 纪要确认。**

| 入口 | 用户做什么 | 系统承载 |
| --- | --- | --- |
| 新建会议 | 填会议信息和目录归属 | 同时创建会议目录；目录位置不可用时明确阻止并保留重试，不再让用户勾选目录或纪要工作包 |
| 准备 | 新建材料准备任务，或关联已有任务、执行任务 | 普通 issue、会议关联与角色；材料默认放会议 NAS 目录，不另建资料收集系统 |
| 会议记录 | 新建或关联纪要任务；必要时确认会议结束 | 纪要智能体在纪要 issue 中处理本会议目录；会议发生事实仍可更正 |
| 纪要确认 | 阅读、确认纪要；导出行动项；逐项新建 issue | 固定纪要版本、结构化行动项、原子新建/复用任务处置；实际执行状态在 issue 中查看 |

三个阶段只是工作面的导航，不通过切 tab 修改业务事实。已发布纪要仍留在纪要确认，不增加第四个行动跟进阶段。

## 明确退出主流程

- 议题列表、议题编辑表单、议题资料与引用关系。
- 准备模板、模板配置、模板应用和相应 CLI 入口。
- 会议输入资料的上传、NAS 挑选、复用附件、关联资料四通道。
- 关联会议固定成果的选择器及会议侧引用端点。
- 全幅三栏议题工作台及 meeting_focus 导航。
- 新建会议时自动配置纪要工作包；纪要任务改在会议记录阶段打开。
- 单独的行动跟进阶段；后续进度回到关联 issue。

这是取消功能，不是换名、折叠后继续塞进同一主流程。

## 目录与任务

会议 NAS 目录是默认资料来源，沿用现有固定子目录格式。头部“打开会议目录”直接使用平台统一的本地路径打开组件；Web/桌面遵循原有 Finder/Explorer/复制路径行为。目录页只呈现当前目录；异常恢复、目录维护与历史是显式展开的维护区。

准备阶段的新增任务是普通 backlog issue，可选择人或智能体，默认带入会议目录和当前项目/模块。不新增第二份任务执行状态。创建成功但关联失败时，草稿保存已创建任务 ID，重试只补关联/角色，不重建 issue；创建回执丢失时先查已有任务，避免盲重试。

会议记录阶段提供“新建纪要任务”和“关联纪要任务”两个入口。已有会议归属直接复用，只有缺少归属时才补项目/模块。确认人默认当前用户，调整入口放评审设置；不是再填一套会议表单。

纪要确认默认看纪要与行动项。创建/关联纪要任务的配置不重复出现在该页。手动提交纪要、评审人设置、版本历史保留为明确入口，不要求用户填写与智能体产出重复的议题表单。

## 行动项

纪要智能体后续通过 CLI 将确认的行动项写入会议记录；**该 CLI 的新增写入能力不在本轮实现，也不宣称当前 UI 能从任意纪要文本自动提取行动项。**

本轮保留既有结构化行动项读写与出处约束。对待建任务的行动项，列表直接标注“新建任务”；点击后使用普通任务属性确认，新建/关联写入沿用幂等原子处置，不自动批量派发。

“导出行动项”导出当前正式纪要版本的 CSV（标题、说明、纪要出处、版本、执行任务、任务编号、负责人、期限、处置状态）。按游标读完整列表而不是只导出屏幕第一页；列表变化或回执异常时拒绝不完整导出，避免静默截断。单元格转义处理引号、换行及电子表格公式。

## 数据与共享边界

历史议题、模板、资料记录、固定版本、原始回执与 NAS 文件保留，不随主流程退出被删除。已有 9000 段迁移保持原样；9150 仅给两列历史 revision 增加默认值，无 DROP、DELETE、目录清理或文件操作。

取消、归档、目录恢复仍可从信息区维护；既有取消处置及历史不因模板删除而断开。历史引用保护仍保留，删除不抹掉历史证据。

任务页的输入清单、成果节点引用、智能体运行输入是共享功能，继续正常使用；它们不再在会议模块提供第二套收集表单。输入深链仍打开 input-only Inspector，不查询会议/议题来维持旧表单。

## 验证

## 第二轮收敛（同日追加裁定）

- 会议记录阶段不再承载确认结束环节；发生确认（排期/结束/更正/重开）移到下方事实区，随元信息一起读。
- 准备、会议记录两个阶段各只留一个动作按钮，且都直接使用平台既有新建任务对话框（`create-issue` modal + `on_created` 回调）：会议侧不再自写创建表单，随附的自研草稿恢复存储（meeting-issue-draft-store）删除。
- 纪要任务的创建 = 平台对话框创建 + 服务端 `enable(existing_issue_id)` 收养；确认人默认当前用户。材料准备任务创建后挂 preparation 角色。
- readiness/材料齐备/启动（release）仪式整体退出 UI；提交不再需要 released（服务端 canSubmit、SubmitCockpitMinutesVersion 与前端 actions 三处同步放开），release 端点保留兼容。
- 寄存器/总览的工作流阶段投影（cockpit_surface_read/cockpit_overview SQL）同步收敛：release_ready/restore_backlog/materials_needed 三个启动族阶段并入 minutes_needed，next_action 不再有 release_minutes；顺带补做了上一轮删查询未再生的 sqlc（14 个生成文件对账）。
- 目录与信息两个 tab 取消：目录字段、发生确认、维护角（准备台账/目录维护）全部并入下方事实区长区域；头部保留「打开会议目录」（LocalPathLink 直接交 OS）。
- 面板定形为三段：高亮阶段卡（准备→会议记录→纪要确认时间轴 + 所选阶段动作面）、已关联任务区（普通 issue 与执行任务）、事实区长区域。

## 同批：执行计划任务面板清理

对执行计划的工作项面板（cockpit-node-panel 一族）做了同样的三镜头审查（过渡设计/交互复杂度/UI 清晰度，39 条原始发现、逐条对抗核验，30 条属实）。本轮已落地：

- 删除零引用死组件 cockpit-issue-links（compact 模式随之一并清掉）与其 barrel 导出、测试。
- 结构行上的历史付款只读化：财务编辑面只属于执行任务，结构行只保留台账视图（对应测试改为只读契约）。
- 面板头部父级面包屑改报显示编号（此前报存储编号，合并重编号后会指错行）。
- 分支进度禁用态旁说明汇总规则；"当前进展"下说明甘特图取上方百分比。
- 会议面板补齐 Escape 关闭（与隔壁工作项面板同契约）。
- 引用工作区"新建任务"按钮不再静默消失：不可用时置灰并说明原因。
- 新建执行任务的编号获取失败提供重试，不再只有关闭一条路。
- 付款合计用 formatAmount；exec_status 更名"付款状态/Payment status"（原"预算执行状态"名不副实）；zh 未排期两处合一；zh 关联按钮与区标题同名消歧；zh "任务名称"改"执行任务名称"消歧。
- 清掉 10 个确认无引用的死 locale key（含 meetings.node_meetings_hint、issues.none）。

核验中发现的误报（未改）：tasks 模式表格并非死代码（甘特图 table 视图在用）；"会议列表截断 5 条"引用的是主检出旧代码，工作树中早已不存在；删除付款保留确认框（金钱记录，与可逆的取消关联不对称是合理的）。

留作后续决策（本轮不动）：存储编号目前仍是面板内可自由编辑的文本（服务端有一次性消耗账本，改号不可逆且影响归属判定）；面板 depth>=2 与 isCockpitExecNode 两套"执行任务"谓词并存；节点/会议/付款三套删除确认框未合并；cockpit-fields 编辑器三种提交协议（日期选择即提交等）；面板金钱字段未标万元单位。

## 验证

- 本机静态：core/views TypeScript；变更组件 ESLint；Go build/vet；git diff --check。
- 本机定向组件：创建会议/准备任务创建及恢复/纪要两工作面/行动项/阶段投影 58 项通过；纪要原有历史、评审与发布 31 项保留回归。
- agent 3（10.35.182.2，~/var/multica-dev）：9150 已在开发库及专用测试库应用；server/web 重启后双 200；定向后端 TestCockpit、cmd/server 路由回归、核心三阶段组件 315 项、语言包 213 项全部通过。仓库内新浏览器 E2E 用例已接入；本轮因 agent 3 未预装 Playwright 浏览器可执行文件而未运行（安装 `pnpm exec playwright install` 后可在 `~/var/multica-dev` 以 `PLAYWRIGHT_BASE_URL=http://127.0.0.1:13000 NEXT_PUBLIC_API_URL=http://127.0.0.1:18080 DATABASE_URL=.../multica_dev MULTICA_DEV_VERIFICATION_CODE=831204 pnpm exec playwright test e2e/cockpit-meeting-workflow.spec.ts` 复跑）。生产环境未动。

## 第三轮：multica-cockpit 对齐与驾驶舱聊天首页（2026-10-14）

### multica-cockpit CLI 与内置 skill

- 新增 `meeting issue|node list/link/unlink/roles`、`node next-code`、`change list/propose/preview/withdraw`。
  关系写入全部走 scoped append/单链 receipt（append 不替换未加载集合；roles 用 `response=compact` 单链回执并显式区分“未传=不清空”与 `--clear`）。
- `change` 只覆盖读取、提交与撤回；apply/reject 保持治理面板内的人工决定，与 RequireHumanActor 一致。
- skill `multica-cockpit` 与全部 references 对齐三阶段窗口、平台 Issue 复用、角色用途、无结束/就绪/发布门槛；新增 `references/meeting-tasks.md` 描述聊天首页、三阶段、范围上下文与普通 Issue 流。
- Mika 系统指令新增项目驾驶舱契约： cockpit 请求加载 multica-cockpit；普通字段读改可在聊天完成，多步准备/纪要写入 Issue；范围 ID 是上下文不是授权；存储编号≠显示行号；尊重正式人审与机器凭证边界。
- AGENTS.md 增加随舱维护规则：驾驶舱行为变更须同提交更新内置 skill/CLI/测试；聊天默认按 `system_key` 选择 Mika。
- 维护测试：`cmd_cockpit_skill_contract_test.go` 校验 skill 文档中的 `multica cockpit` 示例全部能解析到已注册命令（>=30 例），并钉住新命令存在、retired 模板/议题命令不可执行；service 测试钉住 Mika 收到 skill 与指令契约。

### 驾驶舱聊天座位首页

- 复用平台 `ChatPage`：抽出 `ChatPageSurface`（routeHref/defaultAgentSystemKey/defaultProjectId/title/conversationStarters/initialContext），原 `/chat` 路由零改动；驾驶舱 `CockpitChat` 以 `?project&module` 作为会话地址。
- 驾驶舱默认面变为聊天（无参数打开即聊天）；`tab=work` 保留总览；目录 tab 仍不存在。切换范围会新建 compose（不静默改已有会话）；同范围保留 `?session=`。
- 默认智能体按 `system_key="mika"` 选择（改名也命中；缺失/不可用时拒绝静默代发，`noAgent` 收紧为 activeAgent 为空即真）。
- 首条消息注入项目/模块范围上下文（`*` 表示全部，仅上下文非授权）；会话创建后项目上下文选择器继续可用。
- 浮窗与其快捷键在驾驶舱聊天整页抑制（其他驾驶舱页面不抑制）；会话 URL 始终留在驾驶舱作用域内。
- 新增 cockpit 专属开场建议（查看进展/调整计划/准备会议，四语）；隐藏“自定义开场”链接。
- 测试：entry/chat-page/controller/floating-visibility/navigation/saved-views 新增 13 例；存量 core 三处失效断言按当前投影缓存失效语义更新（surfaces/artifact predicates/issueContexts/cancelRefetch）。

### 构建环境

- agent 3 直接访问 Google Fonts 不稳定（Node fetch 失败、curl 成功）。用 curl 预取全部 5 组字体的真实 CSS 与 46 个 woff2，构建时以 `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` 注入（缓存位于 agent 3 `~/var/multica-dev-test/font-cache-20261014`，构建产物字节与线上一致，非降级字体）。
