#!/usr/bin/env bash
# Run the real-Redis regression selection on the designated agent 3 host.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEST_STATE_DIR="$HOME/var/multica-dev-test"
TEST_ENV_FILE="${MULTICA_REDIS_TEST_ENV:-$TEST_STATE_DIR/redis.env}"
requested_bin_dir="${MULTICA_TEST_BIN_DIR:-}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bin-dir)
      [ "$#" -ge 2 ] || { echo "--bin-dir requires a path" >&2; exit 2; }
      requested_bin_dir=$2
      shift 2
      ;;
    *) echo "usage: $0 [--bin-dir PATH]" >&2; exit 2 ;;
  esac
done

if [ "$(id -un)" != fosun_agent_3 ]; then
  echo "Redis integration tests must run as fosun_agent_3 on agent 3, not on the coordinating Mac." >&2
  exit 1
fi
[ -f "$TEST_ENV_FILE" ] || { echo "Missing test profile: $TEST_ENV_FILE" >&2; exit 1; }
set -a
# The operator-owned profile is outside the rsync deployment tree.
# shellcheck disable=SC1090
. "$TEST_ENV_FILE"
set +a
test_bin_dir="${requested_bin_dir:-${MULTICA_TEST_BIN_DIR:-}}"
APP_ENV_FILE="${MULTICA_REDIS_APP_ENV:-$HOME/var/multica-dev/.env}"
[ -f "$APP_ENV_FILE" ] || { echo "Missing application profile: $APP_ENV_FILE" >&2; exit 1; }

# Do not inherit application stores, mail delivery, or real-agent smoke flags.
unset REDIS_URL REDISCLI_AUTH SMTP_HOST SMTP_USERNAME SMTP_PASSWORD SMTP_FROM_EMAIL
unset RESEND_API_KEY RESEND_FROM_EMAIL MULTICA_RUN_REAL_AGENT_SMOKE
: "${REDIS_TEST_URL:?Set REDIS_TEST_URL in the test profile}"
: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to an already migrated, isolated test database}"
export DATABASE_URL="$TEST_DATABASE_URL"

# Validate targets without sourcing the application .env or printing credentials.
python3 - "$APP_ENV_FILE" <<'PY'
import os
from pathlib import Path
import sys
from urllib.parse import parse_qsl, unquote, urlsplit

def stop(message):
    raise SystemExit(message)

try:
    redis = urlsplit(os.environ["REDIS_TEST_URL"])
    if (redis.scheme != "redis" or redis.hostname not in ("127.0.0.1", "localhost")
            or redis.port != 16379 or redis.path not in ("", "/0")
            or redis.username or redis.password or redis.query or redis.fragment):
        stop("REDIS_TEST_URL must point to the dedicated unauthenticated localhost:16379/0 instance.")
    database = urlsplit(os.environ["TEST_DATABASE_URL"])
    name = unquote(database.path.lstrip("/"))
    if (database.scheme not in ("postgres", "postgresql") or not database.hostname
            or not name.endswith("_test") or "/" in name):
        stop("TEST_DATABASE_URL must identify a separate PostgreSQL database ending in _test.")
    if any(key.lower() in {"dbname", "database", "host", "hostaddr", "port", "service", "servicefile"}
           for key, _ in parse_qsl(database.query)):
        stop("TEST_DATABASE_URL must not override its database or host through query parameters.")
    app = {}
    path = Path(sys.argv[1])
    for line in path.read_text().splitlines():
        line = line.strip().removeprefix("export ")
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        app[key.strip()] = value.strip().strip("\"'")
    app_db = urlsplit(app.get("DATABASE_URL", ""))
    if app_db.scheme not in ("postgres", "postgresql") or not app_db.path.lstrip("/"):
        stop("Application profile must identify DATABASE_URL so database separation can be checked.")
    if name == unquote(app_db.path.lstrip("/")):
        stop("TEST_DATABASE_URL names the application database; refusing fixture writes.")
    app_redis = urlsplit(app.get("REDIS_URL", ""))
    if app_redis.hostname in ("127.0.0.1", "localhost") and app_redis.port == 16379:
        stop("The application uses Redis port 16379; refusing destructive tests on it.")
