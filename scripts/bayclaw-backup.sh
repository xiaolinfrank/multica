#!/usr/bin/env bash
# bayclaw-backup.sh -- daily backup of Multica platform data to NAS.
#
# Layers:
#   L1 postgres/  -- per-database pg_dump (custom format), gzip'd
#   L2 uploads/   -- rsync mirror of LOCAL_UPLOAD_DIR attachments
#   L3 workspaces/-- rsync copy of agent workspaces (NAS v2/ -> backup dir)
#   L4 config/    -- tar of .env, deploy/, launchd plists, ~/.multica creds
#   L5 redis/     -- RDB snapshot (session/PAT cache; clearing forces re-auth)
#
# Target: /Volumes/虚拟员工工作区/backup/multica
# Retention: PG dumps kept RETENTION_DAYS (default 30) plus monthly archive.
# Scheduling: launchd com.bayclaw.backup, daily 02:00 (see deploy/).
#
# Usage:
#   scripts/bayclaw-backup.sh              # run a real backup
#   scripts/bayclaw-backup.sh --dry-run    # print commands without executing
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
# launchd runs us with a minimal PATH; make homebrew/colima tooling resolve.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
NAS_SHARE="/Volumes/虚拟员工工作区"
NAS_BASE="${NAS_SHARE}/backup/multica"
PG_CONTAINER="multica-postgres-1"
REDIS_CONTAINER="multica-redis-1"
REPO="/Users/fosun_main_agent/var/multica"
UPLOADS_SRC="${REPO}/data/uploads"          # LOCAL_UPLOAD_DIR=./data/uploads
WORKSPACES_SRC="${NAS_SHARE}/v2"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
LOG_FILE="${REPO}/logs/backup.log"          # local log first; NAS copy is best-effort

DATE="$(date +%Y%m%d)"
PG_DIR="${NAS_BASE}/postgres/${DATE}"
CONFIG_DIR="${NAS_BASE}/config/${DATE}"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/bayclaw-backup.XXXXXX")"
trap 'rm -rf "${STAGING}"' EXIT

# --- helpers ---------------------------------------------------------------
DRY="${DRY:-0}"
if [[ "${1:-}" == "--dry-run" ]]; then DRY=1; fi

say() { printf '==> %s\n' "$*"; }
log() {
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
mkdir -p "${STAGING}"

# 1. NAS must be mounted
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
DBS="$(docker exec "${PG_CONTAINER}" psql -U multica -d postgres -tA \
  -c "SELECT datname FROM pg_database WHERE datistemplate = false AND datname <> 'postgres' ORDER BY datname")"
[[ -n "${DBS}" ]] || fail "no databases found"
for db in ${DBS}; do
  say "  export ${db}"
  run docker exec "${PG_CONTAINER}" pg_dump -U multica -Fc -d "${db}" -f "/tmp/bcl-${db}.dump"
  run docker cp "${PG_CONTAINER}:/tmp/bcl-${db}.dump" "${STAGING}/${db}.dump"
  run docker exec "${PG_CONTAINER}" rm -f "/tmp/bcl-${db}.dump"
done

for db in ${DBS}; do
  say "  verify ${db}"
  # Validate the custom-format dump is readable before trusting it.
  if (( ! DRY )); then
    docker exec -i "${PG_CONTAINER}" pg_restore --list < "${STAGING}/${db}.dump" >/dev/null || fail "pg_restore --list failed for ${db}"
  fi
  say "  compress ${db}"
  run gzip -9 -f "${STAGING}/${db}.dump"
  run mv "${STAGING}/${db}.dump.gz" "${PG_DIR}/"
done

# 3. L2 -- attachments (live dir: tolerate transient concurrent-write skips)
say "L2 uploads mirror"
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

# 5. L4 -- config & secrets
say "L4 config bundle"
CONFIG_STAGE="${STAGING}/config"
ensure_dir "${CONFIG_STAGE}"
run rsync -a "${REPO}/.env"* "${CONFIG_STAGE}/" 2>/dev/null || true
run rsync -a "${REPO}/deploy/" "${CONFIG_STAGE}/deploy/"
run mkdir -p "${CONFIG_STAGE}/launchd"
run cp ~/Library/LaunchAgents/com.bayclaw.*.plist ~/Library/LaunchAgents/com.fosunpharma.mount-nas.plist ~/Library/LaunchAgents/com.fosun.microsocks.plist "${CONFIG_STAGE}/launchd/" 2>/dev/null || true
run rsync -a "${HOME}/.multica/" "${CONFIG_STAGE}/multica-home/"
run cp "${HOME}/Library/Scripts/mount-nas.sh" "${CONFIG_STAGE}/" 2>/dev/null || true
run cp "${HOME}/.local/bin/bayclaw-fleet-daemon-wrapper.sh" "${CONFIG_STAGE}/" 2>/dev/null || true
run tar -czf "${STAGING}/config-${DATE}.tar.gz" -C "${CONFIG_STAGE}" .
run chmod 600 "${STAGING}/config-${DATE}.tar.gz"
run mv "${STAGING}/config-${DATE}.tar.gz" "${CONFIG_DIR}/"

# 6. L5 -- redis RDB (session/PAT cache)
say "L5 redis snapshot"
run docker exec "${REDIS_CONTAINER}" redis-cli SAVE
run docker cp "${REDIS_CONTAINER}:/data/dump.rdb" "${STAGING}/redis-${DATE}.rdb"
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
fi

log "OK ${DATE} dbs=[${DBS//$'\n'/,}]"
say "backup complete -> ${NAS_BASE}"
