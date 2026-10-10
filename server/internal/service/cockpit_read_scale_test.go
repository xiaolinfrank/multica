//go:build cockpitscale

package service

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// Compile on the coordinator; run only on agent3's isolated test database.
// No Agent, NAS or application-tenant access is part of this measurement.
func TestCockpitReadScale(t *testing.T) {
	if os.Getenv("MULTICA_RUN_COCKPIT_SCALE") != "1" {
		t.Skip("set MULTICA_RUN_COCKPIT_SCALE=1 in the isolated agent3 test environment")
	}
	testURL := os.Getenv("TEST_DATABASE_URL")
	parsed, err := url.Parse(testURL)
	if testURL == "" || testURL != os.Getenv("DATABASE_URL") || err != nil || !strings.HasSuffix(parsed.Path, "_test") {
		t.Fatal("scale fixture requires DATABASE_URL to equal the dedicated TEST_DATABASE_URL and a database name ending in _test")
	}
	f, owner := newPrincipalFixture(t)
	t.Logf("isolated scale fixture workspace_id=%s", f.WorkspaceID)
	ctx := context.Background()
	ws, actor := parseTestUUID(t, f.WorkspaceID), parseTestUUID(t, owner)
	svc := NewIssueService(f.q, f.Pool, f.svc.Bus, nil, f.svc.TaskSvc)
	board := parseTestUUID(t, f.Insert(t, "cockpit", testutil.Cols{"workspace_id": ws, "title": "Isolated scale fixture"}))
	projects, modules := make([]pgtype.UUID, 30), make([]pgtype.UUID, 300)
	projectNodes, moduleNodes, leaves := make([]pgtype.UUID, 30), make([]pgtype.UUID, 300), make([]pgtype.UUID, 3000)
	for i := range projects {
		projects[i] = parseTestUUID(t, f.Project(t, fmt.Sprintf("Scale project %02d", i)))
		projectNodes[i] = dbid.NewV7()
	}
	for i := range modules {
		modules[i] = parseTestUUID(t, f.Module(t, util.UUIDToString(projects[i/10]), fmt.Sprintf("Scale module %03d", i)))
		moduleNodes[i] = dbid.NewV7()
	}
	for i := range leaves {
		leaves[i] = dbid.NewV7()
	}
	// Register teardown before bulk insertion, including partially seeded tests.
	t.Cleanup(func() {
		for _, table := range []string{"cockpit_node", "issue", "cockpit_issue_primary", "cockpit_meeting", "cockpit_meeting_node"} {
			if n := f.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", ws); n != 0 {
				t.Errorf("fixture cleanup left %d %s rows", n, table)
			}
		}
	})
	for _, table := range []string{"cockpit_node", "issue", "cockpit_issue_primary", "cockpit_meeting", "cockpit_meeting_node"} {
		f.Cleanup(t, "DELETE FROM "+table+" WHERE workspace_id=$1", ws)
	}
	seedStart := time.Now()
	rows := make([][]any, 0, 3330)
	for i, id := range projectNodes {
		rows = append(rows, []any{id, ws, board, nil, fmt.Sprintf("P%02d", i), "Scale project", projects[i], nil})
	}
	for i, id := range moduleNodes {
		rows = append(rows, []any{id, ws, board, projectNodes[i/10], fmt.Sprintf("M%03d", i), "Scale module", projects[i/10], modules[i]})
	}
	for i, id := range leaves {
		rows = append(rows, []any{id, ws, board, moduleNodes[i/10], fmt.Sprintf("scale-L3-%04d", i+1), fmt.Sprintf("Execution %04d", i+1), nil, nil})
	}
	if _, err := f.Pool.CopyFrom(ctx, pgx.Identifier{"cockpit_node"}, []string{"id", "workspace_id", "cockpit_id", "parent_id", "code", "name", "project_id", "module_id"}, pgx.CopyFromRows(rows)); err != nil {
		t.Fatal(err)
	}
	f.Exec(t, `INSERT INTO issue (id,workspace_id,number,title,description,status,priority,creator_type,creator_id,assignee_type,assignee_id,project_id,module_id,due_date,position)
 SELECT gen_random_uuid(),$1,g,'Scale task '||g,repeat('Evidence source body. ',100),CASE WHEN g%5=0 THEN 'done' ELSE 'backlog' END,
 'none','member',$2,'member',$2,m.project_id,m.id,'2026-09-01'::date,g
 FROM generate_series(1,100000) g JOIN cockpit_node n ON n.workspace_id=$1 AND n.code='scale-L3-'||lpad(((g-1)%3000+1)::text,4,'0')
 JOIN cockpit_node parent ON parent.id=n.parent_id AND parent.workspace_id=$1 JOIN module m ON m.id=parent.module_id AND m.workspace_id=$1`, ws, actor)
	// The preceding suite removes its tenant. Refresh this isolated fixture's
	// distribution before per-row integrity guards choose cached lookup plans.
	// Otherwise a fresh tenant can be estimated as empty for an entire 100k insert.
	f.Exec(t, "ANALYZE issue, cockpit_node, project, module")
	f.Exec(t, `INSERT INTO cockpit_issue_primary(issue_id,workspace_id,node_id,created_by,updated_by)
 SELECT i.id,$1,n.id,$2,$2 FROM issue i JOIN cockpit_node n ON n.workspace_id=$1 AND n.code='scale-L3-'||lpad(((i.number-1)%3000+1)::text,4,'0') WHERE i.workspace_id=$1`, ws, actor)
	f.Exec(t, `INSERT INTO cockpit_meeting(id,workspace_id,cockpit_id,code,title,meet_date,note)
 SELECT gen_random_uuid(),$1,$2,'SCALE-'||g,'Scale meeting '||g,'2026-10-01'::date+((g-1)/3000),repeat('Meeting evidence body. ',100) FROM generate_series(1,20000) g`, ws, board)
	f.Exec(t, `INSERT INTO cockpit_meeting_node(workspace_id,meeting_id,node_id)
 SELECT $1,m.id,n.id FROM cockpit_meeting m JOIN cockpit_node n ON n.workspace_id=$1 AND n.code='scale-L3-'||lpad(((substring(m.code from 7)::int-1)%3000+1)::text,4,'0') WHERE m.workspace_id=$1`, ws)
	// Duplicate provenance via an ancestor must not duplicate displayed meetings.
	f.Exec(t, `INSERT INTO cockpit_meeting_node(workspace_id,meeting_id,node_id)
 SELECT $1,l.meeting_id,n.parent_id FROM cockpit_meeting_node l JOIN cockpit_node n ON n.id=l.node_id AND n.workspace_id=$1 WHERE l.workspace_id=$1`, ws)
	f.Exec(t, "ANALYZE cockpit_issue_primary, cockpit_meeting, cockpit_meeting_node")
	for table, expected := range map[string]int{"project": 30, "module": 300, "cockpit_node": 3330, "issue": 100000, "cockpit_issue_primary": 100000, "cockpit_meeting": 20000, "cockpit_meeting_node": 40000} {
		if n := f.Count(t, "SELECT count(*) FROM "+table+" WHERE workspace_id=$1", ws); n != expected {
			t.Fatalf("fixture %s=%d, want %d", table, n, expected)
		}
	}
	p := CockpitSurfaceQuery{WorkspaceID: ws, ActorID: actor, Human: true}
	projectScope := p
	projectScope.ProjectID = projects[0]
	moduleScope := projectScope
	moduleScope.ModuleID = modules[0]
	markerRows := make([]CockpitPlanMarkerRow, 100)
	for i := range markerRows {
		id := util.UUIDToString(leaves[i])
		markerRows[i] = CockpitPlanMarkerRow{RowKey: id, NodeIDs: []string{id}}
	}
	projectNodeID := util.UUIDToString(projectNodes[0])
	markerRows[0] = CockpitPlanMarkerRow{RowKey: projectNodeID, NodeIDs: []string{projectNodeID}}
	checks := []struct {
		name string
		read func(context.Context) (any, error)
	}{
		{"context_workspace", func(ctx context.Context) (any, error) { return svc.GetCockpitSurfaceContext(ctx, p) }},
		{"plan_workspace", func(ctx context.Context) (any, error) { return svc.GetCockpitPlanSurface(ctx, p) }},
		{"plan_project", func(ctx context.Context) (any, error) { return svc.GetCockpitPlanSurface(ctx, projectScope) }},
		{"plan_module", func(ctx context.Context) (any, error) { return svc.GetCockpitPlanSurface(ctx, moduleScope) }},
		{"register_workspace", func(ctx context.Context) (any, error) {
			return svc.ListCockpitMeetingRegister(ctx, CockpitMeetingRegisterQuery{CockpitSurfaceQuery: p, PageSize: 25})
		}},
		{"register_project", func(ctx context.Context) (any, error) {
			return svc.ListCockpitMeetingRegister(ctx, CockpitMeetingRegisterQuery{CockpitSurfaceQuery: projectScope, PageSize: 25})
		}},
		{"register_search", func(ctx context.Context) (any, error) {
			return svc.ListCockpitMeetingRegister(ctx, CockpitMeetingRegisterQuery{CockpitSurfaceQuery: p, Query: "Scale meeting 1", PageSize: 25})
		}},
		{"markers_visible100", func(ctx context.Context) (any, error) {
			return svc.GetCockpitPlanMeetingMarkers(ctx, CockpitPlanMarkerQuery{CockpitSurfaceQuery: p, Rows: markerRows, DateFrom: "2026-10-01", DateTo: "2026-10-28"})
		}},
		{"overview_workspace", func(ctx context.Context) (any, error) {
			return svc.GetCockpitOverview(ctx, CockpitOverviewQuery{WorkspaceID: ws, ActorID: actor, Human: true, AsOf: "2026-10-10", View: "team"})
		}},
		{"overview_project", func(ctx context.Context) (any, error) {
			return svc.GetCockpitOverview(ctx, CockpitOverviewQuery{WorkspaceID: ws, ProjectID: projects[0], ActorID: actor, Human: true, AsOf: "2026-10-10", View: "mine"})
		}},
	}
	type measurement struct {
		Name                string    `json:"name"`
		Failed              bool      `json:"failed"`
		Error               string    `json:"error,omitempty"`
		FirstReadMS         float64   `json:"first_read_ms,omitempty"`
		FirstPayloadBytes   int       `json:"first_payload_bytes,omitempty"`
		WarmReadMS          []float64 `json:"warm_read_ms"`
		WarmP50MS           float64   `json:"warm_p50_ms,omitempty"`
		WarmP95MS           float64   `json:"warm_p95_ms,omitempty"`
		MaximumPayloadBytes int       `json:"maximum_payload_bytes,omitempty"`
	}
	report := struct {
		Fixture        map[string]int `json:"fixture"`
		SeedMS         float64        `json:"seed_ms"`
		CacheNote      string         `json:"cache_note"`
		StatisticsNote string         `json:"statistics_note"`
		Unverified     []string       `json:"unverified"`
		Measurements   []measurement  `json:"measurements"`
	}{map[string]int{"projects": 30, "modules": 300, "l3": 3000, "issues": 100000, "meetings": 20000}, float64(time.Since(seedStart).Microseconds()) / 1000,
		"First read is the first call in this test, not an OS/PostgreSQL cache flush. Latency covers service reads and JSON encoding; excludes HTTP, browser and transport.",
		"Fixture tables are explicitly ANALYZEd after bulk insertion, before primary integrity checks and before measurements. No JIT/work_mem/plan-cache configuration changes.",
		[]string{"200000 artifact versions: artifact tables not yet implemented", "concurrent users", "large populations of enabled meeting work packages"}, nil}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			m := measurement{Name: check.name}
			defer func() { m.Failed = t.Failed(); report.Measurements = append(report.Measurements, m) }()
			for round := 0; round <= 20; round++ {
				start := time.Now()
				readCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
				value, err := check.read(readCtx)
				cancel()
				if err != nil {
					m.Error = err.Error()
					t.Fatal(err)
				}
				payload, err := json.Marshal(value)
				if err != nil {
					t.Fatal(err)
				}
				elapsed := float64(time.Since(start).Microseconds()) / 1000
				if round == 0 {
					m.FirstReadMS, m.FirstPayloadBytes = elapsed, len(payload)
					t.Logf("first read %.3fms / %d bytes", elapsed, len(payload))
					validateCockpitScaleRead(t, check.name, value)
				} else {
					m.WarmReadMS = append(m.WarmReadMS, elapsed)
				}
				if len(payload) > m.MaximumPayloadBytes {
					m.MaximumPayloadBytes = len(payload)
				}
			}
			ordered := append([]float64{}, m.WarmReadMS...)
			sort.Float64s(ordered)
			m.WarmP50MS = ordered[int(math.Ceil(float64(len(ordered))*.5))-1]
			m.WarmP95MS = ordered[int(math.Ceil(float64(len(ordered))*.95))-1]
			t.Logf("first %.3fms; warm p50 %.3fms p95 %.3fms; payload %d bytes", m.FirstReadMS, m.WarmP50MS, m.WarmP95MS, m.MaximumPayloadBytes)
		})
	}
	t.Run("marker_continuation_deduplicates_ancestor_links", func(t *testing.T) {
		query := CockpitPlanMarkerQuery{CockpitSurfaceQuery: p, Rows: markerRows, DateFrom: "2026-10-01", DateTo: "2026-10-28"}
		seen := map[string]bool{}
		for {
			readCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
			page, err := svc.GetCockpitPlanMeetingMarkers(readCtx, query)
			cancel()
			if err != nil {
				t.Fatal(err)
			}
			for _, group := range page.Groups {
				key := group.RowKey + "|" + group.Date
				if seen[key] {
					t.Fatal("duplicate group across marker pages")
				}
				seen[key] = true
				expected := int64(1)
				if group.RowKey == util.UUIDToString(projectNodes[0]) {
					expected = 100
				}
				if group.Total != expected {
					t.Fatalf("ancestor links inflated marker group: got %d, want %d", group.Total, expected)
				}
			}
			if page.NextCursor == nil {
				break
			}
			query.Cursor = *page.NextCursor
		}
		if len(seen) != 700 {
			t.Fatalf("marker history lost groups: %d", len(seen))
		}
	})

	// Diagnostics use separate read-only transactions after every timing sample.
	// Their local plan mode never changes the service or measured connections.
	if dir := os.Getenv("MULTICA_COCKPIT_SCALE_MARKER_EXPLAIN_DIR"); dir != "" {
		t.Run("marker_plan_diagnostics", func(t *testing.T) {
			captureCockpitMarkerPlans(t, f.Pool, dir, ws, markerRows)
		})
	}
	body, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("COCKPIT_SCALE_REPORT=%s", body)
	if path := os.Getenv("MULTICA_COCKPIT_SCALE_REPORT"); path != "" {
		if err := os.WriteFile(path, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func validateCockpitScaleRead(t *testing.T, name string, value any) {
	t.Helper()
	switch v := value.(type) {
	case CockpitSurfacePlan:
		expected := map[string]int64{"plan_workspace": 3330, "plan_project": 111, "plan_module": 12}[name]
		if !v.Complete || v.Counts.Nodes != expected || v.Counts.IndexNodes != 3330 {
			t.Fatalf("incomplete scoped plan: %+v", v.Counts)
		}
		var rows []struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(v.Nodes, &rows); err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		for _, row := range rows {
			if seen[row.ID] {
				t.Fatal("duplicate plan node")
			}
			seen[row.ID] = true
		}
	case CockpitMeetingRegisterPage:
		if len(v.Items) != 25 || v.NextCursor == nil {
			t.Fatalf("unbounded or incomplete register page: %d", len(v.Items))
		}
		if name == "register_workspace" && v.Total != 20000 || name == "register_project" && v.Total != 700 {
			t.Fatalf("duplicate or lost meeting totals: %d", v.Total)
		}
		seen := map[string]bool{}
		for _, raw := range v.Items {
			var row map[string]json.RawMessage
			if err := json.Unmarshal(raw, &row); err != nil {
				t.Fatal(err)
			}
			id := string(row["id"])
			if seen[id] {
				t.Fatal("duplicate meeting")
			}
			seen[id] = true
			for _, field := range []string{"note", "minutes", "actions", "decisions"} {
				if _, exists := row[field]; exists {
					t.Fatalf("register exposed full body %s", field)
				}
			}
		}
	case CockpitPlanMarkerPage:
		if len(v.Groups) > 500 || v.TotalGroups != 700 || v.NextCursor == nil {
			t.Fatalf("marker groups=%d total=%d next=%v", len(v.Groups), v.TotalGroups, v.NextCursor)
		}
		seen := map[string]bool{}
		for _, group := range v.Groups {
			key := group.RowKey + "|" + group.Date
			if seen[key] {
				t.Fatal("duplicate marker group")
			}
			seen[key] = true
			if len(group.Items) > 5 || int64(len(group.Items)) > group.Total {
				t.Fatal("unbounded marker previews")
			}
		}
	case CockpitOverview:
		total, active, l3 := int64(100000), int64(80000), int64(3000)
		if name == "overview_project" {
			total, active, l3 = 3400, 2720, 100
		}
		if v.Summary.PrimaryIssues.Total != total || v.Summary.PrimaryIssues.Active != active || v.Summary.ExecutionNodes.Total != l3 || v.Attention.Total != active {
			t.Fatalf("overview facts: issues=%+v L3=%d attention=%d", v.Summary.PrimaryIssues, v.Summary.ExecutionNodes.Total, v.Attention.Total)
		}
		if len(v.Attention.Items) > 8 || len(v.ExecutionNodes.Items) > 6 || len(v.RecentMeetings.Items) > 6 {
			t.Fatal("unbounded overview preview")
		}
	}
}

// Optional operator-supplied SQL snapshots are trusted repository queries, not
// runtime inputs. This helper is reachable only behind the isolated scale gate.
func captureCockpitMarkerPlans(t *testing.T, pool TxStarter, dir string, workspace pgtype.UUID, rows []CockpitPlanMarkerRow) {
	t.Helper()
	names := []string{"workspace_id", "project_id", "module_id", "node_ids", "rows", "date_from", "date_to", "cursor_key"}
	positions := map[string]string{}
	for i, name := range names {
		positions[name] = fmt.Sprintf("$%d", i+1)
	}
	placeholder := regexp.MustCompile(`sqlc\.(?:arg|narg)\('([^']+)'\)`)
	quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
	unique := map[string]bool{}
	for _, row := range rows {
		for _, id := range row.NodeIDs {
			unique[id] = true
		}
	}
	ids := []string{}
	for id := range unique {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for i, id := range ids {
		ids[i] = quote(id)
	}
	data, err := json.Marshal(rows)
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Join([]string{quote(util.UUIDToString(workspace)), "NULL", "NULL", "ARRAY[" + strings.Join(ids, ",") + "]::uuid[]", quote(string(data)), "'2026-10-01'", "'2026-10-28'", "''"}, ",")
	for _, source := range []string{"before", "after"} {
		raw, err := os.ReadFile(filepath.Join(dir, source+".sql"))
		if err != nil {
			t.Fatal(err)
		}
		parts := strings.SplitN(string(raw), "-- name: GetCockpitPlanMeetingMarkers :one\n", 2)
		if len(parts) != 2 {
			t.Fatal("marker query missing in diagnostic snapshot")
		}
		query := strings.SplitN(parts[1], "\n-- name:", 2)[0]
		query = placeholder.ReplaceAllStringFunc(query, func(value string) string {
			match := placeholder.FindStringSubmatch(value)
			position, ok := positions[match[1]]
			if !ok {
				t.Fatalf("unknown marker parameter: %s", match[1])
			}
			return position
		})
		for _, mode := range []string{"custom", "generic"} {
			t.Run(source+"_"+mode, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
				defer cancel()
				tx, err := pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.Background())
				if _, err = tx.Exec(ctx, "SET TRANSACTION READ ONLY"); err != nil {
					t.Fatal(err)
				}
				if _, err = tx.Exec(ctx, "SET LOCAL plan_cache_mode=force_"+mode+"_plan"); err != nil {
					t.Fatal(err)
				}
				name := "cockpit_marker_" + source + "_" + mode
				if _, err = tx.Exec(ctx, "PREPARE "+name+"(uuid,uuid,uuid,uuid[],jsonb,date,date,text) AS "+query); err != nil {
					t.Fatal(err)
				}
				defer tx.Exec(context.Background(), "DEALLOCATE "+name)
				var plan []byte
				if err = tx.QueryRow(ctx, "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE "+name+"("+args+")").Scan(&plan); err != nil {
					t.Fatal(err)
				}
				if !json.Valid(plan) {
					t.Fatal("diagnostic plan is not JSON")
				}
				if err = os.WriteFile(filepath.Join(dir, source+"-"+mode+".json"), plan, 0600); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}
