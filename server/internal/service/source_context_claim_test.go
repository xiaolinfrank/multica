package service

import (
	"context"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"testing"
)

func TestSourceContextIntentClaimLeasesExactlyOneRow(t *testing.T) {
	f, _ := newPrincipalFixture(t)
	ctx := context.Background()
	lockSourceContextCleanupTests(t, f.Pool)
	tx, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "LOCK TABLE issue_source_context_object_intent IN SHARE ROW EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	// Isolate the global sweeper's candidates without changing other fixtures:
	// every park and claim in this transaction is rolled back at the end.
	if _, err = tx.Exec(ctx, "UPDATE issue_source_context_object_intent SET next_attempt_at=now()+interval '1 hour' WHERE next_attempt_at<=now()"); err != nil {
		t.Fatal(err)
	}
	q := f.q.WithTx(tx)
	ws := parseTestUUID(t, f.WorkspaceID)
	keys := []string{}
	for _, suffix := range []string{"a", "b", "c"} {
		key := "source-context-single-claim/" + util.UUIDToString(dbid.NewV7()) + "/" + suffix
		keys = append(keys, key)
		if _, err = q.RecordSourceContextObjectIntent(ctx, db.RecordSourceContextObjectIntentParams{StorageKey: key, WorkspaceID: ws, SourceContextID: dbid.NewV7(), AttachmentID: dbid.NewV7(), ObjectUrl: "https://objects.example/" + key}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = tx.Exec(ctx, "UPDATE issue_source_context_object_intent SET created_at=now()-interval '2 hours',next_attempt_at='-infinity'::timestamptz WHERE storage_key=ANY($1::text[])", keys); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for remaining := 3; remaining > 0; remaining-- {
		token := dbid.NewV7()
		row, e := q.ClaimSourceContextObjectIntentForCleanup(ctx, token)
		if e != nil {
			t.Fatal(e)
		}
		if row.LeaseToken != token || seen[row.StorageKey] {
			t.Fatal("claim returned the wrong lease or repeated an active row")
		}
		seen[row.StorageKey] = true
		var leased, pending int
		if e = tx.QueryRow(ctx, "SELECT count(*) FILTER(WHERE lease_token=$1),count(*) FILTER(WHERE state='pending' AND lease_token IS NULL) FROM issue_source_context_object_intent WHERE storage_key=ANY($2::text[])", token, keys).Scan(&leased, &pending); e != nil {
			t.Fatal(e)
		}
		if leased != 1 || pending != remaining-1 {
			t.Fatalf("one claim modified multiple candidates: lease rows=%d pending=%d want1/%d", leased, pending, remaining-1)
		}
		if changed, e := q.DeleteClaimedSourceContextObjectIntent(ctx, db.DeleteClaimedSourceContextObjectIntentParams{StorageKey: row.StorageKey, WorkspaceID: ws, LeaseToken: token}); e != nil || changed != 1 {
			t.Fatalf("settling one claim changed %d rows: %v", changed, e)
		}
	}
	if len(seen) != 3 {
		t.Fatal("single-row leases lost due work")
	}
}
