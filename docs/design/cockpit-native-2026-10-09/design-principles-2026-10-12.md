# 设计总纲：关联即属性、确认可逆、投影而非状态机（2026-10-12）

状态：**已由用户（系统初始设计者）确认，为最高优先级设计准则**，凌驾于本目录所有实现合同之上。任何新契约、新命令、新界面先过这三条。触发背景与完整证据见[评审记录](./review-2026-10-12.md)。

## 三条原则

### 原则 1：关联即属性

任务与会议、会议与议题、议题与 L3、任务与输入清单、成果与 L3——**一切实体间绑定只是关联 + 角色标注，语义等同 Issue 的指派人和标签**：

- 随时建立、随时解除、随时改角色；**允许多条**（一场会议可以绑定多个纪要任务；一个 L3 可被多场会议讨论）。
- 解除绑定不删除对方、不级联、不阻断对方生命周期；被绑定的任务被智能体自动领用并执行**不影响绑定的可解除性**——任务是普通任务，停运行/改派/关闭走平台既有能力。
- 唯一性约束只允许「当前/默认指针」级别（如「当前纪要焦点任务」），不允许排他绑定。
- 实体删除只清理自己的关联行（应用层，无外键规则不变），对方保留。

### 原则 2：确认可逆（原则 1 在结论层的推论）

**每一次确认动作的结果只是数据库中的状态或值，可随时再修改**——与平台「Issue 属性随时可改」同构。确认命令的三层语义：

| 层 | 可变性 | 例 |
| --- | --- | --- |
| 内容层（content_hash 固定字节） | 不可变（唯一豁免） | 版本正文、上传文件、验收条件快照 |
| 事件层（命令回执、操作历史、替代关系） | 只追加 | 「张三于 10-12 批准了 v3」永久可查 |
| 结论层（状态机位置、current/published/approved 指针、处置、齐备布尔） | **全部可再决策，且必须双向** | 当前发布版本、验收结论、处置选择、材料齐备 |

- 双向 = 不止「被更新值取代」（前移），还要有「回到未确认态」（回退/置空）。
- 逆向命令与正向同级：同一幂等协议、同一命令台账、强制原因与前后值（correct_times 已是范本）。
- 副作用纪律：逆向默认**保留**已创建的用户对象（Issue/目录/NAS 文件），只解绑指针或移回值；绝不静默删除。
- 例外白名单：物理删除（已有 tombstone + 归档引导兜底）。真实 Agent 运行的启动**不属于**例外——「agent 已在跑」不是锁死理由。

### 原则 3：投影而非状态机（原则 1 在读取层的推论）

派生状态从关联与属性**实时投影**，不维护第二份状态机字段：

- 「纪要进行中」= 存在活跃的纪要任务绑定；绑定点掉，投影自然回落。不存在 released_at/enabled 这类固化字段。
- 事实类字段（occurrence_state、ended_at、cancelled_at）属于结论层，按原则 2 双向可改并留痕；它们与投影的区别：事实是人确认的结论，投影是系统从关系算出的读数。

## 约束 7（并入 proposal §4.5，与其他六条同级）

每个改变结论层的确认命令，实现前必须声明其**再决策路径**，且路径支持双向；每个建立实体绑定的命令，实现前必须声明**解除与替换路径**，且解除不产生级联或阻断。没有声明这两者的命令不得进入实现。

## 重构清单

