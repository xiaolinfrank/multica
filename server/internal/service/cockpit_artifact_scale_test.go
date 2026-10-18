//go:build cockpitscale

package service

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/multica-ai/multica/server/internal/util"
	"math"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// This fixture is deliberately separate from the plan/meeting scale fixture.
// Build locally with -c; execute only on agent3's exclusive test database.
func TestCockpitArtifactReadScale(t *testing.T) {
	if os.Getenv("MULTICA_RUN_COCKPIT_ARTIFACT_SCALE") != "1" {
		t.Skip("set MULTICA_RUN_COCKPIT_ARTIFACT_SCALE=1 on isolated agent3")
	}
	parsed, err := url.Parse(os.Getenv("TEST_DATABASE_URL"))
	if err != nil || os.Getenv("DATABASE_URL") != os.Getenv("TEST_DATABASE_URL") || !strings.HasSuffix(parsed.Path, "_test") || os.Getenv("USER") != "fosun_agent_3" {
		t.Fatal("artifact scale requires the agent3 account and the dedicated TEST_DATABASE_URL, never an application database")
	}
	const versions = 200000
	const additionalArtifacts = 100
	const mainVersions = versions - additionalArtifacts
	var finalFixture *artifactFixture
	var writeReport func()
	t.Cleanup(func() {
		if finalFixture != nil {
			finalFixture.Exec(t, "DELETE FROM search_index_change WHERE workspace_id=$1", finalFixture.ws)
		}
		if writeReport != nil {
			writeReport()
		}
	})
	f := newArtifactFixture(t)
	finalFixture = &f
	ctx := context.Background()
	t.Logf("artifact scale owned workspace=%s", f.WorkspaceID)
	var cleanupMS float64
	var cleanupComplete bool
	// Register complete teardown before any bulk insertion. The fixture contains
	// text only: no artifact object intent, Agent task or NAS path is created.
	t.Cleanup(func() {
		cleanupStart := time.Now()
		defer func() { cleanupMS = float64(time.Since(cleanupStart).Microseconds()) / 1000 }()
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		tx, e := f.Pool.Begin(cleanup)
		if e != nil {
			t.Errorf("begin scale cleanup: %v", e)
			return
		}
		defer tx.Rollback(cleanup)
		q := f.q.WithTx(tx)
		if e = q.SetWorkspaceTeardownMode(cleanup); e != nil {
			t.Errorf("cleanup mode: %v", e)
			return
		}
		if e = q.DeleteCockpitArtifactsByWorkspace(cleanup, f.ws); e != nil {
			t.Errorf("artifact scale domain cleanup: %v", e)
			return
		}
		if _, e = tx.Exec(cleanup, "DELETE FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id=$1)", f.ws); e != nil {
			t.Errorf("cleanup task references: %v", e)
			return
		}
		tables := []string{"cockpit_issue_primary", "cockpit_meeting_action", "cockpit_reviewer_handoff", "cockpit_minutes_version", "cockpit_meeting_work_package", "cockpit_meeting_issue", "cockpit_node_issue", "cockpit_meeting_node", "activity_log", "issue", "search_index_change", "cockpit_meeting", "cockpit_node"}
		for _, table := range tables {
			if _, e = tx.Exec(cleanup, "DELETE FROM "+table+" WHERE workspace_id=$1", f.ws); e != nil {
				t.Errorf("cleanup %s: %v", table, e)
				return
			}
		}
		if e = tx.Commit(cleanup); e != nil {
			t.Errorf("commit scale cleanup: %v", e)
			return
		}
		cleanupComplete = true
		for _, table := range []string{"cockpit_artifact", "cockpit_artifact_version", "cockpit_artifact_node_reference", "cockpit_issue_primary", "issue", "search_index_change"} {
			if n := f.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", f.ws); n != 0 {
				cleanupComplete = false
				t.Errorf("owned scale tenant retained %d %s rows", n, table)
			}
		}
	})
	seedStart := time.Now()
	artifactIDs := make([]pgtype.UUID, 0, additionalArtifacts)
	for i := 0; i < additionalArtifacts; i++ {
		id, e := f.issues.CreateCockpitArtifact(ctx, CockpitArtifactCreate{WorkspaceID: f.ws, ActorID: f.owner, NodeID: f.a, SourceIssueID: f.producer, ReviewerID: f.owner, CreationKey: dbid.NewV7(), Title: fmt.Sprintf("Scale deliverable %03d", i+1), Human: true})
		if e != nil {
			t.Fatal(e)
		}
		artifactIDs = append(artifactIDs, id)
	}
	small, large := strings.Repeat("e", 4096), strings.Repeat("E", 65536)
	f.Exec(t, `INSERT INTO issue(id,workspace_id,number,title,status,priority,creator_type,creator_id,assignee_type,assignee_id,project_id,module_id,position)
 SELECT gen_random_uuid(),$1,1000000+g,'Artifact scale human review '||g,'done','none','member',$2,'member',$2,$3,$4,g FROM generate_series(1,200000) g`, f.ws, f.owner, f.project, f.module)
	f.Exec(t, "ANALYZE issue, cockpit_node, cockpit_artifact")
	f.Exec(t, `INSERT INTO cockpit_artifact_version(id,workspace_id,artifact_id,version_number,submission_key,request_hash,revision,producer_issue_id,producer_issue_identifier,producer_issue_title,payload_kind,content,size_bytes,content_type,content_hash,capture_status,decision,reviewer_id,review_issue_id,reviewed_by,reviewed_at,submitted_by_type,submitted_by_id,submitted_by_user_id)
 SELECT gen_random_uuid(),$1,CASE WHEN i.number-1000000<=$5 THEN $3::uuid ELSE ($4::uuid[])[i.number-1000000-$5] END,
 CASE WHEN i.number-1000000<=$5 THEN i.number-1000000 ELSE 1 END,gen_random_uuid(),'isolated-scale-fixture',2,$6,w.issue_prefix||'-'||source.number::text,source.title,
 'text',CASE WHEN (i.number-1000000)%4=0 THEN $8 ELSE $7 END,CASE WHEN (i.number-1000000)%4=0 THEN 65536 ELSE 4096 END,'text/markdown; charset=utf-8',CASE WHEN (i.number-1000000)%4=0 THEN $10 ELSE $9 END,'ready','approved',$2,i.id,$2,now(),'member',$2,$2
 FROM issue i JOIN workspace w ON w.id=i.workspace_id JOIN issue source ON source.workspace_id=i.workspace_id AND source.id=$6
 WHERE i.workspace_id=$1 AND i.number>1000000 AND i.number<=1200000`, f.ws, f.owner, f.artifact, artifactIDs, mainVersions, f.producer, small, large, minutesContentHash(small), minutesContentHash(large))
	f.Exec(t, "ANALYZE cockpit_artifact_version")
	f.Exec(t, `UPDATE cockpit_artifact a SET current_version_id=(SELECT id FROM cockpit_artifact_version v WHERE v.workspace_id=a.workspace_id AND v.artifact_id=a.id ORDER BY version_number DESC LIMIT 1),
 approved_version_id=(SELECT id FROM cockpit_artifact_version v WHERE v.workspace_id=a.workspace_id AND v.artifact_id=a.id ORDER BY version_number DESC LIMIT 1),revision=1+2*(SELECT count(*) FROM cockpit_artifact_version v WHERE v.workspace_id=a.workspace_id AND v.artifact_id=a.id) WHERE a.workspace_id=$1`, f.ws)
	f.Exec(t, `INSERT INTO cockpit_issue_primary(issue_id,workspace_id,node_id,created_by,updated_by)
 SELECT i.id,$1,$2,$3,$3 FROM issue i WHERE i.workspace_id=$1 AND i.number>1000000 AND i.number<=1200000`, f.ws, f.a, f.owner)
	f.Exec(t, "ANALYZE cockpit_issue_primary, cockpit_artifact, cockpit_artifact_version")
	for _, id := range artifactIDs {
		a, e := f.q.GetCockpitArtifact(ctx, db.GetCockpitArtifactParams{WorkspaceID: f.ws, ID: id})
		if e != nil {
			t.Fatal(e)
		}
		if _, e = f.issues.CreateCockpitArtifactReference(ctx, CockpitArtifactReferenceCommand{CockpitArtifactCommand: CockpitArtifactCommand{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: id, Human: true}, ReferenceKey: dbid.NewV7(), VersionID: a.ApprovedVersionID, NodeID: f.b, Purpose: "evidence"}, "node"); e != nil {
			t.Fatal(e)
		}
	}
	f.Exec(t, "ANALYZE cockpit_artifact_node_reference")
	if count := f.Count(t, "SELECT count(*) FROM cockpit_artifact_version WHERE workspace_id=$1", f.ws); count != versions {
		t.Fatalf("fixed versions=%d want200000", count)
	}
	if count := f.Count(t, "SELECT count(*) FROM issue WHERE workspace_id=$1 AND number>1000000 AND number<=1200000", f.ws); count != versions {
		t.Fatalf("independent Review Issues=%d want200000", count)
	}
	if count := f.Count(t, "SELECT count(*) FROM agent_task_queue WHERE issue_id IN (SELECT id FROM issue WHERE workspace_id=$1)", f.ws); count != 0 {
		t.Fatalf("synthetic human review fixture dispatched %d Agent tasks", count)
	}
	read := CockpitArtifactRead{WorkspaceID: f.ws, ActorID: f.owner, ArtifactID: f.artifact, Human: true, PageSize: 25}
	versionsPage, err := f.issues.ListCockpitArtifactVersions(ctx, read)
	if err != nil {
		t.Fatal(err)
	}
	if versionsPage.NextCursor == nil {
		t.Fatal("large version history has no continuation")
	}
	continuation := read
	continuation.Cursor = *versionsPage.NextCursor
	historicalRows, err := f.q.ListCockpitArtifactVersionMetadata(ctx, db.ListCockpitArtifactVersionMetadataParams{WorkspaceID: f.ws, ArtifactID: f.artifact, BeforeNumber: pgtype.Int4{Int32: 5, Valid: true}, PageLimit: 1})
	if err != nil || len(historicalRows) != 1 {
		t.Fatalf("historical fixed version missing: %v", err)
	}
	bodyRead := read
	bodyRead.VersionID = historicalRows[0].ID
	batchRead := CockpitArtifactRead{WorkspaceID: f.ws, ActorID: f.owner, Human: true, NodeID: f.b, ProjectID: f.project, ModuleID: f.module, Relation: "all", IDs: artifactIDs, PageSize: 100}
	type measurement struct {
		Name     string    `json:"name"`
		FirstMS  float64   `json:"first_ms"`
		WarmMS   []float64 `json:"warm_ms"`
		P50MS    float64   `json:"p50_ms"`
		P95MS    float64   `json:"p95_ms"`
		MaxBytes int       `json:"max_bytes"`
		Error    string    `json:"error,omitempty"`
	}
	report := struct {
		WorkspaceID                                                                       string  `json:"workspace_id"`
		SeedMS                                                                            float64 `json:"seed_ms"`
		Versions, Artifacts, HumanReviews, SmallBodyBytes, LargeBodyBytes, LargeBodyCount int
		CacheNote, StatisticsNote                                                         string
		CleanupMS                                                                         float64 `json:"cleanup_ms"`
		CleanupComplete                                                                   bool    `json:"cleanup_complete"`
		Failed                                                                            bool    `json:"failed"`
		Measurements                                                                      []measurement
	}{WorkspaceID: f.WorkspaceID, SeedMS: float64(time.Since(seedStart).Microseconds()) / 1000, Versions: versions, Artifacts: additionalArtifacts + 1, HumanReviews: versions, SmallBodyBytes: 4096, LargeBodyBytes: 65536, LargeBodyCount: versions / 4, CacheNote: "First timed observation follows fixture and continuation preparation; it is not an OS/PostgreSQL cold-cache flush. Repetitive synthetic UTF-8 bodies; service read + JSON encoding, no HTTP or browser transport.", StatisticsNote: "Explicit ANALYZE after bulk Issue/version/primary/reference inserts. Default plan_cache_mode and work_mem; no global settings changed."}
	writeReport = func() {
		report.CleanupMS = cleanupMS
		report.CleanupComplete = cleanupComplete
		report.Failed = t.Failed()
		body, e := json.MarshalIndent(report, "", "  ")
		if e != nil {
			t.Error(e)
			return
		}
		t.Logf("COCKPIT_ARTIFACT_SCALE_REPORT=%s", body)
		if path := os.Getenv("MULTICA_COCKPIT_ARTIFACT_SCALE_REPORT"); path != "" {
			if e = os.WriteFile(path, body, 0600); e != nil {
				t.Error(e)
			}
		}
	}
	checks := []struct {
		name string
		run  func(context.Context) (any, error)
	}{
		{"artifact_header", func(c context.Context) (any, error) { return f.issues.GetCockpitArtifact(c, read) }},
		{"version_metadata_first25", func(c context.Context) (any, error) { return f.issues.ListCockpitArtifactVersions(c, read) }},
		{"version_metadata_next25", func(c context.Context) (any, error) { return f.issues.ListCockpitArtifactVersions(c, continuation) }},
		{"fixed_historical_64k_body", func(c context.Context) (any, error) { return f.issues.GetCockpitArtifactVersion(c, bodyRead) }},
		{"source_issue_context25", func(c context.Context) (any, error) {
			return f.issues.ListCockpitIssueArtifactContexts(c, f.ws, f.producer, f.owner, "", 25)
		}},
		{"node_evidence_restore100", func(c context.Context) (any, error) { return f.issues.ListCockpitArtifacts(c, batchRead) }},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			m := measurement{Name: check.name}
			defer func() { report.Measurements = append(report.Measurements, m) }()
			for round := 0; round <= 20; round++ {
				start := time.Now()
				bounded, cancel := context.WithTimeout(ctx, 25*time.Second)
				value, e := check.run(bounded)
				cancel()
				if e != nil {
					m.Error = e.Error()
					t.Fatal(e)
				}
				encoded, e := json.Marshal(value)
				if e != nil {
					m.Error = e.Error()
					t.Fatal(e)
				}
				ms := float64(time.Since(start).Microseconds()) / 1000
				if round == 0 {
					m.FirstMS = ms
					switch v := value.(type) {
					case CockpitArtifactHeader:
						if v.VersionCount != mainVersions || v.CurrentVersion == nil || v.ApprovedVersion == nil {
							t.Fatal("header lost fixed version pins")
						}
					case CockpitArtifactVersionPage:
						if len(v.Items) != 25 || v.Total != mainVersions || v.NextCursor == nil {
							t.Fatal("version metadata pagination/count drift")
						}
						for _, item := range v.Items {
							if item.CaptureStatus != "ready" || item.Decision != "approved" {
								t.Fatal("metadata state drift")
							}
						}
					case CockpitArtifactVersionDetail:
						if v.Content == nil || len(*v.Content) != 65536 || !v.ContentAvailable || v.Version.VersionNumber != 4 {
							t.Fatal("historical body changed or reader followed current pin")
						}
					case CockpitIssueArtifactContextPage:
						if len(v.Items) != 25 || v.Total != versions+additionalArtifacts+1 || v.FormalReview != nil {
							t.Fatalf("source-context aggregate drift: %d", v.Total)
						}
					case CockpitArtifactPage:
						if len(v.Items) != 100 || v.Total != 100 || v.FilteredTotal != 100 || v.NextCursor != nil {
							t.Fatal("bounded evidence restore lost candidates")
						}
						for _, item := range v.Items {
							if item.EvidenceVersion == nil {
								t.Fatal("explicit target reference lost evidence eligibility")
							}
						}
					}
				} else {
					m.WarmMS = append(m.WarmMS, ms)
				}
				if len(encoded) > m.MaxBytes {
					m.MaxBytes = len(encoded)
				}
			}
			ordered := append([]float64(nil), m.WarmMS...)
			sort.Float64s(ordered)
			m.P50MS = ordered[int(math.Ceil(float64(len(ordered))*.5))-1]
			m.P95MS = ordered[int(math.Ceil(float64(len(ordered))*.95))-1]
			t.Logf("first %.3fms warm p50 %.3fms p95 %.3fms payload %dB", m.FirstMS, m.P50MS, m.P95MS, m.MaxBytes)
		})
	}
	if path := os.Getenv("MULTICA_COCKPIT_ARTIFACT_GUARD_EXPLAIN"); path != "" {
		t.Run("post_sample_generic_guard_plan", func(t *testing.T) { captureArtifactGuardScalePlan(t, f, historicalRows[0].ReviewIssueID, path) })
	}
}

