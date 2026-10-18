# Agent 3 Redis integration tests

Run this selection on `fosun_agent_3`. Uploaded test artifacts live under `~/var/multica-dev-test/suite`, separately from the running application in `~/var/multica-dev`. The coordinating Mac may build binaries and perform static checks; it is not the test environment.

## Dedicated dependencies

The operator-owned profile is `~/var/multica-dev-test/redis.env`, outside the tree replaced by `scripts/dev-node-sync.sh` (`rsync --delete`). Keep Redis configuration, runtime files, test binaries, and logs under this separate directory. Do not put credentials in the repository or copy production configuration.

The profile must export these shell variables:

```sh
REDIS_TEST_URL=redis://127.0.0.1:16379/0
TEST_DATABASE_URL='postgres://<test-user>:<test-password>@<verified-test-host>:<port>/multica_test?sslmode=disable'
MULTICA_TEST_BIN_DIR="$HOME/var/multica-dev-test/bin"
```

The test Redis is a dedicated loopback-only instance on port **16379**, with the default 16 logical databases. The application Redis on **6379** remains separate. Tests override the URL's database: auth uses 11, service and Lark use 12, middleware uses 13, handler uses 14, and WeCom uses 15. They run `FLUSHDB`; handler tests also create and delete Redis ACL users. Never point them at application Redis, even using a different database number.

The runner requires the actual application profile at `~/var/multica-dev/.env`, even when its own source is in the isolated suite directory. `MULTICA_REDIS_APP_ENV` may specify another verified application profile; it must exist. The file is read only to check target separation, never sourced. Before running tests, read-only `INFO server` must identify `~/var/multica-dev-test/redis.conf` as the test instance's configuration. If application port 6379 is reachable, its Redis `run_id` must differ from the test instance.

`TEST_DATABASE_URL` must refer to an independently verified and migrated test database ending in `_test`. The runner does not create databases or run migrations. Handler `TestMain` writes fixtures before test filtering; two service claim tests and three WeCom ordering tests also write PostgreSQL fixtures. An unset or unreachable PostgreSQL URL cannot count as successful verification.

## Run

On agent 3 with Go installed and a matching source snapshot in the isolated suite directory (omit `MULTICA_TEST_BIN_DIR` from the profile to build there):

```sh
cd ~/var/multica-dev-test/suite
scripts/test-redis.sh
```

Without Go, build race-enabled test binaries from the same source revision on a compatible build machine using `go test -race -c -o <name>.test <package>`. This builds without executing tests. Upload these binaries to `~/var/multica-dev-test/bin/`:

| Binary | Package under `server/` |
| --- | --- |
| `auth.test` | `./internal/auth` |
| `middleware.test` | `./internal/middleware` |
| `service.test` | `./internal/service` |
| `handler.test` | `./internal/handler` |
| `lark.test` | `./internal/integrations/lark` |
| `wecom.test` | `./internal/integrations/wecom` |
| `database.test` | `./internal/database` |

Both the current build machine and agent 3 use Darwin ARM64; race builds require a compatible C toolchain. Copy the runner, agent CLI guard, command-name list, and matching `server/` source snapshot into `~/var/multica-dev-test/suite/`, preserving their repository-relative paths. This does not replace or restart the running application. Then run **on agent 3**:

```sh
cd ~/var/multica-dev-test/suite
scripts/test-redis.sh --bin-dir "$HOME/var/multica-dev-test/bin"
```

`MULTICA_TEST_BIN_DIR` is the environment equivalent of `--bin-dir`; `MULTICA_REDIS_TEST_ENV` overrides the profile path. The runner accepts only the `fosun_agent_3` account, validates dependency targets, clears application Redis and mail settings, wraps execution in the existing agent CLI guard, and runs packages serially with test parallelism set to one.

## Installed Redis service

The dedicated instance uses the user launchd service `com.multica.redis-tests` and configuration `~/var/multica-dev-test/redis.conf`. On agent 3, inspect it with:

```sh
launchctl print "gui/$(id -u)/com.multica.redis-tests"
/opt/homebrew/opt/redis/bin/redis-cli -h 127.0.0.1 -p 16379 PING
```

After confirming no test job owns `~/var/multica-dev-test/run.lock`, restart only this test Redis when needed:

```sh
launchctl kickstart -k "gui/$(id -u)/com.multica.redis-tests"
```

The runner never restarts Redis. These service commands do not affect application Redis on port 6379.

## Results and recovery

Each run saves host identity, per-package verbose logs, and a count summary in `~/var/multica-dev-test/run-<timestamp>.<suffix>/`. Success requires **106 parent tests and zero skips**. This includes 103 parent tests with real Redis coverage (six Lark parents also run memory subtests) and three companion tests that do not use Redis: `NotifyTasksFinished` coalescing and the model/update envelope round-trips. Realtime relay and channel lease mock tests are outside this selection.

Any skip, test failure, or unexpected parent count fails the runner. A count mismatch can mean stale binaries or a changed selection; rebuild from the matching source revision and inspect the logs. Redis readiness is checked before test execution, so an unavailable dependency cannot silently pass through a skip.

The atomic directory lock `~/var/multica-dev-test/run.lock` permits one job at a time. A normal exit removes its own lock. After an interrupted or killed run, inspect `run.lock/owner` and confirm its process has stopped before manually removing the stale lock. The runner never removes a lock owned by another invocation.

## Verified installation — 2026-10-09

The dedicated Redis service is installed on agent 3 at `127.0.0.1:16379`, using Redis 8.10.1, loopback binding, 16 logical databases, no disk persistence, and a 256 MiB `noeviction` limit. The profile has owner-only permissions. Application Redis remains on 6379; application configuration was not changed.

The existing PostgreSQL `multica_test` database was verified to have no active sessions or workspaces before migration. Only that test database was migrated through 973 using the matching migration binary and SQL snapshot. The application database is `multica_dev` and was not migrated.

Agent 3 had no Go compiler. The coordinator **only built** race test binaries and the migration executable from source commit `a3526d28f84257a510b2e6b96c39e28326b56739`; the matching server source was uploaded into the independent suite directory. All eight artifacts were verified against `~/var/multica-dev-test/build-manifest.json` on agent 3 before execution. The running application checkout and binaries were not replaced.

The suite ran successfully on agent 3 with **106 parent tests passed, zero skipped**, including the previously skipped service and handler Redis cases:

| Package | Parent tests passed |
| --- | ---: |
| auth | 13 |
| middleware | 11 |
| service | 19 |
| handler | 48 |
| lark | 10 |
| wecom | 4 |
| database | 1 |

Remote evidence: `~/var/multica-dev-test/run-20261009T090956Z.yMcgCU/` contains `run.txt`, package logs and `summary.txt`; the command returned exit code 0. The final read-only check confirmed distinct Redis instance IDs, owner-only profile permissions, a released test lock, and application health `ok` with the unchanged backend process (PID 30604). Full run logs were also retrieved to the coordinator for review; all test execution occurred on agent 3.
