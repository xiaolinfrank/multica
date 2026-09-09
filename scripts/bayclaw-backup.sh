#!/usr/bin/env bash
# bayclaw-backup.sh -- daily backup of Multica platform data to NAS.
#
# Layers:
#   L1 postgres/  -- per-database pg_dump (custom format), gzip'd
#   L2 uploads/   -- rsync mirror of LOCAL_UPLOAD_DIR attachments
#   L3 workspaces/-- rsync copy of agent workspaces (NAS v2/ -> backup dir),
#                   plus workspaces-attic/ for entries the source dropped
#   L4 config/    -- tar of .env, deploy/, launchd plists, ~/.multica creds
#   L5 redis/     -- RDB snapshot (session/PAT cache; clearing forces re-auth)
#
# Target: /Volumes/虚拟员工工作区/backup/multica
# Retention: PG dumps kept RETENTION_DAYS (default 30) plus monthly archive;
#            retired L3 entries kept RETENTION_DAYS in workspaces-attic/.
# Scheduling: launchd com.bayclaw.backup, daily 02:00 (see deploy/).
#
# Usage:
#   scripts/bayclaw-backup.sh              # run a real backup
#   scripts/bayclaw-backup.sh --dry-run    # print commands without executing
#   scripts/bayclaw-backup.sh --if-needed  # skip if today already succeeded
#   DRY=1 RETENTION_DAYS=7 scripts/bayclaw-backup.sh
#
# Never touches running services: pg_dump is online, no restarts.

set -euo pipefail

# Record any unexpected failure to the local log before dying (set -e exits
# don't reach the happy-path log lines otherwise). Never recurse on log errors.
on_err() {
  local code=$?
  mkdir -p "$(dirname "${LOG_FILE}")" 2>/dev/null
  printf '%s ERROR exit=%s line=%s cmd=%s\n' \
    "$(date '+%Y-%m-%d %H:%M:%S')" "$code" "${BASH_LINENO[0]}" "${BASH_COMMAND}" \
    >>"${LOG_FILE}" 2>/dev/null || true
}
trap on_err ERR

# --- config ----------------------------------------------------------------
# launchd runs us with a minimal PATH; make homebrew tooling resolve.
# postgresql@17 是 keg-only，pg_dump/psql 必须显式加它的 bin 才找得到。
export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
NAS_SHARE="/Volumes/虚拟员工工作区"
NAS_BASE="${NAS_SHARE}/backup/multica"
# 2026-09-09 切换：PG/redis 从 colima 容器迁到 brew 原生进程，不再有容器可 exec。
# 内部链路一律走 [::1]：AnyConnect 的回环过滤器会间歇吞 127.0.0.1 的新 SYN。
PGHOST_LOCAL="::1"
PGUSER_LOCAL="multica"
REDIS_HOST_LOCAL="::1"
# brew redis 的 RDB 落盘位置，SAVE 之后直接从这里取（替代 docker cp）。
REDIS_RDB="/opt/homebrew/var/db/redis/dump.rdb"
# 主库 dump 的体积下限。切换/误操作若留下一个「存在但是空」的 multica 库，
# 备份会照常"成功"，连着 30 天归档空 dump，把真正有数据的那些轮转掉——
# 这正是 L2 附件层静默失效 3 周的同一类失败。2026-09-09 实测 multica.dump 为
# 73M，10MB 有 7 倍余量。要调只能是业务真的变了，绝不为了让红变绿而调。
PG_MAIN_DB="multica"
PG_MAIN_MIN_BYTES="${PG_MAIN_MIN_BYTES:-10000000}"
REPO="/Users/fosun_main_agent/var/multica"
# Attachments live wherever LOCAL_UPLOAD_DIR points; it moved to the NAS in
# 2026-08. Read it from .env so this mirror cannot drift to a stale path again.
UPLOADS_SRC=""
if [[ -f "${REPO}/.env" ]]; then
  UPLOADS_SRC="$(awk -F= '/^LOCAL_UPLOAD_DIR=/ { sub(/^[^=]*=/, ""); print; exit }' "${REPO}/.env")"
  # PG 现在要密码认证（原来 docker exec 是容器内 trust）。密码只从 .env 的
  # DATABASE_URL 取，绝不写死在脚本里。这里只读进普通 shell 变量、不 export：
  # 稍后写成 STAGING 里的一次性 PGPASSFILE（0600，随 EXIT trap 一起删），
  # 这样它既不进 argv（ps 可见），也不会被继承进 rsync/tar 等每一个子进程。
  PG_PASS_RAW="$(awk -F= '/^DATABASE_URL=/ { sub(/^[^=]*=/, ""); print; exit }' "${REPO}/.env" \
    | sed -E 's|^postgres(ql)?://[^:]+:([^@]*)@.*|\2|')"
