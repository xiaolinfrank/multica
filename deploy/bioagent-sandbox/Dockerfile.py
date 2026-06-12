# BayClaw bioinformatics sandbox — Python scientific stack.
# Built once on the platform host; agents never run inside it. They copy a task
# workdir in with `docker cp`, run `python` / NGS CLIs, and copy results back
# out (see the bayclaw-bioinformatics-sandbox skill). No host bind-mount.
#
# Like the R image, the install is batched and decompression is serialised so
# the solve/extract stays within the build VM's RAM.
FROM mambaorg/micromamba:1.5.10

# TUNA mirror — direct anaconda.org downloads time out from the CN network.
USER root
RUN printf 'channels:\n  - conda-forge\n  - bioconda\nchannel_alias: https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud\ndefault_channels:\n  - https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main\n  - https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/r\nshow_channel_urls: true\n' > /etc/condarc
USER $MAMBA_USER

ENV MAMBA_EXTRACT_THREADS=1

# Batch 1 — core scientific Python.
RUN micromamba install -y -n base -c conda-forge -c bioconda \
        python>=3.11 pandas numpy scipy scikit-learn statsmodels \
        matplotlib seaborn lifelines openpyxl \
    && micromamba clean --all --yes
# Batch 2 — single-cell + bulk DE.
RUN micromamba install -y -n base -c conda-forge -c bioconda \
        scanpy anndata leidenalg python-igraph pydeseq2 \
    && micromamba clean --all --yes
# Batch 3 — NGS command-line tools.
RUN micromamba install -y -n base -c conda-forge -c bioconda \
        samtools bcftools seqkit fastqc multiqc \
    && micromamba clean --all --yes

ENV PATH=/opt/conda/bin:$PATH
WORKDIR /work
LABEL org.bayclaw.sandbox="py" \
      org.bayclaw.stack="scanpy,anndata,pydeseq2,lifelines,samtools,bcftools,fastqc"
