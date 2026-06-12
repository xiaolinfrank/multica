# 排期:重型技能与镜像

本套件优先接入**轻依赖、可在现有两镜像内跑通**的技能。以下需要超重型环境或大型参考数据,暂不接入,按需求和资源排期。每项注明为何暂缓与接入前提。

## 暂缓:超重型计算 / GPU

| 能力 | 来源 | 暂缓原因 | 接入前提 |
|---|---|---|---|
| AlphaFold2 / ColabFold 结构预测 | life-sciences、scientific | 需 GPU + 数十 GB 序列数据库(BFD/UniRef),单次运行数小时 | 配备 GPU 节点 + 专用镜像 `bayclaw/struct:af2`,任务异步化 |
| scvi-tools 深度单细胞模型 | life-sciences | 需 GPU/torch,大数据集才划算 | GPU 节点 + `bayclaw/bio-gpu:scvi` 镜像;小数据集先用 scanpy 路线 |
| ESM / 蛋白语言模型、DiffDock 对接 | K-Dense | GPU + 大模型权重 | GPU 镜像;先用 RCSB-PDB/UniProt 检索类工具替代 |
| deepchem / torchdrug 分子 ML | K-Dense | GPU + GNN | GPU 镜像;先用 rdkit/ChEMBL 做规则与检索 |

## 暂缓:大型参考库 / 上游比对

| 能力 | 暂缓原因 | 接入前提 |
|---|---|---|
| STAR / HISAT2 全基因组比对(FASTQ→BAM) | 需物种参考基因组 + 索引(人类约 30GB),磁盘与内存开销大 | 独立镜像 `bayclaw/ngs:align` + 参考数据卷;当前 demo 环境(30GB 磁盘/4GB 内存)不足 |
| nf-core/nextflow 完整流水线 | 需 Nextflow + 25GB+ 存储,拉取多容器 | 专用执行节点 + 存储卷;skill 已在 life-sciences 中,按需单独接入 |
| GATK4 变异检测最佳实践 | 需参考基因组 + known-sites VCF | `bayclaw/ngs:gatk` + 参考数据卷 |
| cellranger(10x 上游) | 闭源、授权 + 大参考 | 10x 授权 + 专用镜像 |
| 预装数据库类 skill(STRING/miRDB/starbase PPI/ceRNA 网络) | aipoch 仓库中这些 skill 自带百 MB 级数据 | 接入时单独拉取数据卷,不进通用镜像 |

## 已接入但受当前镜像约束

- `bulk-rnaseq` 全链:上游比对部分需 `bayclaw/ngs:align`(暂缺),**下游差异表达/富集/可视化**在 `bayclaw/bioinformatics:r` 内完整可跑——这是最常见的分析入口。
- `single-cell-rna-qc` / `scanpy`:QC 与标准聚类在 `bayclaw/bioinformatics:py` 内可跑;大规模(>10万细胞)或需 scVI 集成时再上 GPU 镜像。

## 扩镜像的标准做法

新增一类重型能力时,**新建独立 tag**(如 `bayclaw/ngs:align`),不要往通用镜像里堆——通用镜像保持可快速构建、可全宿主机分发。在对应 skill 的 SKILL.md 里写明所需镜像 tag 与参考数据卷挂载方式,沙箱桥技能的"何时用容器"表里补一行即可。
