#!/usr/bin/env bash
# Proves prune-next-prev.sh keeps the newest backup, never touches .next, and
# honors --keep/--dry-run. The script deletes multi-GB directories on a shared
# checkout, so its selection logic gets a test rather than a manual check.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prune="$script_dir/prune-next-prev.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

out="$scratch/out"
fail() {
  echo "FAIL: $*" >&2
  echo "Observed:" >&2
  cat "$out" >&2
  exit 1
}

# mkfixture <dir> — a web dir with a live .next and three backups whose mtimes
# ascend old -> middle -> new.
mkfixture() {
  local web="$1/web"
  mkdir -p "$web/.next" "$web/.next.prev-old" "$web/.next.prev-middle" "$web/.next.prev-new"
  echo live >"$web/.next/BUILD_ID"
  head -c 2048 /dev/zero >"$web/.next.prev-old/pack"
  head -c 4096 /dev/zero >"$web/.next.prev-middle/pack"
  head -c 8192 /dev/zero >"$web/.next.prev-new/pack"
  touch -t 202601010101 "$web/.next.prev-old"
  touch -t 202601020101 "$web/.next.prev-middle"
  touch -t 202601030101 "$web/.next.prev-new"
}

case_keeps_newest() {
  local web="$scratch/keep-newest"
  mkfixture "$web"
  bash "$prune" "$web/web" >"$out" 2>&1 || fail "default run exited non-zero"
  [ -d "$web/web/.next" ] || fail "live .next was removed"
  [ -d "$web/web/.next.prev-new" ] || fail "newest backup was not kept"
  [ ! -e "$web/web/.next.prev-old" ] || fail "oldest backup survived"
  [ ! -e "$web/web/.next.prev-middle" ] || fail "middle backup survived"
  grep -Fq "keep: .next.prev-new" "$out" || fail "did not report the kept backup"
}

case_dry_run_deletes_nothing() {
  local web="$scratch/dry-run"
  mkfixture "$web"
  bash "$prune" --dry-run "$web/web" >"$out" 2>&1 || fail "dry run exited non-zero"
  [ -d "$web/web/.next.prev-old" ] || fail "dry run deleted a backup"
  [ -d "$web/web/.next.prev-middle" ] || fail "dry run deleted a backup"
  grep -Fq "would delete: .next.prev-old" "$out" || fail "dry run did not name .next.prev-old"
}

case_keep_two() {
  local web="$scratch/keep-two"
  mkfixture "$web"
  bash "$prune" --keep 2 "$web/web" >"$out" 2>&1 || fail "--keep 2 exited non-zero"
  [ -d "$web/web/.next.prev-new" ] || fail "--keep 2 dropped the newest"
  [ -d "$web/web/.next.prev-middle" ] || fail "--keep 2 dropped the second newest"
  [ ! -e "$web/web/.next.prev-old" ] || fail "--keep 2 kept the oldest"
}

case_nothing_to_do() {
  local web="$scratch/none"
  mkdir -p "$web/web/.next"
  bash "$prune" "$web/web" >"$out" 2>&1 || fail "empty run exited non-zero"
  grep -Fq "no .next.prev* backups" "$out" || fail "did not report an empty result"
}

case_rejects_bad_keep() {
  local web="$scratch/bad-keep"
  mkfixture "$web"
  if bash "$prune" --keep many "$web/web" >"$out" 2>&1; then
    fail "--keep many was accepted"
  fi
  [ -d "$web/web/.next.prev-old" ] || fail "rejected run deleted a backup"
}

case_keeps_newest
case_dry_run_deletes_nothing
case_keep_two
case_nothing_to_do
case_rejects_bad_keep

echo "PASS: prune-next-prev.sh"
