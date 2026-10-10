# 驾驶舱读取规模验收

这是显式开启的测量，不属于默认测试，也不是生产容量承诺。运行地点只允许 agent 3，使用隔离验证 profile 中的 `TEST_DATABASE_URL`，由唯一验证执行者串行执行；不得连接常驻应用数据库或 NAS。

`server/internal/service/cockpit_read_scale_test.go` 使用 `cockpitscale` 构建标签，运行时还须 `MULTICA_RUN_COCKPIT_SCALE=1`。本机只编译：

```sh
cd server
go test -c -race -tags cockpitscale -o /tmp/multica-cockpit-read-scale.test ./internal/service
```

在 agent 3 验证现有 profile 和数据库后，导出 `DATABASE_URL="$TEST_DATABASE_URL"`，沿用 `scripts/go-test-with-agent-cli-guard.sh` 运行该二进制，指定 `-test.run '^TestCockpitReadScale$' -test.parallel=1 -test.count=1 -test.timeout=30m -test.v`。可用 `MULTICA_COCKPIT_SCALE_REPORT` 指定专属日志目录中的 JSON 报告路径。

用例通过 testutil 创建独立用户、工作区及清理注册，构造 30 个项目、300 个模块、3000 个执行叶子、100000 条任务与主归属、20000 场会议。每场会议同时引用执行叶子及模块，共 40000 条会议关联，用于检验祖先聚合去重。任务和会议正文仅为合成数据，不创建任务运行、真实 Agent、附件或 NAS 文件。

这批会议未启用工作包，任务全部分派给测试人类成员；它测的是大量执行事实和会议元信息，不代表已经验证两万条活跃纪要评审流程。正式工作包及版本历史的混合负载仍需单独增加夹具。

测量覆盖工作区上下文、完整计划与项目/模块范围计划、会议分页及搜索、可见行会议标记、工作区及项目首页。每类记录第一次读取和随后 20 次读取的 p50/p95、各次耗时及最大 JSON 字节数。第一次调用不是清空 PostgreSQL 或系统缓存后的冷启动；不会修改共享实例缓存或参数。计时包括服务读取与 JSON 编码，不包含网络、HTTP 和浏览器渲染。

夹具在批量任务写入后、主归属完整性检查前，以及全部建数完成后刷新相关测试表的统计信息。报告通过 `statistics_note` 明示该条件；不修改 JIT、work_mem 或计划缓存配置。没有此字段的早期报告仅依赖当时的自动统计，比较结果时需保留这一差异。

单次读取最多 25 秒；超时或断言失败会停止该场景的后续采样，报告记录失败并继续清理，不把缺失样本写成零延迟。`scripts/cockpit-read-explain.py` 只从指定源码快照生成只读 EXPLAIN SQL，不连接数据库；默认不执行 SELECT，显式 `--analyze` 才生成执行计划。采样期间不要并行执行 EXPLAIN ANALYZE；保留对应查询源码或二进制提取文本，避免把优化后的计划冒充基线。

同时验证真实总量、页大小、计划完整性、会议列表不包含完整正文、标记全部分页的去重和祖先聚合计数。清理后再次检查本租户的任务、会议、节点和关系已清空。验证失败不能改报达标；性能结果保留原始分布，后续据此决定优化。

200000 个成果版本尚未验证：成果数据表和持久服务仍待完成，不能以模拟数组或纯契约测试代替。该用例也不验证并发用户负载或生产存储持久性。

会议标记若在第 5 次左右出现明显跳变，保留完整 21 次样本，再用同规模独立诊断夹具比较 prepared statement 的 custom/generic 计划。脚本 `GetCockpitPlanMeetingMarkers --marker-rows-file rows.json --plan-mode custom|generic --analyze` 生成 `BEGIN READ ONLY` 内的 `SET LOCAL plan_cache_mode` 与 EXPLAIN；该设置只用于诊断连接，不影响应用或基准采样会话。`rows.json` 必须使用该夹具实际可见行的 UUID 和分组，不能替换成更小集合。后续优化仍需在默认 auto 策略下重新采完整分布。

需要同一夹具对照旧/新计划时，将两份受审查的查询源码快照分别放在专属证据目录的 `before.sql`、`after.sql`，并显式设置 `MULTICA_COCKPIT_SCALE_MARKER_EXPLAIN_DIR` 为该目录。用例在全部性能采样后、清理前运行四个独立只读诊断，输出 `before-custom.json`、`before-generic.json`、`after-custom.json`、`after-generic.json`。每条最多 25 秒；诊断失败如实使测试失败，仍执行清理。此可选阶段不计入前述 p50/p95，也不改变默认采样的 auto 计划策略。

## 2026-10-10 验证结果

运行于 agent 3 的隔离 `multica_test`（schema 991），常驻 API/Web 和
`multica_dev` 未变更。完整 v5 读取与分页正确性通过，但会议标记从前四次约
60 毫秒跳到约 8 秒，不能据测试退出码称性能通过。随后仅针对标记运行 v6：
仍构造全部 10 万任务、2 万会议及 4 万关联，连续采样 21 次，验证 700 组
标记的全部分页，再于同一夹具执行四份只读计划诊断。

最终结果由 **v5 的其他九类读取与 v6 的标记读取**组成，不是一次完整 v6
全场景测量。标记首次 80.300 毫秒，后续 p50 94.591、p95 99.037 毫秒，
最大 JSON 116025 字节。相同夹具的 generic 诊断执行从 12714.472 降至
84.042 毫秒：原预览 WindowAgg/聚合重复 501 次，显式物化预览后聚合一次；
已有预览结果仍会被扫描，不能概括成所有节点都只执行一次。

完整计划、会议列表、搜索及首页的最终 p95 分别读取报告中的真实范围；
工作区完整计划仍约 3.2 MB，不能将其称为分页小载荷。两轮均明确刷新测试
表统计，未修改应用的计划缓存设置。诊断使用独立只读事务的局部设置，位于
所有计时样本之后。

原始测量和精简计划证据：

- [v5 全场景样本](../design/cockpit-native-2026-10-09/implementation/agent3-read-scale-v5.json)
- [v6 标记专项样本](../design/cockpit-native-2026-10-09/implementation/agent3-read-scale-v6.json)
- [验证范围、计划关键节点与清理记录](../design/cockpit-native-2026-10-09/implementation/agent3-read-scale-validation.json)

规模夹具正常清理。最终复查另发现两次旧模块隔离回归留下四个孤儿节点，已
核对具体 UUID、缺失工作区与引用后仅在隔离库精准删除；该旧夹具清理顺序
已修正，并定向复跑该父测试及核零。最终工作区、任务、节点、会议及上述关联数均为零。没有为本轮
测量连接真实 NAS、运行真实 Agent 或更新常驻实例。
