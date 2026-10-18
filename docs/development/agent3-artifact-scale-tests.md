# Artifact history scale verification on agent 3

This is an opt-in measurement of the real artifact database/read models. It is separate from the earlier 100,000-Issue / 20,000-meeting fixture. No Agent, external object store or NAS is contacted. The coordinating Mac may compile the test binary; execution belongs exclusively to `fosun_agent_3` and its dedicated `multica_test` database.

The runner requires `MULTICA_RUN_COCKPIT_ARTIFACT_SCALE=1`, `USER=fosun_agent_3`, `DATABASE_URL` equal to the verified `TEST_DATABASE_URL`, and a database name ending in `_test`. Stop the isolated QA API/Web and acquire the existing single-run test lock first. The resident application and its database remain untouched. Migrations 9000–9064 must already be applied by the designated migration runner.

Compile without executing on the coordinator:

```sh
go -C server test -c -race -tags cockpitscale ./internal/service -o /tmp/multica-artifact-scale.test
```

The validator uploads the binary with a SHA-256 check to the dedicated test directory. On agent 3, load its existing test profile, set `DATABASE_URL` from `TEST_DATABASE_URL`, clear application/SMTP variables as in the existing runner, and execute through the Agent CLI guard:

```sh
MULTICA_RUN_COCKPIT_ARTIFACT_SCALE=1 \
MULTICA_COCKPIT_ARTIFACT_SCALE_REPORT="$HOME/var/multica-dev-test/logs/artifact-read-scale.json" \
./scripts/go-test-with-agent-cli-guard.sh \
  "$HOME/var/multica-dev-test/bin/artifact-scale.test" \
  -test.run '^TestCockpitArtifactReadScale$' -test.parallel=1 -test.count=1 -test.timeout=25m -test.v
```

This command is an operation template for the validator, not evidence that the scale test has run.

The fixture has 101 artifacts, 200,000 fixed text versions, 200,000 independent human Review Issues and their primary L3 ownership. One artifact has 199,900 versions; the other 100 have one each and an explicit reference to a second L3. All review decisions are approved fixture history. Seeding uses the managed `testutil` tenant plus scoped bulk SQL and preserves the formal identity constraints; it does not simulate human approvals by updating a live tenant.

Bodies are synthetic, repetitive UTF-8: 150,000 × 4 KiB and 50,000 × 64 KiB. Their compressibility is a stated limitation, not representative object-storage throughput. The test explicitly runs `ANALYZE` after bulk inserts. It does not alter `plan_cache_mode`, JIT, `work_mem`, shared caches, or global PostgreSQL settings.

Each of six reads runs once plus 20 warm samples: artifact header, first 25 version metadata, next 25 metadata, an exact historical 64 KiB body, the producer Issue's reverse-context page, and a 100-artifact evidence-restoration batch under a target L3. Reports include all samples, p50/p95 and maximum encoded response bytes. “First” is the first timed observation after fixture/continuation preparation; it is not an OS or database cold-cache claim. Timing includes service queries and JSON encoding, excluding HTTP/browser transport. Each call has a 25-second limit; a failure remains in the report rather than reducing the fixture.

Cleanup registers before bulk insertion, uses an independent bounded transaction, enters the existing workspace teardown mode, removes formal domain relations before protected primary/Issue rows, and verifies zero retained fixture rows. Preserve logs and reports if a read fails; capture a tenant-scoped query plan in a separate read-only diagnostic window. Do not run another benchmark or modify statistics during sampling.

## Verified runs

Both runs executed on agent 3 in the isolated test database with the same 200,000-version / 200,000-human-Review-Issue fixture. The [9064 baseline report](../design/cockpit-native-2026-10-09/implementation/agent3-artifact-scale-baseline.json) preserves successful read samples **and a failed overall run**: the atomic cleanup exceeded five minutes. A generic plan for the retention guard scanned the whole version relation for each Issue deletion.

Migration 9065 preserves the guard's complete relationship checks and uses the existing indexes through separate ordered scalar lookups. The [9065 verification report](../design/cockpit-native-2026-10-09/implementation/agent3-artifact-scale-9065.json) records a complete passing run, including 126 read samples, a post-sample read-only generic-plan diagnostic, and **12.16 seconds for atomic cleanup**. The diagnostic used the producer index and the unique review index (one execution each), with 0.311 ms reported execution time. No trigger was disabled and no application/global planner setting was changed. Differences in read latencies between runs are not attributed to this deletion-guard fix.

The original fixture's later generic cleanup callbacks emitted one final search-index tombstone after its atomic cleanup had verified zero. The validator removed that single row only after verifying the fixture workspace and all business facts were absent, then confirmed final zero. The harness now registers its owned search-log cleanup and report emission after those callbacks. That test-hygiene adjustment was compiled separately; it is not claimed as another 126-sample run.
