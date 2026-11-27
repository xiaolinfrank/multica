#!/usr/bin/env bash
# Keep only the newest web build backups and delete the older ones.
#
# A deploy moves apps/web/.next aside to .next.prev* so the previous build stays
# rollbackable, and nothing ever removes those directories afterwards. Each one
# is 2-3 GB (webpack cache packs dominate), so they accumulate until the disk
# fills. This keeps the newest N and deletes the rest; it never touches the live
# .next directory.
#
# Usage: scripts/prune-next-prev.sh [--keep N] [--dry-run] [WEB_DIR]
# WEB_DIR defaults to <repo>/apps/web.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: prune-next-prev.sh [--keep N] [--dry-run] [WEB_DIR]

  --keep N    number of newest .next.prev* backups to keep (default: 1)
  --dry-run   report what would be deleted without deleting it
  WEB_DIR     directory holding .next (default: <repo>/apps/web)
EOF
}

keep=1
dry_run=0
web_dir=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep)
      keep="${2:?--keep needs a value}"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "prune-next-prev: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      web_dir="$1"
      shift
      ;;
  esac
done

case "$keep" in
  '' | *[!0-9]*)
    echo "prune-next-prev: --keep must be a non-negative integer" >&2
    exit 2
    ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
web_dir="${web_dir:-$repo_root/apps/web}"

if [ ! -d "$web_dir" ]; then
  echo "prune-next-prev: no such directory: $web_dir" >&2
  exit 2
fi

shopt -s nullglob
prev_dirs=()
for dir in "$web_dir"/.next.prev*; do
  [ -d "$dir" ] && prev_dirs+=("$dir")
done

if [ "${#prev_dirs[@]}" -eq 0 ]; then
  echo "prune-next-prev: no .next.prev* backups in $web_dir"
  exit 0
fi

# Newest first; ls -t breaks mtime ties by name so repeated runs are stable.
sorted=()
while IFS= read -r line; do
  sorted+=("$line")
done < <(ls -1dt "${prev_dirs[@]}")

index=0
reclaimed_kb=0
for dir in "${sorted[@]}"; do
  name="$(basename "$dir")"
  if [ "$index" -lt "$keep" ]; then
    echo "keep: $name"
    index=$((index + 1))
    continue
  fi
  size_kb="$(du -sk "$dir" | awk '{print $1}')"
  reclaimed_kb=$((reclaimed_kb + size_kb))
  if [ "$dry_run" -eq 1 ]; then
    echo "would delete: $name ($((size_kb / 1024)) MB)"
  else
    rm -rf "$dir"
    echo "deleted: $name ($((size_kb / 1024)) MB)"
  fi
  index=$((index + 1))
done

if [ "$dry_run" -eq 1 ]; then
  echo "prune-next-prev: would reclaim $((reclaimed_kb / 1024)) MB from $web_dir"
else
  echo "prune-next-prev: reclaimed $((reclaimed_kb / 1024)) MB from $web_dir"
fi
