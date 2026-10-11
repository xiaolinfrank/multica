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

func TestCockpitMeetingPreparationMigrationsKeepIntentAndRollbackBoundary(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	schema := fmt.Sprintf("meeting_preparation_%d_%d", time.Now().UnixNano(), rand.Uint32())
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
	if _, err := pool.Exec(ctx, `CREATE TABLE cockpit_meeting(id uuid,workspace_id uuid,status text);
CREATE TABLE cockpit_meeting_work_package(workspace_id uuid,meeting_id uuid,ended_at timestamptz,materials_ready boolean NOT NULL DEFAULT false,released_at timestamptz);
INSERT INTO cockpit_meeting VALUES('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','legacy label');
INSERT INTO cockpit_meeting_work_package(workspace_id,meeting_id,ended_at) VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','2026-01-01T02:03:04Z');`); err != nil {
		t.Fatal(err)
	}
	legacy := []string{"9066_cockpit_meeting_lifecycle", "9067_cockpit_meeting_agenda_id_idx", "9068_cockpit_meeting_agenda_page_idx", "9069_cockpit_agenda_reference_id_idx", "9070_cockpit_agenda_reference_active_idx", "9071_cockpit_agenda_reference_page_idx", "9072_cockpit_agenda_reference_target_idx", "9073_cockpit_lifecycle_command_key_idx", "9074_cockpit_lifecycle_command_page_idx", "9075_cockpit_meeting_end_authority"}
	opts := runOptions{Direction: "up", Files: realMigrationFiles(t, legacy, "up"), SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Hooks: hooksForDirection("up")}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	var oldLedger string
	if err := pool.QueryRow(ctx, "SELECT string_agg(version||':'||applied_at::text,',' ORDER BY version) FROM schema_migrations").Scan(&oldLedger); err != nil {
		t.Fatal(err)
	}
	opts.Files = realMigrationFiles(t, cockpitPreparationMigrationVersions, "up")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := pool.QueryRow(ctx, "SELECT string_agg(version||':'||applied_at::text,',' ORDER BY version) FROM schema_migrations WHERE version=ANY($1)", legacy).Scan(&after); err != nil || after != oldLedger {
		t.Fatalf("L replayed or changed K ledger: %v", err)
	}
	var applied time.Time
	if err := pool.QueryRow(ctx, "SELECT max(applied_at) FROM schema_migrations").Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	var again time.Time
	if err := pool.QueryRow(ctx, "SELECT max(applied_at) FROM schema_migrations").Scan(&again); err != nil || !again.Equal(applied) {
		t.Fatal("reup replayed confirmed migration", err)
	}
	reverse := append([]string(nil), cockpitPreparationMigrationVersions...)
	for l, r := 0, len(reverse)-1; l < r; l, r = l+1, r-1 {
		reverse[l], reverse[r] = reverse[r], reverse[l]
	}
	down := opts
	down.Direction = "down"
	down.Files = realMigrationFiles(t, reverse, "down")
	down.Hooks = hooksForDirection("down")
	assertBlocked := func() {
		t.Helper()
		if err := runMigrations(ctx, pool, down); err == nil {
			t.Fatal("down discarded retained preparation facts")
		}
		var count int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname LIKE 'cockpit_%' AND i.indisvalid AND i.indisready", schema).Scan(&count); err != nil || count != 22 {
			t.Fatalf("blocked rollback changed live indexes: count=%d err=%v", count, err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO cockpit_meeting_template(id,workspace_id,current_version_id,title,is_active,created_by) VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'Independent reusable template',true,gen_random_uuid())`); err != nil {
		t.Fatal(err)
	}
	assertBlocked()
	if _, err := pool.Exec(ctx, "DELETE FROM cockpit_meeting_template"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO cockpit_meeting_preparation_operation(id,workspace_id,meeting_id,kind,command_key,request_hash,context_token,input,authorized_lifecycle_revision,authorized_agenda_revision,created_by,responsible_user_id)
VALUES('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','cancel_preparation',gen_random_uuid(),repeat('a',64),repeat('b',64),'{}',1,1,gen_random_uuid(),gen_random_uuid());
INSERT INTO cockpit_meeting_preparation_effect(id,workspace_id,meeting_id,operation_id,slot_id,position,kind,label,command_key,request_hash,input,authorization_key,authorization_hash,authorization_snapshot)
VALUES('40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',gen_random_uuid(),0,'cancel_issue','Keep this fixed intent',gen_random_uuid(),repeat('a',64),'{}',gen_random_uuid(),repeat('b',64),'{}')`); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		"UPDATE cockpit_meeting_preparation_effect SET id=gen_random_uuid()",
		"UPDATE cockpit_meeting_preparation_effect SET created_at=created_at+interval '1 second'",
		"UPDATE cockpit_meeting_preparation_effect SET label='Replaced meaning'",
		"UPDATE cockpit_meeting_preparation_effect SET input='{" + `"different"` + ":true}'",
		"UPDATE cockpit_meeting_preparation_effect SET authorization_key=gen_random_uuid(),authorization_revision=2",
		"UPDATE cockpit_meeting_preparation_operation SET input='{" + `"different"` + ":true}'",
		"UPDATE cockpit_meeting_preparation_operation SET created_by=gen_random_uuid()",
	} {
		_, err := pool.Exec(ctx, statement)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != "23514" {
			t.Fatalf("fixed intent was not protected by the intended guard: %s: %v", statement, err)
		}
	}
	assertBlocked()
	if _, err := pool.Exec(ctx, "DELETE FROM cockpit_meeting_preparation_operation"); err != nil {
		t.Fatal(err)
	}
	assertBlocked()
	if _, err := pool.Exec(ctx, "DELETE FROM cockpit_meeting_preparation_effect"); err != nil {
		t.Fatal(err)
	}
	if err := runMigrations(ctx, pool, down); err != nil {
		t.Fatal("empty L rollback failed", err)
	}
	var exact bool
	if err := pool.QueryRow(ctx, "SELECT ended_at='2026-01-01T02:03:04Z'::timestamptz AND ended_source='legacy_confirmation' AND occurrence_state='ended' AND actual_ended_at IS NULL FROM cockpit_meeting").Scan(&exact); err != nil || !exact {
		t.Fatal("L rollback altered the existing end authority", err)
	}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal("empty L reapply failed", err)
	}
}
