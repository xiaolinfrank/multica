---
name: bayclaw-bioinformatics-sandbox
description: 在 BayClaw 宿主机上把需要重型生信环境(R/Bioconductor、scanpy、samtools 等)的分析任务投送进预制 Docker 容器执行。当某个分析技能要求 DESeq2/edgeR/clusterProfiler/scanpy/pydeseq2/survival 等无法在宿主机直接运行的依赖时,用本技能把脚本和数据挂载进容器跑,而不是把 agent 自己放进容器。
---

# BayClaw 生信容器沙箱

你(agent)运行在 BayClaw 平台**宿主机**上。宿主机只有基础工具,没有预装 R、Bioconductor、scanpy 等重型生信依赖。当一个分析任务需要这些环境时,**不要**尝试在宿主机 `pip install` / `R` 直接跑,而是把任务**投送进预制 Docker 容器**执行:你在容器外面准备脚本和数据、调用 `docker run` 把工作目录挂载进去、收回产物。容器是一次性的算力,你始终在外面编排。

## 何时用容器,何时直接跑

先判断任务依赖:

| 依赖 | 在哪跑 |
|---|---|
| 纯网络 API(PubMed/ChEMBL/ClinicalTrials/openFDA)、纯文本推理、markdown 产出 | **宿主机直接跑**,不需要容器 |
| 纯 Python 且 wheel 轻量(requests、pandas 小数据、rdkit) | 宿主机 `uvx` / `pip` 即可 |
| R / Bioconductor(DESeq2、edgeR、limma、clusterProfiler、survival、EnhancedVolcano) | **R 容器** `bayclaw/bioinformatics:r` |
| scanpy / anndata / pydeseq2 / lifelines / samtools / bcftools / fastqc / multiqc | **Py 容器** `bayclaw/bioinformatics:py` |
| 超重型(AlphaFold、cellranger、STAR + 全基因组比对、GPU 深度学习) | **暂不支持**,在评论中说明需要专用镜像并把任务标注为"需排期",不要硬跑 |

不确定某个 R 包在不在镜像里时,先探测(见下"自检"),不要假设。

## 镜像清单

平台已预制两个镜像(`docker images bayclaw/bioinformatics` 可见):

- `bayclaw/bioinformatics:r` —— R 4.3+,含 DESeq2 / edgeR / limma / clusterProfiler / org.Hs.eg.db / EnhancedVolcano / tximport / survival / survminer / tidyverse / data.table / pheatmap。用于差异表达、功能富集、生存分析、出版级绘图。
- `bayclaw/bioinformatics:py` —— Python 3.11+,含 scanpy / anndata / leidenalg / pydeseq2 / pandas / numpy / scipy / scikit-learn / statsmodels / matplotlib / seaborn / lifelines / samtools / bcftools / seqkit / fastqc / multiqc。用于单细胞、bulk DE(Python 路线)、NGS QC 与格式处理。

镜像入口已把 conda 环境放进 `PATH`,容器内可直接用 `Rscript`、`python`、`samtools` 等命令。

## 标准投送流程(用 docker cp,不要用 -v 挂载)

本平台的容器运行时**不把宿主机目录挂载进容器**(`docker run -v 宿主路径` 在这里看不到你的文件)。所以用 `docker cp` 把数据拷进一个容器、在里面跑、再把产物拷出来。固定四步:

```bash
# 1. 在工作目录里准备一个分析文件夹
mkdir -p analysis/{input,scripts,output}
#    把数据放进 input/,把分析脚本写进 scripts/(例如 scripts/de.R 读 input/counts.csv,结果写到 /work/output)

# 2. 创建一个容器(先不启动),指定要跑的命令
#    --user root:docker cp 进来的文件属主是宿主机用户,镜像默认用户写不了,
#    临时分析容器用 root 运行最省事,容器即删、无残留风险。
cid=$(docker create --user root -w /work bayclaw/bioinformatics:r Rscript /work/scripts/de.R)

# 3. 把整个 analysis/ 拷进容器的 /work,启动并等待,拿到日志
docker cp analysis/. "$cid:/work"
docker start -a "$cid"          # -a 把容器 stdout/stderr 接到你这里,看得到运行日志

# 4. 把产物拷回宿主机,然后删容器
docker cp "$cid:/work/output" analysis/output_from_container
docker rm "$cid" >/dev/null
ls analysis/output_from_container/
```

