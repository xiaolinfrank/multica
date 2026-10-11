package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestCockpitInputBatchPreservesLegacyAndRejectsRollbackBeforeFirstIndex(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	schema := fmt.Sprintf("cockpit_input_%d_%d", time.Now().UnixNano(), rand.Uint32())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		clean, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		if _, err := admin.Exec(clean, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	pool := openTestPoolWithSearchPath(t, schema)
	exec := func(sql string) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	exec(`CREATE TABLE issue(id uuid,workspace_id uuid);
CREATE TABLE agent_task_queue(id uuid,issue_id uuid,status text,dispatched_at timestamptz);
CREATE TABLE cockpit_artifact(id uuid,workspace_id uuid);
CREATE TABLE cockpit_artifact_version(id uuid,workspace_id uuid,artifact_id uuid,payload_kind text,content text,storage_key text,content_hash text,size_bytes bigint,capture_status text,producer_run_id uuid,producer_issue_id uuid);
CREATE TABLE cockpit_meeting(id uuid,workspace_id uuid);
INSERT INTO agent_task_queue(id,status) VALUES('10000000-0000-4000-8000-000000000001','completed');
INSERT INTO cockpit_artifact_version(id,capture_status) VALUES('10000000-0000-4000-8000-000000000002','ready');
CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_migrations(version) VALUES('legacy_input_test_sentinel');`)
	var legacy string
	if err := pool.QueryRow(ctx, "SELECT applied_at::text FROM schema_migrations WHERE version='legacy_input_test_sentinel'").Scan(&legacy); err != nil {
		t.Fatal(err)
	}
	up := runOptions{Direction: "up", Files: realMigrationFiles(t, cockpitInputMigrationVersions, "up"), SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Hooks: hooksForDirection("up")}
	if err := runMigrations(ctx, pool, up); err != nil {
		t.Fatal(err)
	}
	ledger := func() string {
		t.Helper()
		var value string
		if err := pool.QueryRow(ctx, "SELECT string_agg(version||':'||applied_at::text,',' ORDER BY version) FROM schema_migrations").Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	original := ledger()
	if err := runMigrations(ctx, pool, up); err != nil || ledger() != original {
		t.Fatalf("N2 repeat up changed migration identities: %v", err)
	}
	var unchanged bool
	if err := pool.QueryRow(ctx, "SELECT input_manifest_version_id IS NULL AND input_preparation_state='not_recorded' FROM agent_task_queue").Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("old Run gained current inputs: %v", err)
	}
	if err := pool.QueryRow(ctx, "SELECT input_manifest_version_id IS NULL FROM cockpit_artifact_version").Scan(&unchanged); err != nil || !unchanged {
		t.Fatalf("old artifact gained fabricated material provenance: %v", err)
	}
	reverse := append([]string{}, cockpitInputMigrationVersions...)
	for a, b := 0, len(reverse)-1; a < b; a, b = a+1, b-1 {
		reverse[a], reverse[b] = reverse[b], reverse[a]
	}
	down := up
	down.Direction = "down"
	down.Files = realMigrationFiles(t, reverse, "down")
	down.Hooks = hooksForDirection("down")
	indexes := func() int {
		t.Helper()
		var n int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND (c.relname LIKE 'idx_cockpit_input_%' OR c.relname='cockpit_input_reference_removal_idx') AND i.indisvalid AND i.indisready", schema).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if n := indexes(); n != 36 {
		t.Fatalf("expected 36 valid N2 indexes, got %d", n)
	}
	blocked := func() {
		t.Helper()
		if err := runMigrations(ctx, pool, down); err == nil {
			t.Fatal("rollback accepted retained input authority")
		}
		if ledger() != original || indexes() != 36 {
			t.Fatal("blocked rollback already dropped an index or ledger entry")
		}
	}
	exec(`INSERT INTO cockpit_input(id,workspace_id,creation_key,request_hash,creation_receipt,title,actor_type,actor_id,credential_owner_user_id,authorizing_user_id)
VALUES('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',gen_random_uuid(),repeat('a',64),'{}','Retained source','member','20000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003');`)
	blocked()
	exec("DELETE FROM cockpit_input")
	exec(`INSERT INTO cockpit_input_transfer(id,workspace_id,input_id,version_id,transfer_number,command_key,request_hash,command_receipt,kind,mode,state,owned_storage_key,expected_bytes,finished_at,workspace_deleted_at,cleanup_state)
VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),1,gen_random_uuid(),repeat('a',64),'{}','source_capture','initial','failed','owned-key-awaiting-cleanup',4,now(),now(),'retry_wait');`)
	blocked()
	exec("DELETE FROM cockpit_input_transfer")
	// Simulate a partially restored schema whose input tables are empty but
	// typed provenance remains. The rollback preflight must fail independently
	// of the normal write guards and before dropping any index.
	exec("ALTER TABLE agent_task_queue DISABLE TRIGGER cockpit_input_task_pin_guard; UPDATE agent_task_queue SET input_manifest_version_id=gen_random_uuid()")
	blocked()
	exec("UPDATE agent_task_queue SET input_manifest_version_id=NULL; ALTER TABLE agent_task_queue ENABLE TRIGGER cockpit_input_task_pin_guard")
	exec("ALTER TABLE cockpit_artifact_version DISABLE TRIGGER cockpit_input_artifact_source_guard; UPDATE cockpit_artifact_version SET input_manifest_version_id=gen_random_uuid()")
	blocked()
	exec("UPDATE cockpit_artifact_version SET input_manifest_version_id=NULL; ALTER TABLE cockpit_artifact_version ENABLE TRIGGER cockpit_input_artifact_source_guard")
	if err := runMigrations(ctx, pool, down); err != nil {
		t.Fatal("empty input rollback", err)
	}
	var restored string
	if err := pool.QueryRow(ctx, "SELECT applied_at::text FROM schema_migrations WHERE version='legacy_input_test_sentinel'").Scan(&restored); err != nil || restored != legacy {
		t.Fatalf("N2 rollback changed legacy ledger: %v", err)
	}
	if err := runMigrations(ctx, pool, up); err != nil {
		t.Fatal("empty input reapply", err)
	}
	t.Log("owned schema only: 38 migration pairs, 36 concurrent indexes, unchanged old Run/artifact provenance, retained intent/tombstone/pin rejection before first index, empty down/up")
}
