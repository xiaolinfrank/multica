#!/usr/bin/env bash
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/multica-test-go.XXXXXX")
BIN_DIR="$TEST_DIR/bin"
CALLS_FILE="$TEST_DIR/go-calls.log"
ENV_FILE="$TEST_DIR/go-env.log"
OUTPUT_FILE="$TEST_DIR/output.log"

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

mkdir -p "$BIN_DIR"
export MULTICA_TEST_GO_CALLS="$CALLS_FILE"
export MULTICA_TEST_GO_ENV="$ENV_FILE"
: >"$CALLS_FILE"

cat >"$BIN_DIR/go" <<'FAKE'
#!/usr/bin/env bash
set -eu

case "${1:-}" in
  list)
    if [ "$#" -ne 2 ] || [ "$2" != "./..." ]; then
      echo "unexpected go list arguments: $*" >&2
      exit 2
    fi
    printf '%s\n' \
      github.com/multica-ai/multica/server \
      github.com/multica-ai/multica/server/internal/daemon \
      github.com/multica-ai/multica/server/pkg/agent \
      github.com/multica-ai/multica/server/pkg/agent/internal/testutil
    ;;
  test)
    printf '%s\n' "$*" >>"$MULTICA_TEST_GO_CALLS"
    printf 'SMTP_HOST=%s|SMTP_USERNAME=%s|SMTP_PASSWORD=%s|SMTP_FROM_EMAIL=%s|RESEND_API_KEY=%s|RESEND_FROM_EMAIL=%s\n' \
      "${SMTP_HOST-}" "${SMTP_USERNAME-}" "${SMTP_PASSWORD-}" "${SMTP_FROM_EMAIL-}" \
      "${RESEND_API_KEY-}" "${RESEND_FROM_EMAIL-}" >>"$MULTICA_TEST_GO_ENV"
    ;;
  *)
    echo "unexpected go command: $*" >&2
    exit 2
    ;;
esac
FAKE
chmod 755 "$BIN_DIR/go"

# `make test` exports every .env variable, so the test binary would otherwise
# inherit a live SMTP relay and mail every fixture address it touches.
export SMTP_HOST=smtp.example.com
export SMTP_USERNAME=relay-user
export SMTP_PASSWORD=relay-secret
export SMTP_FROM_EMAIL=noreply@example.com
export RESEND_API_KEY=re_test
export RESEND_FROM_EMAIL=noreply@example.com

regular_call='test -race github.com/multica-ai/multica/server github.com/multica-ai/multica/server/internal/daemon'
agent_call='test -race -p 2 -parallel 2 ./pkg/agent/...'

# $1: case label; $2: expected go calls, one per line. Clears the log after.
expect_calls() {
  actual_calls=$(cat "$CALLS_FILE")
  if [ "$actual_calls" != "$2" ]; then
    echo "$1: unexpected go test calls:" >&2
    printf '%s\n' "$actual_calls" >&2
    exit 1
  fi
  : >"$CALLS_FILE"
}

# $1: case label; the rest are arguments for test-go.sh. Asserts the usage
# exit status, the usage line, and that go was never invoked.
expect_usage_failure() {
  label=$1
  shift
  set +e
  PATH="$BIN_DIR:$PATH" bash "$SCRIPT_DIR/test-go.sh" "$@" >"$OUTPUT_FILE" 2>&1
  status=$?
  set -e

  if [ "$status" -ne 2 ]; then
    echo "$label returned status $status, want 2" >&2
    cat "$OUTPUT_FILE" >&2
    exit 1
  fi
  if [ -s "$CALLS_FILE" ]; then
    echo "$label invoked go:" >&2
    cat "$CALLS_FILE" >&2
    exit 1
  fi
  if ! grep -q '^usage: .*test-go.sh \[--race\] \[--only regular|agent\]$' "$OUTPUT_FILE"; then
    echo "$label did not print usage" >&2
    cat "$OUTPUT_FILE" >&2
    exit 1
  fi
}

PATH="$BIN_DIR:$PATH" bash "$SCRIPT_DIR/test-go.sh" --race
expect_calls "--race" "$regular_call
$agent_call"

# Both halves must run with mail credentials cleared: a live relay inherited
# from .env would mail fixture addresses and burn the shared daily quota.
expected_env='SMTP_HOST=|SMTP_USERNAME=|SMTP_PASSWORD=|SMTP_FROM_EMAIL=|RESEND_API_KEY=|RESEND_FROM_EMAIL=
SMTP_HOST=|SMTP_USERNAME=|SMTP_PASSWORD=|SMTP_FROM_EMAIL=|RESEND_API_KEY=|RESEND_FROM_EMAIL='
actual_env=$(cat "$ENV_FILE")
if [ "$actual_env" != "$expected_env" ]; then
  echo "go test inherited mail credentials (it would send real email):" >&2
  printf '%s\n' "$actual_env" >&2
  exit 1
fi
: >"$ENV_FILE"

PATH="$BIN_DIR:$PATH" bash "$SCRIPT_DIR/test-go.sh" --race --only regular
expect_calls "--only regular" "$regular_call"

# Option order must not matter: CI spells it one way, humans another.
PATH="$BIN_DIR:$PATH" bash "$SCRIPT_DIR/test-go.sh" --only agent --race
expect_calls "--only agent" "$agent_call"

expect_usage_failure "unknown option" --unknown
expect_usage_failure "unknown --only scope" --only everything
expect_usage_failure "missing --only scope" --only

echo "test-go.test.sh: PASS"