except ValueError:
    stop("Invalid Redis or PostgreSQL test URL; credentials were not printed.")
print("Targets: dedicated Redis localhost:16379; PostgreSQL database " + name)
PY

if [ -n "$test_bin_dir" ]; then
  test_bin_dir=$(CDPATH= cd -- "$test_bin_dir" && pwd)
  for name in auth middleware service handler lark wecom database; do
    [ -x "$test_bin_dir/$name.test" ] || { echo "Missing test binary: $name.test" >&2; exit 1; }
  done
else
  command -v go >/dev/null || { echo "Go is unavailable; provide --bin-dir with matching race-enabled test binaries." >&2; exit 1; }
fi

redis_cli=/opt/homebrew/opt/redis/bin/redis-cli
[ -x "$redis_cli" ] || { echo "Missing agent 3 redis-cli: $redis_cli" >&2; exit 1; }
mkdir -p "$TEST_STATE_DIR"
lock_dir="$TEST_STATE_DIR/run.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  echo "Another run owns $lock_dir. Inspect its owner before manually removing a stale lock." >&2
  exit 1
fi
printf 'pid=%s\nhost=%s\n' "$$" "$(hostname)" > "$lock_dir/owner"
cleanup() {
  rm -f "$lock_dir/owner"
  rmdir "$lock_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# INFO is read-only. Verify the instance behind the port, not just its address.
python3 - "$redis_cli" "$TEST_STATE_DIR/redis.conf" <<'PY'
from pathlib import Path
import subprocess
import sys

def server_info(port, required):
    try:
        result = subprocess.run(
            [sys.argv[1], "-h", "127.0.0.1", "-p", str(port), "--raw", "INFO", "server"],
            capture_output=True, text=True, timeout=3,
        )
    except subprocess.TimeoutExpired:
        result = None
    if result is None or result.returncode != 0:
        if required:
            raise SystemExit("Cannot read the dedicated Redis instance identity.")
        return None
    fields = dict(line.split(":", 1) for line in result.stdout.splitlines()
                  if line and not line.startswith("#") and ":" in line)
    if not fields.get("run_id"):
        raise SystemExit("Redis INFO server did not return an instance identity; refusing tests.")
    return fields

test = server_info(16379, True)
if not test.get("config_file") or Path(test["config_file"]).resolve() != Path(sys.argv[2]).resolve():
    raise SystemExit("Redis port 16379 is not using the dedicated redis.conf; refusing tests.")
app = server_info(6379, False)
if app is not None and app["run_id"] == test["run_id"]:
    raise SystemExit("Test and application ports reach the same Redis instance; refusing tests.")
print("Dedicated Redis configuration and distinct application instance verified." if app is not None
      else "Dedicated Redis configuration verified; application port 6379 is unreachable, so identity comparison was unavailable.")
PY

# SELECT confirms every overridden logical DB exists. No CONFIG dump,
# ACL changes, or database clearing happens outside the selected tests.
for index in 0 11 12 13 14 15; do
  if [ "$("$redis_cli" -h 127.0.0.1 -p 16379 --raw SELECT "$index")" != OK ]; then
    echo "Dedicated Redis is not ready for DB $index; refusing a skipped test run." >&2
    exit 1
  fi
done

log_dir=$(mktemp -d "$TEST_STATE_DIR/run-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
printf 'host=%s\naccount=%s\nprofile=%s\napplication_profile=%s\nbinaries=%s\n' "$(hostname)" "$(id -un)" "$TEST_ENV_FILE" "$APP_ENV_FILE" "${test_bin_dir:-go test -race}" > "$log_dir/run.txt"
echo "Logs: $log_dir"

run_package() {
  local name=$1 package=$2 expected=$3 pattern=$4 log_file="$log_dir/$1.log"
  local -a command
  if [ -n "$test_bin_dir" ]; then
    command=("$test_bin_dir/$name.test" -test.v -test.count=1 -test.parallel=1 -test.timeout=5m -test.run "$pattern")
  else
    command=(go test -race -p 1 -count=1 -parallel=1 -timeout=5m -v -run "$pattern" .)
  fi
  echo "Running $package ($expected parent tests)"
  if ! (cd "$REPO_ROOT/server/$package" && "$SCRIPT_DIR/go-test-with-agent-cli-guard.sh" -- "${command[@]}") 2>&1 | tee "$log_file"; then
    echo "$package failed; see $log_file" >&2
    return 1
  fi
  local passed skipped
  passed=$(awk '/^--- PASS:/ { n++ } END { print n+0 }' "$log_file")
  skipped=$(awk '/^[[:space:]]*--- SKIP:/ { n++ } END { print n+0 }' "$log_file")
  printf '%s: parent_pass=%s expected=%s skipped=%s\n' "$name" "$passed" "$expected" "$skipped" | tee -a "$log_dir/summary.txt"
  if [ "$skipped" -ne 0 ] || [ "$passed" -ne "$expected" ]; then
    echo "$package did not execute the complete selection. Check dependencies and binary/source revision." >&2
    return 1
  fi
}

# Packages run serially: Lark and service both use Redis DB 12. The expected
# parent count also detects handler TestMain exiting successfully without tests.
run_package auth internal/auth 13 '^Test((PATCache|DaemonTokenCache|MembershipCache)_(SetGetInvalidate|TTL|Set_RespectsClampedTTL|IsolatesKeysByUser)|CloudPATVerifier_(CacheHitSkipsHTTP|NegativesNotCached|LookupRejectsUnknownOwner|LookupSuccessIsCached))$'
run_package middleware internal/middleware 11 '^Test(Auth_PATCacheHit|DaemonAuth_(DaemonTokenCacheHit|PATCacheHit|StripsClientSuppliedActorSource|StripsForgedAgentIdentityHeaders)|PluginRateLimitIsPerCredentialAndUsesStableProblem|RateLimit_(AllowsUnderLimit|BlocksOverLimit|RetryAfterHeader|DifferentIPs|LuaScript_SetsTTL))$'
run_package service internal/service 19 '^Test(EmptyClaimCache_(EmptyRuntimeIDIsNoOp|MarkAndIsEmptyVersionMatched|BumpInvalidatesPriorMark|StaleMarkRejected|TTL|RuntimeIsolation)|ReclaimCheckCache_(ProductionWindowHintOutlivesDeadline|CheckedHintIsDeferredAndRetriggers|TrackLaterAndForget|CollectionCheckAlignsBackstops|DueRuntimeIDsPreservesInputOrder|MarkCheckedBatchLimitFailsOpen)|NotifyTaskAvailable_(BumpsBeforeWakeup|InvalidWithoutRuntimeIsNoOp)|NotifyTaskFinished_BumpsBeforeRuntimeWakeup|NotifyTasksFinished_CoalescesByRuntime|NotifyTaskEnqueued_UnwiredServiceCannotInvalidateClaimVerdict|ClaimTasksForRuntimes_(AnyDueRuntimeChecksTheCompleteSet|EmptyReclaimDefersHintForRetry))$'
run_package handler internal/handler 48 '^Test(Redis(LivenessStore_|LocalSkill(List|Import)Store_|ModelCatalogCache_|ModelListStore_|UpdateStore_|Webhook(IP)?RateLimiter_|SlidingWindowRateLimiter_)|RequireDaemonWorkspaceAccess_Cache(Hit|MissBackfills)$|MembershipCache_InvalidatedOn(DeleteMember|DeleteWorkspace|LeaveWorkspace|UpdateMember)$)'
run_package lark internal/integrations/lark 10 '^Test(Redis)?InstallSessionStore'
run_package wecom internal/integrations/wecom 4 '^Test(RedisDedupe_TokenFencedOperations|Relay_(ARetriedReplyKeepsItsPlaceInLine|AReplyNoReplicaCouldSendIsCountedOnce|ADeliveredReplyIsCountedOnceAndNotAlsoLost))$'
run_package database internal/database 1 '^TestNewRedisClientPingsConfiguredRedis$'
echo "Redis regression selection passed on agent 3: 106 parent tests, zero skips. Logs: $log_dir"
