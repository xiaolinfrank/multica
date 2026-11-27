package migrations

import (
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/multica-ai/multica/server/internal/workspacecontext"
)

func TestWorkspaceContextDefaultMatchesFrozenV2(t *testing.T) {
	sql := readMigrationFile(t, "9166_workspace_collaboration_context_v2.up.sql")
	parts := strings.Split(sql, "$workspace_context_v2$")
	if len(parts) != 3 || parts[1] != workspacecontext.V2 {
		t.Fatal("new-workspace default and frozen upgrade text diverged")
	}
}

func TestWorkspaceContextMigrationPreservesUserData(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("requires isolated Postgres at DATABASE_URL")
	}
	conn, err := pgx.Connect(t.Context(), dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(t.Context())
	// A temporary table shadows the production name for this connection only.
	if _, err := conn.Exec(t.Context(), `CREATE TEMP TABLE workspace (
		id integer PRIMARY KEY, context text, updated_at timestamptz DEFAULT '2000-01-01'
	); INSERT INTO workspace (id, context) VALUES
		(1, NULL), (2, ''), (3, E' \t\n\r'), (4, '  Custom user rules  ');`); err != nil {
		t.Fatal(err)
	}
	up := readMigrationFile(t, "9158_workspace_collaboration_context_v1.up.sql")
	seededV1 := dollarQuoted(t, up, "$workspace_context_v1$")
	if _, err := conn.Exec(t.Context(), up); err != nil {
		t.Fatal(err)
	}
	for id := 1; id <= 4; id++ {
		var got string
		var changed bool
		if err := conn.QueryRow(t.Context(), "SELECT context, updated_at <> '2000-01-01' FROM workspace WHERE id=$1", id).Scan(&got, &changed); err != nil {
			t.Fatal(err)
		}
		want := seededV1
		if id == 4 {
			want = "  Custom user rules  "
		}
		if got != want || changed != (id != 4) {
			t.Fatalf("row %d context/timestamp mismatch; custom data must remain byte-identical", id)
		}
	}
	// Retrying the guarded update and rolling back must preserve later edits.
	if _, err := conn.Exec(t.Context(), "UPDATE workspace SET context='Owner edited the seeded context' WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	for _, sql := range []string{up, readMigrationFile(t, "9158_workspace_collaboration_context_v1.down.sql")} {
		if _, err := conn.Exec(t.Context(), sql); err != nil {
			t.Fatal(err)
		}
	}
	var edited string
	if err := conn.QueryRow(t.Context(), "SELECT context FROM workspace WHERE id=1").Scan(&edited); err != nil || edited != "Owner edited the seeded context" {
		t.Fatalf("retry/rollback changed user context: %v", err)
	}
}

func dollarQuoted(t *testing.T, sql, tag string) string {
	t.Helper()
	parts := strings.Split(sql, tag)
	if len(parts) != 3 {
		t.Fatalf("expected one %s literal", tag)
	}
	return parts[1]
}

// Only a context the platform seeded moves to v2; an edited one stays.
func TestWorkspaceContextV2MigrationReplacesOnlySeededText(t *testing.T) {
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		t.Skip("requires isolated Postgres at DATABASE_URL")
	}
	conn, err := pgx.Connect(t.Context(), dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(t.Context())
	up := readMigrationFile(t, "9166_workspace_collaboration_context_v2.up.sql")
	seeded := []string{
		dollarQuoted(t, up, "$workspace_context_v1$"),
		dollarQuoted(t, up, "$workspace_context_v1_work_item$"),
	}
	frozen := dollarQuoted(t, readMigrationFile(t, "9158_workspace_collaboration_context_v1.up.sql"), "$workspace_context_v1$")
	if seeded[0] != frozen {
		t.Fatal("v2 upgrade does not match the text 9158 seeded")
	}
	edited := seeded[1] + "Owner rule"
	if _, err := conn.Exec(t.Context(), `CREATE TEMP TABLE workspace (
		id integer PRIMARY KEY, context text, updated_at timestamptz DEFAULT '2000-01-01'
	)`); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(t.Context(), "INSERT INTO workspace (id, context) VALUES (1, $1), (2, $2), (3, $3)", seeded[0], seeded[1], edited); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Exec(t.Context(), up); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[int]string{1: workspacecontext.V2, 2: workspacecontext.V2, 3: edited} {
		var got string
		if err := conn.QueryRow(t.Context(), "SELECT context FROM workspace WHERE id=$1", id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("workspace %d context was not handled as expected", id)
		}
	}
}
