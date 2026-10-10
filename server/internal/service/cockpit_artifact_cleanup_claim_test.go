package service

import (
	"context"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
	"testing"
)

func TestCockpitArtifactCleanupClaimLeasesExactlyOneAttempt(t *testing.T) {
	f, _ := newPrincipalFixture(t)
	ctx := context.Background()
	tx, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "LOCK TABLE cockpit_artifact_capture_attempt IN SHARE ROW EXCLUSIVE MODE"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, "UPDATE cockpit_artifact_capture_attempt SET cleanup_next_attempt_at=now()+interval '1 hour' WHERE cleanup_next_attempt_at<=now()"); err != nil {
		t.Fatal(err)
	}
	ws := parseTestUUID(t, f.WorkspaceID)
	ids := []pgtype.UUID{dbid.NewV7(), dbid.NewV7(), dbid.NewV7()}
	q := f.q.WithTx(tx)
	for _, id := range ids {
		if _, err = tx.Exec(ctx, `INSERT INTO cockpit_artifact_capture_attempt(id,workspace_id,artifact_id,version_id,attempt_number,lease_token,lease_expires_at,storage_key,object_url,state,io_finished_at,cleanup_status,cleanup_next_attempt_at)
 VALUES($1,$2,$3,$4,1,$5,now()-interval '1 hour',$6,$7,'failed',now(),'pending','-infinity')`, id, ws, dbid.NewV7(), dbid.NewV7(), dbid.NewV7(), "fixture/"+util.UUIDToString(id), "https://objects.example/"+util.UUIDToString(id)); err != nil {
			t.Fatal(err)
		}
	}
	for remaining := 3; remaining > 0; remaining-- {
		token := dbid.NewV7()
		row, e := q.ClaimCockpitArtifactObjectCleanup(ctx, token)
		if e != nil {
			t.Fatal(e)
		}
		var leased, pending int
		if e = tx.QueryRow(ctx, "SELECT count(*) FILTER(WHERE cleanup_token=$1),count(*) FILTER(WHERE cleanup_status='pending' AND cleanup_token IS NULL) FROM cockpit_artifact_capture_attempt WHERE id=ANY($2::uuid[])", token, ids).Scan(&leased, &pending); e != nil {
			t.Fatal(e)
		}
		if leased != 1 || pending != remaining-1 {
			t.Fatalf("artifact cleanup claim crossed attempts: lease=%d pending=%d", leased, pending)
		}
		if n, e := q.CompleteCockpitArtifactObjectCleanup(ctx, db.CompleteCockpitArtifactObjectCleanupParams{ID: row.ID, CleanupToken: token}); e != nil || n != 1 {
			t.Fatalf("complete artifact claim=%d %v", n, e)
		}
	}
}
