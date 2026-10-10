//go:build cockpitscale

package service

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Exercise page-sized roots with protected subtrees on the isolated test host.
func TestIssueOperationBasisReadScale(t *testing.T) {
	if os.Getenv("MULTICA_RUN_ISSUE_POLICY_SCALE") != "1" {
		t.Skip("requires explicit agent3 operation-basis scale opt-in")
	}
	u, err := url.Parse(os.Getenv("TEST_DATABASE_URL"))
	if err != nil || os.Getenv("DATABASE_URL") != os.Getenv("TEST_DATABASE_URL") || !strings.HasSuffix(u.Path, "_test") || os.Getenv("USER") != "fosun_agent_3" {
		t.Fatal("requires agent3 and dedicated TEST_DATABASE_URL")
	}
	var fixture *artifactFixture
	t.Cleanup(func() {
		if fixture != nil {
			fixture.Exec(t, "DELETE FROM search_index_change WHERE workspace_id=$1", fixture.ws)
		}
	})
	f := newArtifactFixture(t)
	fixture = &f
	t.Logf("owned operation-basis fixture workspace=%s", f.WorkspaceID)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		tx, e := f.Pool.Begin(ctx)
		if e != nil {
			t.Error(e)
			return
		}
		defer tx.Rollback(ctx)
		if e = f.q.WithTx(tx).DeleteCockpitArtifactsByWorkspace(ctx, f.ws); e != nil {
			t.Error(e)
			return
		}
		for _, table := range []string{"cockpit_issue_primary", "cockpit_meeting_action", "cockpit_reviewer_handoff", "cockpit_minutes_version", "cockpit_meeting_work_package", "cockpit_meeting_issue", "cockpit_node_issue", "activity_log", "issue", "search_index_change"} {
			if _, e = tx.Exec(ctx, "DELETE FROM "+table+" WHERE workspace_id=$1", f.ws); e != nil {
				t.Errorf("cleanup %s: %v", table, e)
				return
			}
		}
		if e = tx.Commit(ctx); e != nil {
			t.Error(e)
		}
	})
	f.Exec(t, `INSERT INTO issue(id,workspace_id,number,title,status,priority,creator_type,creator_id,project_id,module_id)
 SELECT gen_random_uuid(),$1,100000+g,'Policy root '||g,'todo','none','member',$2,$3,$4 FROM generate_series(1,100) g`, f.ws, f.owner, f.project, f.module)
	f.Exec(t, `INSERT INTO issue(id,workspace_id,number,title,status,priority,creator_type,creator_id,project_id,module_id,parent_issue_id)
 SELECT gen_random_uuid(),$1,200000+g,'Policy child '||g,'todo','none','member',$2,$3,$4,p.id FROM generate_series(1,10000) g JOIN issue p ON p.workspace_id=$1 AND p.number=100001+(g-1)/100`, f.ws, f.owner, f.project, f.module)
	f.Exec(t, `INSERT INTO cockpit_issue_primary(issue_id,workspace_id,node_id,created_by,updated_by)
 SELECT id,$1,$2,$3,$3 FROM issue WHERE workspace_id=$1 AND number>200000 AND number<=210000 AND number%100=0`, f.ws, f.a, f.owner)
	f.Exec(t, `UPDATE issue SET parent_issue_id=(SELECT id FROM issue WHERE workspace_id=$1 AND number=100001) WHERE id=$2`, f.ws, f.producer)
	f.Exec(t, "ANALYZE issue, cockpit_issue_primary, cockpit_artifact")
	rows, err := f.Pool.Query(context.Background(), "SELECT id FROM issue WHERE workspace_id=$1 AND number>100000 AND number<=100100 ORDER BY number", f.ws)
	if err != nil {
		t.Fatal(err)
	}
	ids := []pgtype.UUID{}
	for rows.Next() {
		var id pgtype.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if rows.Err() != nil {
		t.Fatal(rows.Err())
	}
	if len(ids) != 100 {
		t.Fatal("scale root fixture incomplete")
	}
	samples := []float64{}
	maxBytes := 0
	for n := 0; n < 21; n++ {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		start := time.Now()
		out, e := f.issues.ListIssueOperationBasis(ctx, IssueOperationBasisQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true, IssueIDs: ids})
		cancel()
		if e != nil {
			t.Fatal(e)
		}
		raw, e := json.Marshal(out)
		if e != nil {
			t.Fatal(e)
		}
		samples = append(samples, float64(time.Since(start).Microseconds())/1000)
		if len(raw) > maxBytes {
			maxBytes = len(raw)
		}
		if len(out.Items) != 100 {
			t.Fatal("large page lost roots")
		}
		for i, b := range out.Items {
			if b.Scope.State != "blocked" || b.Delete.State != "allowed" || b.TargetsTotal < 1 || len(b.Targets) > 3 {
				t.Fatalf("root%d incomplete: %+v", i, b)
			}
		}
	}
	first := samples[0]
	warm := append([]float64(nil), samples[1:]...)
	sort.Float64s(warm)
	report := map[string]any{"workspace_id": f.WorkspaceID, "roots": 100, "children": 10000, "analyze": true, "first_observation_ms": first, "warm_p50_ms": warm[9], "warm_p95_ms": warm[18], "samples_ms": samples, "max_payload_bytes": maxBytes, "os_cold_cache": false}
	payload, _ := json.Marshal(report)
	t.Logf("operation-basis scale %s", payload)
	if warm[18] > 2000 {
		t.Fatalf("100-root policy p95 %.2fms exceeds 2s inspection budget", warm[18])
	}
}
