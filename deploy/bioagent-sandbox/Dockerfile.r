# BayClaw bioinformatics sandbox — R / Bioconductor.
# Built once on the platform host; agents never run inside it. They copy a task
# workdir in with `docker cp`, run `Rscript`, and copy results back out (see the
# bayclaw-bioinformatics-sandbox skill). No host bind-mount is required.
#
# The install is SPLIT INTO BATCHES on purpose: solving + extracting all of
# Bioconductor at once exhausts the build VM's RAM (std::bad_alloc on a 4 GB
# VM). Smaller per-RUN solves keep peak memory bounded; MAMBA_EXTRACT_THREADS=1
# serialises decompression so it doesn't balloon either.
FROM mambaorg/micromamba:1.5.10

# TUNA mirror — direct anaconda.org downloads time out from the CN network.
USER root
RUN printf 'channels:\n  - conda-forge\n  - bioconda\nchannel_alias: https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud\ndefault_channels:\n  - https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main\n  - https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/r\nshow_channel_urls: true\n' > /etc/condarc
USER $MAMBA_USER

ENV MAMBA_EXTRACT_THREADS=1

# Batch 1 — R base + CRAN data/plotting (lighter solve).
RUN micromamba install -y -n base -c conda-forge -c bioconda \
        r-base>=4.3 r-data.table r-optparse r-pheatmap \
    && micromamba clean --all --yes
# Batch 2 — tidyverse (heavy CRAN tree, isolate it).
RUN micromamba install -y -n base -c conda-forge -c bioconda \
        r-tidyverse \
    && micromamba clean --all --yes
# Batch 3 — core differential-expression Bioconductor packages.
RUN micromamba install -y -n base -c conda-forge -c bioconda \
        bioconductor-deseq2 bioconductor-edger bioconductor-limma \
    && micromamba clean --all --yes
# Batch 4 — enrichment + annotation + survival + volcano.
RUN micromamba install -y -n base -c conda-forge -c bioconda \
        bioconductor-clusterprofiler bioconductor-org.hs.eg.db \
        bioconductor-enhancedvolcano bioconductor-tximport \
        r-survival r-survminer \
    && micromamba clean --all --yes

ENV PATH=/opt/conda/bin:$PATH
WORKDIR /work
LABEL org.bayclaw.sandbox="r" \
      org.bayclaw.stack="DESeq2,edgeR,limma,clusterProfiler,survival,survminer,tidyverse"
