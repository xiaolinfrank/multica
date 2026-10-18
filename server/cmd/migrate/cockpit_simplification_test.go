package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestCockpitSimplificationPreservesHistoryAndAddsWriteDefaults(t *testing.T) {
	admin := openTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	schema := fmt.Sprintf("meeting_simplification_%d_%d", time.Now().UnixNano(), rand.Uint32())
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
	if _, err := pool.Exec(ctx, `CREATE TABLE cockpit_meeting_lifecycle_command(command_key uuid,agenda_revision bigint NOT NULL,receipt jsonb);
CREATE TABLE cockpit_meeting_preparation_operation(id uuid,authorized_agenda_revision bigint NOT NULL,input jsonb);
INSERT INTO cockpit_meeting_lifecycle_command VALUES(gen_random_uuid(),7,'{"original":"fixed receipt"}');
INSERT INTO cockpit_meeting_preparation_operation VALUES(gen_random_uuid(),9,'{"original":"confirmed intent"}');`); err != nil {
		t.Fatal(err)
	}
	history := []string{"cockpit_meeting_agenda", "cockpit_meeting_agenda_reference", "cockpit_meeting_template", "cockpit_meeting_template_version", "cockpit_artifact_meeting_reference", "cockpit_input_reference", "cockpit_meeting_directory_operation"}
	for _, table := range history {
		name := pgx.Identifier{table}.Sanitize()
		if _, err := pool.Exec(ctx, "CREATE TABLE "+name+"(id uuid,record jsonb); INSERT INTO "+name+" VALUES(gen_random_uuid(),'{\"source\":\"retained history\"}')"); err != nil {
			t.Fatal(err)
		}
	}
	before := map[string]string{}
	snapshot := func(table string) string {
		t.Helper()
		var rows string
		if err := pool.QueryRow(ctx, "SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text FROM "+pgx.Identifier{table}.Sanitize()+" r").Scan(&rows); err != nil {
			t.Fatal(err)
		}
		return rows
	}
	for _, table := range append(history, "cockpit_meeting_lifecycle_command", "cockpit_meeting_preparation_operation") {
		before[table] = snapshot(table)
	}
	opts := runOptions{Direction: "up", Files: realMigrationFiles(t, []string{"9150_cockpit_simplification"}, "up"), SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Hooks: hooksForDirection("up")}
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	for table, want := range before {
		if got := snapshot(table); got != want {
			t.Fatalf("simplification changed %s: got=%s want=%s", table, got, want)
		}
	}
	var lifecycleRevision, preparationRevision int64
	if err := pool.QueryRow(ctx, "INSERT INTO cockpit_meeting_lifecycle_command(command_key,receipt) VALUES(gen_random_uuid(),'{}') RETURNING agenda_revision").Scan(&lifecycleRevision); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "INSERT INTO cockpit_meeting_preparation_operation(id,input) VALUES(gen_random_uuid(),'{}') RETURNING authorized_agenda_revision").Scan(&preparationRevision); err != nil {
		t.Fatal(err)
	}
	if lifecycleRevision != 1 || preparationRevision != 1 {
		t.Fatalf("omitted retired revisions: lifecycle=%d preparation=%d", lifecycleRevision, preparationRevision)
	}
	for table := range before {
		before[table] = snapshot(table)
	}
	opts.Direction, opts.Files, opts.Hooks = "down", realMigrationFiles(t, []string{"9150_cockpit_simplification"}, "down"), hooksForDirection("down")
	if err := runMigrations(ctx, pool, opts); err != nil {
		t.Fatal(err)
	}
	for table, want := range before {
		if got := snapshot(table); got != want {
			t.Fatalf("rollback changed %s: got=%s want=%s", table, got, want)
		}
	}
}
