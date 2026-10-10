package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestCockpitMeetingLifecycleMigrationKeepsOneEndAuthority(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	schema := fmt.Sprintf("meeting_lifecycle_%d_%d", time.Now().UnixNano(), rand.Uint32())
	quoted := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	pool := openTestPoolWithSearchPath(t, schema)
	if _, err := pool.Exec(ctx, `CREATE TABLE cockpit_meeting(id uuid,workspace_id uuid,status text);
 CREATE TABLE cockpit_meeting_work_package(workspace_id uuid,meeting_id uuid,ended_at timestamptz,materials_ready boolean NOT NULL DEFAULT false,released_at timestamptz);
 INSERT INTO cockpit_meeting VALUES('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','ended'),('10000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','');
 INSERT INTO cockpit_meeting_work_package(workspace_id,meeting_id,ended_at) VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000002','2026-01-01T02:03:04Z');`); err != nil {
		t.Fatal(err)
	}
	versions := []string{"9066_cockpit_meeting_lifecycle", "9067_cockpit_meeting_agenda_id_idx", "9068_cockpit_meeting_agenda_page_idx", "9069_cockpit_agenda_reference_id_idx", "9070_cockpit_agenda_reference_active_idx", "9071_cockpit_agenda_reference_page_idx", "9072_cockpit_agenda_reference_target_idx", "9073_cockpit_lifecycle_command_key_idx", "9074_cockpit_lifecycle_command_page_idx", "9075_cockpit_meeting_end_authority"}
	opts := runOptions{Direction: "up", Files: realMigrationFiles(t, versions, "up"), SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Hooks: hooksForDirection("up")}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	var states []string
	rows, err := pool.Query(ctx, "SELECT occurrence_state FROM cockpit_meeting ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var s string
		if err = rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		states = append(states, s)
	}
	rows.Close()
	if !reflect.DeepEqual(states, []string{"unconfirmed", "ended"}) {
		t.Fatalf("inferred legacy occurrence: %v", states)
	}
	var exact bool
	if err = pool.QueryRow(ctx, "SELECT ended_at='2026-01-01T02:03:04Z'::timestamptz AND ended_source='legacy_confirmation' AND ended_by IS NULL AND actual_started_at IS NULL AND actual_ended_at IS NULL FROM cockpit_meeting WHERE id='10000000-0000-0000-0000-000000000002'").Scan(&exact); err != nil || !exact {
		t.Fatalf("legacy confirmation was relabeled or altered: %v %v", exact, err)
	}
	var oldColumn bool
	if err = pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='cockpit_meeting_work_package' AND column_name='ended_at')", schema).Scan(&oldColumn); err != nil || oldColumn {
		t.Fatalf("dual end storage remains: %v %v", oldColumn, err)
	}
	var applied time.Time
	if err = pool.QueryRow(ctx, "SELECT max(applied_at) FROM schema_migrations").Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err = runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	var again time.Time
	if err = pool.QueryRow(ctx, "SELECT max(applied_at) FROM schema_migrations").Scan(&again); err != nil || !again.Equal(applied) {
		t.Fatalf("reapply replayed ledger: %v", err)
	}
	if _, err = pool.Exec(ctx, "UPDATE cockpit_meeting SET ended_at=NULL,ended_source=NULL,occurrence_state='unconfirmed' WHERE id='10000000-0000-0000-0000-000000000002'"); err == nil {
		t.Fatal("confirmation could be silently cleared")
	}
	if _, err = pool.Exec(ctx, "INSERT INTO cockpit_meeting_work_package(workspace_id,meeting_id,materials_ready,released_at) VALUES('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001',true,now())"); err == nil {
		t.Fatal("release bypassed canonical end")
	}
	if _, err = pool.Exec(ctx, "INSERT INTO cockpit_meeting_lifecycle_command(workspace_id,meeting_id,command_key,kind,actor_id,request_hash,revision,agenda_revision,receipt) VALUES(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'schedule',gen_random_uuid(),repeat('a',64),1,1,'{}')"); err != nil {
		t.Fatal(err)
	}
	reverse := append([]string(nil), versions...)
	for l, r := 0, len(reverse)-1; l < r; l, r = l+1, r-1 {
		reverse[l], reverse[r] = reverse[r], reverse[l]
	}
	down := opts
	down.Direction = "down"
	down.Files = realMigrationFiles(t, reverse, "down")
	down.Hooks = hooksForDirection("down")
	if err = runMigrations(ctx, pool, down); err == nil {
		t.Fatal("rollback discarded a durable command")
	}
	var indexes int
	if err = pool.QueryRow(ctx, "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND i.indisvalid AND i.indisready", schema).Scan(&indexes); err != nil || indexes < 8 {
		t.Fatalf("rejected down removed indexes: %d %v", indexes, err)
	}
	if _, err = pool.Exec(ctx, "DELETE FROM cockpit_meeting_lifecycle_command"); err != nil {
		t.Fatal(err)
	}
	if err = runMigrations(ctx, pool, down); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, "SELECT ended_at='2026-01-01T02:03:04Z'::timestamptz FROM cockpit_meeting_work_package").Scan(&exact); err != nil || !exact {
		t.Fatal("empty new-domain rollback lost original legacy fact", err)
	}
	if err = runMigrations(ctx, pool, opts); err != nil {
		t.Fatalf("complete empty batch reapply: %v", err)
	}
}
