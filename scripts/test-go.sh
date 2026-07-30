#!/usr/bin/env bash
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
GUARD_SCRIPT="$SCRIPT_DIR/go-test-with-agent-cli-guard.sh"

usage() {
  echo "usage: $0 [--race]" >&2
}

go_test_args=(test)
case "$#" in
  0) ;;
  1)
    if [ "$1" != "--race" ]; then
      usage
      exit 2
    fi
    go_test_args+=(-race)
    ;;
  *)
    usage
    exit 2
    ;;
esac

# Go tests are not hermetic — they create fixtures in whatever DATABASE_URL
# points at, and `make test` migrates it first. On a self-hosted deployment
# that URL is the live database, so refuse anything that is not obviously a
# test database. Set MULTICA_ALLOW_NON_TEST_DB=1 to override deliberately.
if [ -n "${DATABASE_URL:-}" ] && [ "${MULTICA_ALLOW_NON_TEST_DB:-}" != "1" ]; then
  db_path="${DATABASE_URL%%\?*}"
  db_name="${db_path##*/}"
  case "$db_name" in
    *_test | *_tests | test | postgres_test) ;;
    *)
      echo "refusing to run tests against database '$db_name': it is not a test database." >&2
      echo "Go tests write fixtures and 'make test' runs migrations, so this would mutate real data." >&2
      echo "Use 'make test' (derives <db>_test automatically), set TEST_DATABASE_URL," >&2
      echo "or set MULTICA_ALLOW_NON_TEST_DB=1 if you really mean it." >&2
      exit 1
      ;;
  esac
fi

cd "$REPO_ROOT/server"
packages=$(go list ./...)
regular_packages=()
for package in $packages; do
  case "$package" in
    */pkg/agent|*/pkg/agent/*) ;;
    *) regular_packages+=("$package") ;;
  esac
done

"$GUARD_SCRIPT" -- go "${go_test_args[@]}" "${regular_packages[@]}"
# Subprocess-backed agent tests have hard deadlines. Limit both package and
# within-package parallelism so race builds do not starve their parent loops.
"$GUARD_SCRIPT" -- go "${go_test_args[@]}" -p 2 -parallel 2 ./pkg/agent/...
