package main

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestCockpitDirectoryBatchPreservesBindingsReceiptsAndRollbackBoundary(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	schema := fmt.Sprintf("cockpit_directory_%d_%d", time.Now().UnixNano(), rand.Uint32())
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
	exec := func(statement string) {
		t.Helper()
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	reject := func(statement string) {
		t.Helper()
		_, err := pool.Exec(ctx, statement)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Fatalf("missing fixed-fact guard for %s: %v", statement, err)
		}
	}
	exec(`CREATE TABLE cockpit_meeting(id uuid,workspace_id uuid,status text,nas_dir text NOT NULL DEFAULT '');
CREATE TABLE cockpit_meeting_work_package(workspace_id uuid,meeting_id uuid,ended_at timestamptz,materials_ready boolean NOT NULL DEFAULT false,released_at timestamptz);
INSERT INTO cockpit_meeting(id,workspace_id,status) VALUES('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','Original meeting');
INSERT INTO cockpit_meeting_work_package(workspace_id,meeting_id,ended_at) VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','2026-01-01T02:03:04Z');`)
	legacy := append([]string{"9066_cockpit_meeting_lifecycle", "9067_cockpit_meeting_agenda_id_idx", "9068_cockpit_meeting_agenda_page_idx", "9069_cockpit_agenda_reference_id_idx", "9070_cockpit_agenda_reference_active_idx", "9071_cockpit_agenda_reference_page_idx", "9072_cockpit_agenda_reference_target_idx", "9073_cockpit_lifecycle_command_key_idx", "9074_cockpit_lifecycle_command_page_idx", "9075_cockpit_meeting_end_authority"}, cockpitPreparationMigrationVersions...)
	opts := runOptions{Direction: "up", Files: realMigrationFiles(t, legacy, "up"), SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Hooks: hooksForDirection("up")}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	var oldLedger string
	if err := pool.QueryRow(ctx, "SELECT string_agg(version||':'||applied_at::text,',' ORDER BY version) FROM schema_migrations").Scan(&oldLedger); err != nil {
		t.Fatal(err)
	}
	opts.Files = realMigrationFiles(t, cockpitDirectoryMigrationVersions, "up")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	var fullLedger string
	if err := pool.QueryRow(ctx, "SELECT string_agg(version||':'||applied_at::text,',' ORDER BY version) FROM schema_migrations").Scan(&fullLedger); err != nil {
		t.Fatal(err)
	}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	var again, after string
	if err := pool.QueryRow(ctx, "SELECT string_agg(version||':'||applied_at::text,',' ORDER BY version) FROM schema_migrations").Scan(&again); err != nil || again != fullLedger {
		t.Fatal("N1 re-up replayed ledger timestamps", err)
	}
	if err := pool.QueryRow(ctx, "SELECT string_agg(version||':'||applied_at::text,',' ORDER BY version) FROM schema_migrations WHERE version=ANY($1)", legacy).Scan(&after); err != nil || after != oldLedger {
		t.Fatal("N1 changed K/L migration identities", err)
	}
	reverse := append([]string(nil), cockpitDirectoryMigrationVersions...)
	for a, b := 0, len(reverse)-1; a < b; a, b = a+1, b-1 {
		reverse[a], reverse[b] = reverse[b], reverse[a]
	}
	down := opts
	down.Direction = "down"
	down.Files = realMigrationFiles(t, reverse, "down")
	down.Hooks = hooksForDirection("down")
	blocked := func() {
		t.Helper()
		if err := runMigrations(ctx, pool, down); err == nil {
			t.Fatal("rollback discarded retained directory authority")
		}
		var indexes int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname LIKE 'cockpit_%' AND i.indisvalid AND i.indisready", schema).Scan(&indexes); err != nil || indexes != 33 {
			t.Fatalf("blocked rollback changed indexes: %d %v", indexes, err)
		}
	}
	exec(`INSERT INTO cockpit_meeting(id,workspace_id,status) VALUES('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','Binding test');
INSERT INTO cockpit_meeting_directory_operation(id,workspace_id,meeting_id,creation_command_key,request_hash,plan_hash,state,root_id,root_path,prepare_subpath,relative_directory,directory,target_hash,root_config_hash,observed_nas_dir,observed_binding_revision,bind_after_base,created_by_type,created_by,credential_owner_user_id,authorizing_user_id,source_relation_kind,source_principal,last_grant_command_key,responsible_user_id,input,receipt)
SELECT '30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002',gen_random_uuid(),repeat('a',64),repeat('b',64),'active',gen_random_uuid(),'/owned','.','meeting','/owned/meeting',repeat('c',64),repeat('d',64),'',1,true,'member',owner,owner,owner,'none','{}',gen_random_uuid(),owner,'{}','{}' FROM(SELECT '40000000-0000-0000-0000-000000000001'::uuid AS owner)x;`)
	blocked()
	for _, statement := range []string{"UPDATE cockpit_meeting_directory_operation SET id=gen_random_uuid()", "UPDATE cockpit_meeting_directory_operation SET directory='/other'", "UPDATE cockpit_meeting_directory_operation SET input='{\"replaced\":true}'", "UPDATE cockpit_meeting_directory_operation SET created_at=created_at+interval '1 second'", "UPDATE cockpit_meeting_directory_operation SET accepted_binding_revision=2"} {
		reject(statement)
	}
	// The original operation observed revision 1. A later explicit grant
	// observes the external binding at revision 2; only its successful base
	// attempt can authorize the resulting revision 3.
	exec(`UPDATE cockpit_meeting SET nas_dir='/owned/external' WHERE id='10000000-0000-0000-0000-000000000002';
INSERT INTO cockpit_meeting_lifecycle_command(workspace_id,meeting_id,command_key,kind,actor_id,request_hash,revision,agenda_revision,receipt,directory_operation_id)
VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','70000000-0000-0000-0000-000000000002','directory_retry','40000000-0000-0000-0000-000000000001',repeat('b',64),2,1,jsonb_build_object('directory',jsonb_build_object('grant',jsonb_build_object('target_hash',repeat('c',64),'observed_binding',jsonb_build_object('nas_dir','/owned/external','revision',2)))),'30000000-0000-0000-0000-000000000001');
INSERT INTO cockpit_meeting_directory_step(id,workspace_id,meeting_id,operation_id,position,kind,label,relative_path,path_hash,grant_command_key,grant_revision)
VALUES('50000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001',0,'base','Fixed base','meeting',repeat('a',64),'70000000-0000-0000-0000-000000000002',2);`)
	reject("UPDATE cockpit_meeting_directory_operation SET accepted_binding_revision=3")
	exec(`INSERT INTO cockpit_meeting_directory_attempt(id,workspace_id,meeting_id,operation_id,step_id,attempt_number,grant_command_key,grant_revision,lease_token,state,finished_at,outcome,observed_at,receipt)
VALUES('60000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001',1,'70000000-0000-0000-0000-000000000002',2,gen_random_uuid(),'succeeded',now(),'created',now(),'{}');
UPDATE cockpit_meeting_directory_step SET state='satisfied',last_attempt_id='60000000-0000-0000-0000-000000000002',last_observed_at=now(),outcome='created' WHERE id='50000000-0000-0000-0000-000000000001';`)
	reject("UPDATE cockpit_meeting_directory_operation SET accepted_binding_revision=3")
	exec(`UPDATE cockpit_meeting SET nas_dir='/owned/meeting' WHERE id='10000000-0000-0000-0000-000000000002';
UPDATE cockpit_meeting_directory_operation SET accepted_binding_revision=3,binding_result='updated';`)
	reject("UPDATE cockpit_meeting_directory_operation SET accepted_binding_revision=2")
	reject("UPDATE cockpit_meeting_directory_operation SET accepted_binding_revision=4")
	reject("UPDATE cockpit_meeting_directory_operation SET accepted_binding_revision=NULL")
	reject("UPDATE cockpit_meeting SET nas_dir_revision=nas_dir_revision+1")
	exec(`UPDATE cockpit_meeting SET status='Ordinary note' WHERE id='10000000-0000-0000-0000-000000000002';`)
	var revision int64
	if err := pool.QueryRow(ctx, "SELECT nas_dir_revision FROM cockpit_meeting WHERE id='10000000-0000-0000-0000-000000000002'").Scan(&revision); err != nil || revision != 3 {
		t.Fatalf("ordinary fields changed binding revision: %d %v", revision, err)
	}
	exec(`UPDATE cockpit_meeting SET nas_dir='/owned/other' WHERE id='10000000-0000-0000-0000-000000000002'; UPDATE cockpit_meeting SET nas_dir='/owned/meeting' WHERE id='10000000-0000-0000-0000-000000000002';`)
	if err := pool.QueryRow(ctx, "SELECT nas_dir_revision FROM cockpit_meeting WHERE id='10000000-0000-0000-0000-000000000002'").Scan(&revision); err != nil || revision != 5 {
		t.Fatalf("ABA lost binding history: %d %v", revision, err)
	}
	exec(`INSERT INTO cockpit_meeting_directory_step(id,workspace_id,meeting_id,operation_id,position,kind,label,relative_path,path_hash,grant_command_key,grant_revision)
VALUES('50000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001',1,'partition','Original path','meeting/photos',repeat('b',64),gen_random_uuid(),1);
INSERT INTO cockpit_meeting_directory_attempt(id,workspace_id,meeting_id,operation_id,step_id,attempt_number,grant_command_key,grant_revision,lease_token,state,finished_at,error_code)
VALUES('60000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000002',1,gen_random_uuid(),1,gen_random_uuid(),'expired',now(),'io_timeout');`)
	for _, statement := range []string{"UPDATE cockpit_meeting_directory_step SET relative_path='other'", "UPDATE cockpit_meeting_directory_step SET label='New meaning'", "UPDATE cockpit_meeting_directory_step SET grant_revision=2 WHERE kind='partition'", "UPDATE cockpit_meeting_directory_step SET lease_token=gen_random_uuid() WHERE kind='partition'", "UPDATE cockpit_meeting_directory_attempt SET grant_command_key=gen_random_uuid()", "UPDATE cockpit_meeting_directory_attempt SET error_code='rewritten'"} {
		reject(statement)
	}
	exec(`UPDATE cockpit_meeting_directory_attempt SET late_receipt='{"outcome":"observed_existing"}',late_observed_at=now();`)
	reject("UPDATE cockpit_meeting_directory_attempt SET late_receipt='{\"outcome\":\"created\"}'")
	exec("DELETE FROM cockpit_meeting_directory_operation")
	blocked()
	exec("DELETE FROM cockpit_meeting_directory_step")
	blocked()
	exec("DELETE FROM cockpit_meeting_directory_attempt")
	blocked()
	exec("DELETE FROM cockpit_meeting_lifecycle_command")
	blocked()
	exec("DELETE FROM cockpit_meeting WHERE id='10000000-0000-0000-0000-000000000002'")
	exec(`INSERT INTO cockpit_meeting_lifecycle_command(workspace_id,meeting_id,command_key,kind,actor_id,request_hash,revision,agenda_revision,receipt,directory_operation_id)
VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',gen_random_uuid(),'directory_prepare',gen_random_uuid(),repeat('a',64),1,1,'{"directory":{}}','30000000-0000-0000-0000-000000000001');`)
	reject("UPDATE cockpit_meeting_lifecycle_command SET receipt='{\"changed\":true}'")
	blocked()
	exec("DELETE FROM cockpit_meeting_lifecycle_command")
	exec(`INSERT INTO cockpit_meeting_lifecycle_command(workspace_id,meeting_id,command_key,kind,actor_id,request_hash,revision,agenda_revision,receipt)
VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',gen_random_uuid(),'schedule',gen_random_uuid(),repeat('b',64),1,1,'{}'); UPDATE cockpit_meeting_lifecycle_command SET receipt='{"legacy":true}';`)
	if err := runMigrations(ctx, pool, down); err != nil {
		t.Fatal("empty directory rollback failed", err)
	}
	var preserved bool
	if err := pool.QueryRow(ctx, "SELECT ended_at='2026-01-01T02:03:04Z'::timestamptz AND ended_source='legacy_confirmation' AND ended_by IS NULL AND actual_ended_at IS NULL FROM cockpit_meeting").Scan(&preserved); err != nil || !preserved {
		t.Fatal("N1 rollback changed original K end authority", err)
	}
	if err := pool.QueryRow(ctx, "SELECT string_agg(version||':'||applied_at::text,',' ORDER BY version) FROM schema_migrations").Scan(&after); err != nil || after != oldLedger {
		t.Fatal("N1 rollback touched K/L ledger", err)
	}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal("empty directory reapply failed", err)
	}
	var actor string
	if err := pool.QueryRow(ctx, "SELECT actor_type FROM cockpit_meeting_lifecycle_command").Scan(&actor); err != nil || actor != "member" {
		t.Fatal("legacy lifecycle actor changed", err)
	}
	t.Log("owned schema: 26 legacy + 13 N1 migrations, 33 valid indexes, fixed facts/ABA/late receipts retained, empty N1 down/up; public unchanged")
}