fi
UPLOADS_SRC="${UPLOADS_SRC:-${REPO}/data/uploads}"
WORKSPACES_SRC="${NAS_SHARE}/v2"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
# Blast radius for L3 retirement. The mirror holds ~77k entries, so a share
# that half-mounted would want to retire an order of magnitude more than this;
# a genuine burst (a whole workspace deleted at once) stays well under it.
L3_MAX_RETIRE="${L3_MAX_RETIRE:-10000}"
LOG_FILE="${REPO}/logs/backup.log"          # local log first; NAS copy is best-effort

DATE="$(date +%Y%m%d)"
PG_DIR="${NAS_BASE}/postgres/${DATE}"
CONFIG_DIR="${NAS_BASE}/config/${DATE}"
WS_ATTIC="${NAS_BASE}/workspaces-attic/${DATE}"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/bayclaw-backup.XXXXXX")"
trap 'rm -rf "${STAGING}"' EXIT

# --- helpers ---------------------------------------------------------------
DRY="${DRY:-0}"
IF_NEEDED=0
for arg in "$@"; do
  case "${arg}" in
    --dry-run)   DRY=1 ;;
    --if-needed) IF_NEEDED=1 ;;
    *) echo "unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
log() {
  # A dry run must never touch the real log: an "OK <date>" line there is
  # indistinguishable from a finished backup and would mask a missed day.
  if (( DRY )); then printf 'DRY %s\n' "$*"; return 0; fi
  mkdir -p "$(dirname "${LOG_FILE}")"
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"${LOG_FILE}"
  # Best-effort mirror to NAS logs/ (never fatal: log must survive NAS down).
  if nas_mounted; then
    mkdir -p "${NAS_BASE}/logs"
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"${NAS_BASE}/logs/backup.log" 2>/dev/null || true
  fi
}

run() { # run <cmd...> -- executes, or prints when DRY=1
  if (( DRY )); then printf '    %s\n' "$*"; else "$@"; fi
}

# Safe mkdir that also works under --dry-run.
ensure_dir() {
  if (( DRY )); then printf '    mkdir -p %s\n' "$1"; else mkdir -p "$1"; fi
}

fail() {
  log "FAIL ${DATE} $*"
  echo "backup FAILED: $*" >&2
  exit 1
}

nas_mounted() { /sbin/mount | grep -qF "on ${NAS_SHARE} ("; }

# --- main ------------------------------------------------------------------
say "BayClaw backup ${DATE} (dry-run=$([ "$DRY" = 1 ] && echo yes || echo no))"

# --if-needed is the catch-up path for a machine that was powered off at 02:00:
# launchd discards a StartCalendarInterval missed while shut down (only ones
# missed while asleep are made up), so RunAtLoad re-runs this at every boot.
# Nothing to do when today already has a completed backup.
if (( IF_NEEDED )) && grep -q "OK ${DATE} " "${LOG_FILE}" 2>/dev/null; then
  say "backup for ${DATE} already recorded; nothing to do"
  exit 0
fi
mkdir -p "${STAGING}"

# 1. NAS must be mounted. At boot the mount helper (com.fosunpharma.mount-nas,
#    every 120s) may not have attached the share yet, so a catch-up run waits
#    for it rather than failing loudly in the log.
if (( IF_NEEDED )) && (( ! DRY )); then
  for _ in $(seq 1 30); do
    nas_mounted && break
    sleep 10
  done
