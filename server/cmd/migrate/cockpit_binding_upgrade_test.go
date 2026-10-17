package main

import (
	"context"
	"fmt"
	"math/rand/v2"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

func TestCockpitBindingUpgradeFromMainAndAppliedLegacyIndexes(t *testing.T) {
	admin := openTestPool(t)
	for _, legacy := range []bool{false, true} {
		t.Run(fmt.Sprintf("legacy_indexes_%t", legacy), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			schema := fmt.Sprintf("cockpit_binding_upgrade_%d_%d", time.Now().UnixNano(), rand.Uint32())
			quoted := pgx.Identifier{schema}.Sanitize()
			if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quoted); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+quoted+" CASCADE"); err != nil {
					t.Error(err)
				}
			})
			pool := openTestPoolWithSearchPath(t, schema)
			if _, err := pool.Exec(ctx, `CREATE TABLE cockpit_node(id uuid PRIMARY KEY,cockpit_id uuid NOT NULL);
INSERT INTO cockpit_node VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010');`); err != nil {
				t.Fatal(err)
			}
			if legacy {
				if _, err := pool.Exec(ctx, `ALTER TABLE cockpit_node ADD COLUMN project_id uuid,ADD COLUMN module_id uuid;
CREATE UNIQUE INDEX cockpit_node_project_binding_unique ON cockpit_node(cockpit_id,project_id) WHERE project_id IS NOT NULL AND module_id IS NULL;
CREATE UNIQUE INDEX cockpit_node_module_binding_unique ON cockpit_node(cockpit_id,module_id) WHERE module_id IS NOT NULL;
CREATE TABLE schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());
INSERT INTO schema_migrations(version) VALUES('954_cockpit_node_project_binding_index'),('955_cockpit_node_module_binding_index');`); err != nil {
					t.Fatal(err)
				}
			}
			versions := []string{"954_cockpit_node_project_binding_index", "955_cockpit_node_module_binding_index", "9151_cockpit_node_binding", "9152_cockpit_node_project_binding_index", "9153_cockpit_node_module_binding_index"}
			opts := runOptions{Direction: "up", Files: realMigrationFiles(t, versions, "up"), SchemaMigrationsTable: schema + ".schema_migrations", AdvisoryLockKey: int64(rand.Uint64()&0x7fffffffffffffff) | 1, Conditions: conditionsForDirection("up")}
			for range 2 {
				if err := runMigrations(ctx, pool, opts); err != nil {
					t.Fatal(err)
				}
			}
			for _, name := range []string{"cockpit_node_project_binding_unique", "cockpit_node_module_binding_unique"} {
				assertIndexValidity(t, pool, schema, name, true)
			}
			var rows, applied int
			if err := pool.QueryRow(ctx, "SELECT count(*) FROM cockpit_node").Scan(&rows); err != nil || rows != 1 {
				t.Fatalf("existing node changed: rows=%d err=%v", rows, err)
			}
			if err := pool.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&applied); err != nil || applied != len(versions) {
				t.Fatalf("ledger did not converge: applied=%d err=%v", applied, err)
			}
		})
	}
}
