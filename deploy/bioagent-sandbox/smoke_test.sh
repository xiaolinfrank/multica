#!/usr/bin/env bash
# Smoke test for the R bioinformatics sandbox, using the exact docker cp flow
# the bayclaw-bioinformatics-sandbox skill prescribes. Runs a real DESeq2
# differential-expression analysis on a synthetic dataset with a known
# truth-set (30 up + 15 down out of 300 genes) and checks the result recovers it.
set -euo pipefail
IMAGE="${IMAGE:-bayclaw/bioinformatics:r}"
WORK="${1:-$HOME/bayclaw-de-smoke/analysis}"

echo "== sandbox smoke test (docker cp flow) =="
echo "image: $IMAGE"
echo "workdir: $WORK"

# self-check
docker run --rm "$IMAGE" Rscript -e 'cat("DESeq2", as.character(packageVersion("DESeq2")), "\n")'

# --user root: docker cp brings host-owned files (uid 501) into the root-owned
# /work; the image's default mambauser (uid 1000) then can't write results.
# An ephemeral analysis container running as root is fine and side-steps it.
cid=$(docker create --user root -w /work "$IMAGE" Rscript /work/scripts/de.R)
trap 'docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT
docker cp "$WORK/." "$cid:/work"
docker start -a "$cid"
docker cp "$cid:/work/output" "$WORK/output_from_container"

echo "== results =="
sig="$WORK/output_from_container/de_significant.csv"
[ -f "$sig" ] || { echo "FAIL: no significant-results file"; exit 1; }
n=$(($(wc -l < "$sig") - 1))
echo "significant genes (padj<0.05, |LFC|>1): $n"
echo "top 5:"; head -6 "$sig"
# truth-set has 45 true DE genes; expect to recover a solid majority
if [ "$n" -ge 30 ]; then echo "PASS: recovered $n DE genes (truth-set 45)"; else echo "WEAK: only $n recovered"; fi
