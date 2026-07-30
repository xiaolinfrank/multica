#!/usr/bin/env bash
#
# Resolve (and create) the database Go tests run against, and print its URL.
#
# Go tests here are not hermetic: they create fixtures, and `make test` runs
# `migrate up` before them. Pointed at DATABASE_URL that means the developer's
# real database — on a self-hosted deployment that is the live one. This script
# keeps a separate database for tests so a test run can never migrate or write
# into it.
#
# Resolution order:
#   1. TEST_DATABASE_URL, used verbatim.
#   2. DATABASE_URL with "_test" appended to the database name.
#   3. postgres://<user>:<password>@localhost:<port>/<db>_test
#
# The database is created if missing. Everything else (container lifecycle) is
# ensure-postgres.sh's job and must have run first.
set -euo pipefail

ENV_FILE="${1:-.env}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

POSTGRES_DB="${POSTGRES_DB:-multica}"
POSTGRES_USER="${POSTGRES_USER:-multica}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-multica}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"

# Split "scheme://authority/dbname?query" so the database name can be swapped
# without disturbing credentials, host, port or connection options.
url_prefix=""
url_query=""
db_name=""

if [ -n "${TEST_DATABASE_URL:-}" ]; then
  echo "$TEST_DATABASE_URL"
  exit 0
fi

if [ -n "${DATABASE_URL:-}" ]; then
  base="${DATABASE_URL%%\?*}"
  [ "$base" != "$DATABASE_URL" ] && url_query="?${DATABASE_URL#*\?}"
  url_prefix="${base%/*}"
  db_name="${base##*/}"
else
  url_prefix="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}"
  db_name="$POSTGRES_DB"
  url_query="?sslmode=disable"
fi

# Idempotent: re-deriving from an already-test URL must not stack suffixes.
case "$db_name" in
  *_test) test_db="$db_name" ;;
  *) test_db="${db_name}_test" ;;
esac

if [ "$test_db" = "$db_name" ] && [ -n "${DATABASE_URL:-}" ]; then
  : # already a test database, nothing to rename
fi

test_url="${url_prefix}/${test_db}${url_query}"

# Create it if missing. Uses the compose container when the host is local,
# matching ensure-postgres.sh; a remote host is the operator's to provision.
host_port="${url_prefix##*@}"
db_host="${host_port%%:*}"

if [ "$db_host" = "localhost" ] || [ "$db_host" = "127.0.0.1" ] || [ "$db_host" = "::1" ]; then
  exists="$(docker compose exec -T postgres \
    psql -U "$POSTGRES_USER" -d postgres -Atqc \
    "SELECT 1 FROM pg_database WHERE datname = '$test_db'" 2>/dev/null || true)"
  if [ "$exists" != "1" ]; then
    echo "==> Creating test database '$test_db'..." >&2
    docker compose exec -T postgres \
      psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
      -c "CREATE DATABASE \"$test_db\"" > /dev/null
  fi
else
  echo "==> Remote database host ($db_host); assuming '$test_db' exists." >&2
fi

echo "$test_url"