// Diagnostics run after every timed sample, in their own read-only transaction.
// A transaction-local generic plan never changes the measured service sessions.
func captureArtifactGuardScalePlan(t *testing.T, f artifactFixture, issue pgtype.UUID, path string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	tx, err := f.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, "SET TRANSACTION READ ONLY"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, "SET LOCAL plan_cache_mode=force_generic_plan"); err != nil {
		t.Fatal(err)
	}
	var source string
	if err = tx.QueryRow(ctx, "SELECT prosrc FROM pg_proc WHERE oid='cockpit_artifact_references_issue(uuid,uuid)'::regprocedure").Scan(&source); err != nil {
		t.Fatal(err)
	}
	source = strings.TrimSpace(source)
	if !strings.HasPrefix(source, "SELECT ") || strings.Contains(source, ";") {
		t.Fatal("unexpected guard definition for read-only diagnostics")
	}
	source = regexp.MustCompile(`\bws\b`).ReplaceAllStringFunc(source, func(string) string { return "$1" })
	source = regexp.MustCompile(`\bissue_uuid\b`).ReplaceAllStringFunc(source, func(string) string { return "$2" })
	name := "cockpit_guard_scale_" + strings.ReplaceAll(util.UUIDToString(dbid.NewV7()), "-", "")
	if _, err = tx.Exec(ctx, "PREPARE "+name+"(uuid,uuid) AS "+source); err != nil {
		t.Fatal(err)
	}
	defer tx.Exec(context.Background(), "DEALLOCATE "+name)
	// Both literals are trusted UUID round-trips; neither contains SQL syntax.
	query := fmt.Sprintf("EXPLAIN (ANALYZE,VERBOSE,FORMAT JSON) EXECUTE %s('%s'::uuid,'%s'::uuid)", name, util.UUIDToString(f.ws), util.UUIDToString(issue))
	var plan []byte
	if err = tx.QueryRow(ctx, query).Scan(&plan); err != nil {
		t.Fatal(err)
	}
	var parsed []map[string]any
	if err = json.Unmarshal(plan, &parsed); err != nil {
		t.Fatal(err)
	}
	indexes := map[string]bool{}
	var walk func(any)
	walk = func(value any) {
		switch v := value.(type) {
		case []any:
			for _, item := range v {
				walk(item)
			}
		case map[string]any:
			if index, ok := v["Index Name"].(string); ok {
				indexes[index] = true
			}
			if v["Relation Name"] == "cockpit_artifact_version" && v["Node Type"] == "Seq Scan" {
				t.Error("generic guard still scans the entire version relation")
			}
			for _, child := range v {
				walk(child)
			}
		}
	}
	for _, root := range parsed {
		walk(root)
	}
	if !indexes["cockpit_artifact_version_producer_idx"] || !indexes["cockpit_artifact_version_review_idx"] {
		t.Errorf("generic guard did not reuse both existing version indexes: %+v", indexes)
	}
	if err = os.WriteFile(path, plan, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("generic guard plan saved: %s", path)
}