要点:

- **`docker create` + `docker cp` + `docker start -a` + `docker rm`** 是这里唯一可靠的投送方式;`-v` 挂载不要用。
- 脚本里一律用**容器内的绝对路径** `/work/...`(因为 `-w /work`),不要用宿主机路径。
- `docker start -a` 是阻塞的,容器跑完才返回,正好拿到完整日志判断成败。
- **不要**让容器长驻;**不要** `-it`;一个分析步骤一轮 create/cp/start/rm。
- **不要**把 API key、凭证拷进容器;容器只处理数据,联网检索类工作在宿主机做完再把结果喂进去。
- Python 容器同理:`docker create --user root -w /work bayclaw/bioinformatics:py python /work/scripts/analyze.py`,其余照旧。
- 需要装镜像里没有的额外包时,**不要**临时在容器里 `pip install`(容器即删,白装)。先评估:是不是该任务本就超出预制镜像范围、应当排期做专用镜像。

## 自检(开工前确认环境就绪)

```bash
# 镜像是否存在
docker images bayclaw/bioinformatics
# R 栈健康
docker run --rm bayclaw/bioinformatics:r Rscript -e 'library(DESeq2); packageVersion("DESeq2")'
# Py 栈健康
docker run --rm bayclaw/bioinformatics:py python -c 'import scanpy, pydeseq2; print(scanpy.__version__)'
```

如果 `docker` 命令不可用,或镜像不存在,**不要**继续硬跑——在 issue 评论里说明"容器沙箱不可用",并给出宿主机能完成的降级方案(例如改用纯 API 的分析路径),保持任务 `in_progress`。

## 汇报:结果内联进评论 + 把图表上传成附件

**用户只看得到你写在 issue 评论里的内容**,以及你显式上传到 issue 的附件。容器里产出的文件不会自动出现在网页上——你必须主动处理:

- **把所有决策相关的数字和表格直接写进评论**——显著基因数、上调/下调拆分、按 padj 排序的 top N 表格(基因名/log2FoldChange/padj)、关键统计量。这是用户最依赖的结果,务必完整。
- **把关键图表和结果文件上传成 issue 附件**,用 `multica attachment upload`(你的提示词开头给了「assigned issue ID」,用它做 `--issue`):

  ```bash
  multica attachment upload analysis/output_from_container/volcano_plot.png --issue <你的 issue ID> --output json
  ```

  命令的 JSON 输出里有一个 **`markdown`** 字段(例如 `![volcano_plot.png](/api/attachments/<id>/download)`)。**把这个 `markdown` 字段的值一字不差地复制进你的评论**,图片/文件就会在网页上正确显示并可下载。

  - **务必照抄命令返回的 `markdown` 值**;**绝对不要**自己拼 `attachment://文件名` 或写裸文件名——平台不认这种写法,会变成点不开的坏链接。
  - 图(png)照抄后内联显示;CSV/表格等照抄后显示成可点击下载的卡片。火山图、热图、MA 图、结果 CSV 都值得这样传。
  - 每传一个文件跑一次命令、抄一次它返回的 `markdown`。
- **不要谎称"已上传"**——只有你真的跑了 `multica attachment upload` 并拿到返回,才算上传成功;没传就别写"见附图"。
- 关键结论(效应量范围、有无离群样本/批次效应、数据质量判断)用文字写清楚。

## 可复现性

每次容器分析都生成并在 workdir 留存一份运行记录,便于任何人复核重跑:

- `analysis/output_from_container/commands.sh` —— 你实际跑的 `docker create/cp/start` 命令原文。
- `analysis/output_from_container/session.txt` —— `Rscript -e 'sessionInfo()'` 或 `pip freeze` 的关键版本。
- 在评论里标注镜像 tag(如 `bayclaw/bioinformatics:r`)与关键参数(物种、比对基因组、阈值),让结果可溯源。
