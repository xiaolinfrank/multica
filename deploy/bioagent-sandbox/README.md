# BayClaw 生物医药智能体预设套件

复星医药大湾区虚拟员工平台(BayClaw)的预制生物医药团队,供新工作区**一键导入**。

## 套件内容

- **6 个智能体** + 1 个编队「生物医药情报组」(研究主管统筹,5 名专员协同):
  - 文献调研员 · 临床试验分析师 · 靶点与药物研究员 · 法规事务专员 · 生信数据分析师 · 研究主管
- **22 个技能**,分四层:
  - *检索类*(自研,纯公开 API):PubMed / ClinicalTrials / ChEMBL / openFDA
  - *办公产出*(anthropics/skills):docx / xlsx / pptx / pdf
  - *临床与法规深度*(aipoch/medical-research-skills):临床队列方案设计、终点定义、Cox 回归、FAERS 药物警戒、Meta 分析方法、报告规范合规(CONSORT/STROBE/PRISMA)
  - *生信分析*(K-Dense、anthropics/life-sciences):bulk-rnaseq、pydeseq2、pathway-enrichment、scanpy、single-cell-rna-qc、scientific-visualization、rdkit
  - *容器沙箱桥*(自研):`bayclaw-bioinformatics-sandbox`
- **ToolUniverse MCP**:2000+ 科学工具(PubMed/ChEMBL/OpenTargets/FDA/UniProt/Ensembl/RCSB-PDB…),compact 模式按需发现,多为免费公开 API。挂在 5 个检索/研究类智能体上。
- **2 个生信容器镜像**:`bayclaw/bioinformatics:r`(DESeq2/edgeR/limma/clusterProfiler/survival/tidyverse)、`bayclaw/bioinformatics:py`(scanpy/anndata/pydeseq2/lifelines/samtools/bcftools/fastqc)。

## 执行架构:智能体在宿主机,重活投容器

智能体运行时(daemon)始终在**宿主机**,不进容器。宿主机只装基础工具。当某个分析需要 R/Bioconductor、scanpy 等重型环境时,智能体按 `bayclaw-bioinformatics-sandbox` 技能,把脚本和数据**投送进预制 Docker 容器**执行(`docker run -v` 挂载工作目录),再收回产物。这样:

- 算力集中在服务器,多租户共享同一套镜像;
- 智能体 runtime 不被容器化绑死,凭证不进容器;
- 环境可复现(镜像 tag + commands.sh 存档)。

超重型任务(AlphaFold、cellranger、全基因组比对、GPU 深度学习)暂不接入,见 `ROADMAP.md`。

## 一键导入

```bash
# 1) ToolUniverse MCP — 预装,让 agent 冷启动从分钟级降到 ~7 秒
uv tool install tooluniverse        # 暴露 tooluniverse-smcp-stdio 到 PATH

# 2) 构建两个生信镜像(每台宿主机一次性)
docker build -f Dockerfile.r -t bayclaw/bioinformatics:r .
docker build -f Dockerfile.py -t bayclaw/bioinformatics:py .

# 3) 把整套智能体 + 技能 + 编队导入目标工作区
API=http://127.0.0.1:18080 \
JWT=<目标工作区 owner 的 token> \
WS=<目标工作区 uuid> \
python3 import_preset.py
```

> **前置**:`uv tool install tooluniverse` 必须在运行 runner daemon 的机器上执行,且 `~/.local/bin` 在 daemon 的 PATH 上(launchd plist 已配)。没装的话,挂了 tooluniverse 的 5 个研究类 agent 启动时找不到 `tooluniverse-smcp-stdio` 命令。
>
> **产出文件**:生信类任务产出的图表/表格,agent 会用 `multica attachment upload <file> --issue <id>` 上传成 issue 附件(平台 CLI 自带该命令),用户在 issue 文件区可见。

导入脚本幂等:按名称复用已存在的技能/智能体,重复运行只补齐缺失项。未指定 `RUNTIME_ID` 时自动选取该工作区的一个 public runtime(BayClaw 的 SHARED_RUNNER 机制会为新工作区自动配给)。

## 文件

| 文件 | 作用 |
|---|---|
| `preset.json` | 自包含预设包(技能内容内联 + 智能体指令 + MCP 配置 + 编队结构)。 |
| `import_preset.py` | 读 `preset.json`,经 API 在目标工作区重建整套配置。 |
| `gen_preset.py` | 从一个已配置好的源工作区导出 `preset.json`(维护套件时用)。 |
| `Dockerfile.r` / `env-r.yaml` | R/Bioconductor 生信镜像。 |
| `Dockerfile.py` / `env-py.yaml` | Python 科学计算 + NGS 镜像。 |
| `SKILL.md` | 容器沙箱桥技能源文档(已注入预设)。 |
| `ROADMAP.md` | 重型/暂缓技能与镜像的排期。 |