| 切片 | 内容 | 取代的契约条款 |
| --- | --- | --- |
| **R1 工作包解散 + 纪要任务关联多条化** | 解散 cockpit_meeting_work_package：纪要任务回归 meeting_issues 关联表（role=minutes，允许多条）+ 会议加「当前纪要焦点」指针；评审人改为会议属性；released_at/enabled 字段废除（投影替代）；纪要版本链挂靠从工作包改挂会议（版本记录生产任务来源）；执行门禁从「release 永久放行」改为任务可改的就绪条件；工作包对会议删除的阻断解除 | work-package-contract 全文；meeting-lifecycle-contract §2/§3 中 release 冻结条款 |
| **R2 结论层双向命令** | reopen（会议结束更正，ended→in_progress，留原因，原确认留历史；不改满足取消条件的前置——取消仍限 scheduled/in_progress）；revise_resolution（行动处置改判，旧 resolution 进历史）；revoke_approval（L3 验收撤销通过，置 needs_reacceptance）；unpublish（纪要下线，published 指针置空，历史与 NAS 文件不动） | meeting-template-disposition-contract §4（ended 不可改）；meeting-actions-contract resolution 终态；artifact-acceptance-contract 验收 terminal；minutes-history-contract 发布单向 |
| **R3 单向棘轮夹死点** | in_progress 不能取消会议（放宽为允许取消，或补 unstart）；确认安排/确认开始的回退路径 | meeting-lifecycle-contract §5；cockpit_cancellation.go:108-111 |
| **R4 会议工作台信息架构重组** | 按 proposal §9.3 回归阶段驱动：全幅工作台 + 阶段条（准备→会议记录→纪要确认→行动跟进）+ 每阶段一个主动作 + 默认落位阶段感知；基本信息/联系人/历史折叠辅助区；「工作流」tab 更名「纪要」并降级 | ui-ux-design 中被偏离的 S05–S09 保留为依据；本清单取代现状 4-tab 结构 |
| **R5 呈现层止血 + 词汇治理** | disabled 必须伴随可读原因（统一组件）；capabilities 下发 reason 而非布尔；refetch/重试带 busy 态；恢复控件聚合为全局「未确认操作」；inspect 不关框；unnecessary 术语并词（纪要工作包→纪要流程、行动建议→行动项、正式成果→产出物、目录准备→会议文件夹）；受管根/材料分区/尝试记录/传输态机退到诊断层 | interaction-recovery-audit 的断点合同保留，呈现密度约束并入 |
| **R6 决议对象 + 语义补全** | 决议实体（生效/替代/废止区间，按原则 1/2 设计）；行动处置补「暂缓」；整轮评审结果摘要 | completion-plan「决议与治理：待实现」条目的实现依据 |

顺序：R1 → R2（与 R1 同批部署）→ R3 → R5（可与 R4 并行）→ R4 → R6。输入/成果域（N2）已合规，不动。

## 各契约文档的取代关系

| 文档 | 状态 |
| --- | --- |
| work-package-contract.md | **整份被 R1 取代**，保留作历史，头部已注记 |
| meeting-lifecycle-contract.md | §2/§3/§5 的 release 冻结与 end 终态被 R1/R2 取代，其余（correct_times、软移除、命令台账）保留且是范本 |
| meeting-template-disposition-contract.md | §4「ended 不可改成未举行」由 R2 的 reopen 修订（保留取消前置保护）；§5/§6 恢复矩阵保留 |
| meeting-actions-contract.md | resolution 终态被 R2 取代；幂等 creation_key 语义保留 |
| artifact-acceptance-contract.md / artifact-runtime-contract.md | 「已通过历史不改写」保留（事件层），「当前通过不可撤销」被 R2 取代；引用/版本指针语义保留（本就是范本） |
| minutes-history-contract.md | 发布指针「只能前移」被 R2 取代（加 unpublish）；「新提交不遮蔽正式版本」保留 |
| issue-execution-model.md | 「评审 Issue 完成≠通过」「发布是命令」保留；release 门禁描述随 R1 修订 |
| nas-input-backend/interaction-contract.md | **合规，不改**——按原则 2 的样板执行 |
| proposal.md / completion-plan.md | 正文已更新（约束 7 / 验收条目） |

## 验收补充（并入 completion-plan 验收表）

1. 每个确认命令的再决策路径可演示：确认 → 更改/撤销 → 状态回到目标值，命令台账含两次记录。
2. 每个绑定可演示：建立 → 解除 →（可选）重建，对方对象无损。
3. 核心流程复杂度预算：开一场会（含模板/准备/目录）≤ 15 步；会后纪要闭环 ≤ 8 步；任一工作面同屏主动作 ≤ 5 个；新名词进入 UI 需在词汇表登记且经必要度判定。
