package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Exercise the actual table/index files without synthesizing the preexisting
// Issue/meeting schema needed by the separately validated integrity migrations.
func TestCockpitArtifactBatchPreservesFactsAndCleanupOnRollback(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	schema := fmt.Sprintf("artifact_batch_%d_%d", time.Now().UnixNano(), rand.Uint32())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		if _, err := admin.Exec(cleanup, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Errorf("clean owned migration schema: %v", err)
		}
	})
	pool := openTestPoolWithSearchPath(t, schema)
	versions := append([]string(nil), cockpitArtifactMigrationVersions[:len(cockpitArtifactMigrationVersions)-1]...)
	if len(versions) != 64 || versions[len(versions)-1] != "9063_cockpit_acceptance_handoff_retired_issue_idx" {
		t.Fatal("update the independently scoped table/index batch when its manifest changes")
	}
	options := runOptions{Direction: "up", Files: realMigrationFiles(t, versions, "up"),
		SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1,
		Hooks: hooksForDirection("up")}
	if err := runMigrations(ctx, pool, options); err != nil {
		t.Fatalf("apply actual table/index files: %v", err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO schema_migrations(version) VALUES ('historical_identity_kept')"); err != nil {
		t.Fatal(err)
	}
	ledger := func() map[string]time.Time {
		t.Helper()
		rows, err := pool.Query(ctx, "SELECT version, applied_at FROM schema_migrations")
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		result := map[string]time.Time{}
		for rows.Next() {
			var stem string
			var applied time.Time
			if err := rows.Scan(&stem, &applied); err != nil {
				t.Fatal(err)
			}
			result[stem] = applied
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := ledger()
	if len(before) != 65 {
		t.Fatalf("ledger = %d, want 64 new and one retained historical identity", len(before))
	}
	if err := runMigrations(ctx, pool, options); err != nil {
		t.Fatalf("repeat up: %v", err)
	}
	if !reflect.DeepEqual(before, ledger()) {
		t.Fatal("repeat up changed a recorded identity or its original application time")
	}
	assertIndexes := func() {
		t.Helper()
		var count, usable int
		err := pool.QueryRow(ctx, "SELECT count(*), count(*) FILTER (WHERE i.indisvalid AND i.indisready) "+
			"FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace "+
			"WHERE n.nspname=$1 AND c.relname LIKE 'cockpit_%'", schema).Scan(&count, &usable)
		if err != nil || count != 50 || usable != 50 {
			t.Fatalf("artifact indexes total/usable = %d/%d, want 50/50: %v", count, usable, err)
		}
	}
	assertIndexes()
	reversed := append([]string(nil), versions...)
	for left, right := 0, len(reversed)-1; left < right; left, right = left+1, right-1 {
		reversed[left], reversed[right] = reversed[right], reversed[left]
	}
	down := options
	down.Direction, down.Files, down.Hooks = "down", realMigrationFiles(t, reversed, "down"), hooksForDirection("down")
	for _, fixture := range []struct{ name, table, insert string }{
		{"artifact", "cockpit_artifact", "INSERT INTO cockpit_artifact(id,workspace_id,owner_node_id,project_id,module_id,source_issue_id,authorized_producer_issue_id,creation_key,request_hash,created_by,title,reviewer_id) " +
			"VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'fixed',gen_random_uuid(),'Retained report',gen_random_uuid())"},
		{"acceptance definition", "cockpit_acceptance_definition", "INSERT INTO cockpit_acceptance_definition(workspace_id,node_id,created_by,last_updated_by,last_request_hash) " +
			"VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'fixed')"},
		{"only deleted-object tombstone", "cockpit_artifact_capture_attempt", "INSERT INTO cockpit_artifact_capture_attempt(id,workspace_id,artifact_id,version_id,attempt_number,lease_token,lease_expires_at,storage_key,object_url,state,io_finished_at,cleanup_status) " +
			"VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,gen_random_uuid(),now(),'owned/fixed-copy','owned/fixed-copy','verified',now(),'deleted')"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			if _, err := pool.Exec(ctx, fixture.insert); err != nil {
				t.Fatal(err)
			}
			err := runMigrations(ctx, pool, down)
			if err == nil || !strings.Contains(err.Error(), "cannot roll back artifacts while "+fixture.table+" retains") {
				t.Fatalf("rollback lost retained responsibility or failed for another reason: %v", err)
			}
			assertIndexes()
			if !reflect.DeepEqual(before, ledger()) {
				t.Fatal("rejected rollback changed the migration ledger")
			}
			var retained int
			if err := pool.QueryRow(ctx, "SELECT count(*) FROM "+pgx.Identifier{fixture.table}.Sanitize()).Scan(&retained); err != nil || retained != 1 {
				t.Fatalf("retained fact count = %d: %v", retained, err)
			}
			if _, err := pool.Exec(ctx, "DELETE FROM "+pgx.Identifier{fixture.table}.Sanitize()); err != nil {
				t.Fatal(err)
			}
		})
	}
	if err := runMigrations(ctx, pool, down); err != nil {
		t.Fatalf("empty batch rollback: %v", err)
	}
	for _, table := range cockpitArtifactTables {
		var exists bool
		if err := pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", schema+"."+table).Scan(&exists); err != nil || exists {
			t.Fatalf("empty rollback retained table %s: %v", table, err)
		}
	}
	if got := ledger(); len(got) != 1 || !got["historical_identity_kept"].Equal(before["historical_identity_kept"]) {
		t.Fatal("batch rollback changed unrelated migration history")
	}
	if err := runMigrations(ctx, pool, options); err != nil {
		t.Fatalf("reapply empty batch: %v", err)
	}
	assertIndexes()
}