fi
if ! nas_mounted; then
  fail "NAS share not mounted at ${NAS_SHARE}"
fi
ensure_dir "${PG_DIR}"
ensure_dir "${NAS_BASE}/uploads"
ensure_dir "${NAS_BASE}/workspaces"
ensure_dir "${NAS_BASE}/redis"
ensure_dir "${NAS_BASE}/config"
ensure_dir "${CONFIG_DIR}"
ensure_dir "${NAS_BASE}/logs"

# 2. L1 -- PostgreSQL, one dump per database
say "L1 postgres dump"
# 连不上就必须响亮失败：2026-08 附件层迁 NAS 后备份静默跳过了 3 周才被发现，
# 这一层宁可整轮 exit 1 也不要"成功但没备到"。
[[ -n "${PG_PASS_RAW:-}" ]] || fail "DATABASE_URL 里取不到 PG 密码（.env 变了？）"
# URL userinfo 里的密码是百分号编码的，还原后再写 pgpass；同时转义 pgpass
# 自己的分隔符（\ 和 :）。
PG_PASS_PLAIN="$(printf '%b' "${PG_PASS_RAW//%/\\x}")"
PG_PASS_ESC="${PG_PASS_PLAIN//\\/\\\\}"; PG_PASS_ESC="${PG_PASS_ESC//:/\\:}"
PGPASSFILE="${STAGING}/.pgpass"
( umask 077; printf '*:*:*:%s:%s\n' "${PGUSER_LOCAL}" "${PG_PASS_ESC}" > "${PGPASSFILE}" )
export PGPASSFILE
unset PG_PASS_RAW PG_PASS_PLAIN PG_PASS_ESC

psql -h "${PGHOST_LOCAL}" -U "${PGUSER_LOCAL}" -d postgres -tAc 'select 1' >/dev/null 2>&1 \
  || fail "无法连接 PostgreSQL ${PGHOST_LOCAL}:5432（brew postgresql@17 没跑？）"
DBS="$(psql -h "${PGHOST_LOCAL}" -U "${PGUSER_LOCAL}" -d postgres -tA \
  -c "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres' ORDER BY datname")"
[[ -n "${DBS}" ]] || fail "no databases found"
for db in ${DBS}; do
  say "  export ${db}"
  run pg_dump -h "${PGHOST_LOCAL}" -U "${PGUSER_LOCAL}" -Fc -d "${db}" -f "${STAGING}/${db}.dump"
done

for db in ${DBS}; do
  say "  verify ${db}"
  # Validate the custom-format dump is readable before trusting it.
  if (( ! DRY )); then
    pg_restore --list "${STAGING}/${db}.dump" >/dev/null || fail "pg_restore --list failed for ${db}"
    if [[ "${db}" == "${PG_MAIN_DB}" ]]; then
      sz="$(stat -f %z "${STAGING}/${db}.dump")"
      (( sz >= PG_MAIN_MIN_BYTES )) \
        || fail "${db}.dump 只有 ${sz} 字节 (<${PG_MAIN_MIN_BYTES})——主库疑似为空，拒绝把它当成功归档"
    fi
  fi
  say "  compress ${db}"
  run gzip -9 -f "${STAGING}/${db}.dump"
  run mv "${STAGING}/${db}.dump.gz" "${PG_DIR}/"
done

# 3. L2 -- attachments (live dir: tolerate transient concurrent-write skips)
say "L2 uploads mirror (${UPLOADS_SRC})"
# --delete against a missing or wrong source would wipe the mirror, so refuse
# to run unless the configured source really is a directory.
[[ -d "${UPLOADS_SRC}" ]] || fail "uploads source not a directory: ${UPLOADS_SRC}"
if ! run rsync -a --delete --ignore-errors "${UPLOADS_SRC}/" "${NAS_BASE}/uploads/"; then
  log "L2 uploads mirror: rsync reported errors (concurrent writes); continuing"
fi

# 4. L3 -- agent workspaces (same NAS, different dir: guard against accidental
#    overwrite/delete of v2/* by giving backup a separate copy). Source is a
#    live daemon workdir -- files are atomically replaced mid-run, so rsync can
#    hit transient ENOENT; skip and continue rather than failing the whole job.
say "L3 workspaces mirror"
if ! run rsync -a --ignore-errors "${WORKSPACES_SRC}/" "${NAS_BASE}/workspaces/"; then
  log "L3 workspaces mirror: rsync reported errors (concurrent writes); continuing"
fi

# 4b. L3 retention. The mirror above stays --delete-free on purpose, so a share
#     that mounted empty can never turn into mass deletion. The cost is
#     divergence: runs the platform GC'd stay mirrored forever (405 dead run
#     dirs / 0.26GB had piled up by 2026-09-04). Reconcile them here, but into
#     a dated attic instead of deleting outright, so a wrong call stays
#     recoverable for RETENTION_DAYS.
#
#     Compared with find rather than rsync's own delete plan: macOS ships
#     openrsync, which escapes non-ASCII bytes as \#nnn in that listing (agent
#     workdirs are full of CJK filenames, so the paths come back unusable), and
#     whose --backup-dir archives only *updated* files while --backup silently
#     disables --delete altogether. All three verified 2026-09-04.
say "L3 retention (retire entries the source no longer has)"
if (( DRY )); then
  printf '    compare %s vs %s -> retire mirror-only entries into %s\n' \
    "${WORKSPACES_SRC}" "${NAS_BASE}/workspaces" "${WS_ATTIC}"
else
  SRC_LIST="${STAGING}/l3-src.list"
  MIRROR_LIST="${STAGING}/l3-mirror.list"
  ORPHANS="${STAGING}/l3-orphans.list"
  # C collation on both sides: comm needs a single ordering, and byte order is
  # the one that puts a directory ahead of everything nested under it.
  ( cd "${WORKSPACES_SRC}" && find . -mindepth 1 ) 2>/dev/null | LC_ALL=C sort >"${SRC_LIST}"
  ( cd "${NAS_BASE}/workspaces" && find . -mindepth 1 ) 2>/dev/null | LC_ALL=C sort >"${MIRROR_LIST}"
  src_n=$(wc -l <"${SRC_LIST}" | tr -d ' ')
  mirror_n=$(wc -l <"${MIRROR_LIST}" | tr -d ' ')
  LC_ALL=C comm -13 "${SRC_LIST}" "${MIRROR_LIST}" >"${ORPHANS}"
  orphan_n=$(wc -l <"${ORPHANS}" | tr -d ' ')
  if (( src_n == 0 )); then
    log "L3 retention: skipped, source listing empty (share not readable?)"
  elif (( orphan_n > L3_MAX_RETIRE )); then
    log "L3 retention: skipped, ${orphan_n} candidates over L3_MAX_RETIRE=${L3_MAX_RETIRE} (src=${src_n} mirror=${mirror_n})"
  else
    retired=0
    # Byte order guarantees a parent is listed before anything under it, so
    # retiring the parent takes its children along and their own lines are
    # simply gone by the time the loop reaches them.
    while IFS= read -r line; do
      rel="${line#./}"
      [[ -n "${rel}" ]] || continue
      from="${NAS_BASE}/workspaces/${rel}"
      [[ -e "${from}" || -L "${from}" ]] || continue
      # The listing is only a candidate generator: the source is a live daemon
      # workdir, and a file replaced mid-walk can be missing from it. Confirm
      # against the source as it stands now before retiring anything.
      if [[ -e "${WORKSPACES_SRC}/${rel}" || -L "${WORKSPACES_SRC}/${rel}" ]]; then
        continue
      fi
      mkdir -p "$(dirname "${WS_ATTIC}/${rel}")"
      if mv "${from}" "${WS_ATTIC}/${rel}"; then
        retired=$((retired + 1))
      else
        log "L3 retention: could not retire ${rel}"
      fi
    done <"${ORPHANS}"
    if (( retired > 0 )); then
      log "L3 retention: retired ${retired} of ${orphan_n} candidates into workspaces-attic/${DATE}"
    fi
  fi
fi

# 5. L4 -- config & secrets
say "L4 config bundle"
CONFIG_STAGE="${STAGING}/config"
ensure_dir "${CONFIG_STAGE}"
run rsync -a "${REPO}/.env"* "${CONFIG_STAGE}/" 2>/dev/null || true
run rsync -a "${REPO}/deploy/" "${CONFIG_STAGE}/deploy/"
run mkdir -p "${CONFIG_STAGE}/launchd"
run cp ~/Library/LaunchAgents/com.bayclaw.*.plist ~/Library/LaunchAgents/com.fosunpharma.mount-nas.plist ~/Library/LaunchAgents/com.fosun.microsocks.plist "${CONFIG_STAGE}/launchd/" 2>/dev/null || true
# ~/.multica also carries Go build caches and daemon logs (dev-tmp/ alone is
# ~275MB). This bundle is for config and credentials; leave rebuildable and
# append-only files out so the daily tar stays small.
run rsync -a --exclude 'dev-tmp/' --exclude '*.log' "${HOME}/.multica/" "${CONFIG_STAGE}/multica-home/"
run cp "${HOME}/Library/Scripts/mount-nas.sh" "${CONFIG_STAGE}/" 2>/dev/null || true
run cp "${HOME}/.local/bin/bayclaw-fleet-daemon-wrapper.sh" "${CONFIG_STAGE}/" 2>/dev/null || true
run tar -czf "${STAGING}/config-${DATE}.tar.gz" -C "${CONFIG_STAGE}" .
run chmod 600 "${STAGING}/config-${DATE}.tar.gz"
run mv "${STAGING}/config-${DATE}.tar.gz" "${CONFIG_DIR}/"

# 6. L5 -- redis RDB (session/PAT cache)
say "L5 redis snapshot"
redis-cli -h "${REDIS_HOST_LOCAL}" PING >/dev/null 2>&1 \
  || fail "无法连接 redis ${REDIS_HOST_LOCAL}:6379（brew redis 没跑？）"
run redis-cli -h "${REDIS_HOST_LOCAL}" SAVE
[[ -f "${REDIS_RDB}" ]] || fail "redis RDB 不在 ${REDIS_RDB}（brew redis 的 dir 变了？）"
run cp "${REDIS_RDB}" "${STAGING}/redis-${DATE}.rdb"
run gzip -9 -f "${STAGING}/redis-${DATE}.rdb"
run mv "${STAGING}/redis-${DATE}.rdb.gz" "${NAS_BASE}/redis/"

# 7. Validate gzip integrity of every artifact written today
say "gzip integrity check"
if (( ! DRY )); then
  while IFS= read -r -d '' f; do
    gzip -t "$f" || fail "gzip -t failed: $f"
  done < <(find "${PG_DIR}" "${NAS_BASE}/redis" "${CONFIG_DIR}" -name '*.gz' -print0)
fi

# 8. Retention: prune postgres dumps older than RETENTION_DAYS, keep monthly
say "prune older than ${RETENTION_DAYS} days"
if (( ! DRY )); then
  find "${NAS_BASE}/postgres" -mindepth 1 -maxdepth 1 -type d -mtime +"${RETENTION_DAYS}" \
    ! -name '??????01' -exec rm -rf {} +
  # The L3 attic gets the same window but no monthly keep: these are retired
  # copies of files the source itself dropped, not point-in-time snapshots.
  if [[ -d "${NAS_BASE}/workspaces-attic" ]]; then
    find "${NAS_BASE}/workspaces-attic" -mindepth 1 -maxdepth 1 -type d \
      -mtime +"${RETENTION_DAYS}" -exec rm -rf {} +
  fi
fi

log "OK ${DATE} dbs=[${DBS//$'\n'/,}]"
say "backup complete -> ${NAS_BASE}"
