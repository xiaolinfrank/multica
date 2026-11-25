package service

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

// ---------------------------------------------------------------------------
// Report

type CockpitReconcileInput struct {
	WorkspaceID, ActorID pgtype.UUID
	Apply                bool
}

type CockpitReconcileGroup struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Kept     string   `json:"kept"`
	KeptCode string   `json:"kept_code"`
	Moved    []string `json:"moved,omitempty"`
	Removed  []string `json:"removed,omitempty"`
	Notes    []string `json:"notes,omitempty"`
}

type CockpitReconcileCodeChange struct {
	NodeID  string `json:"node_id"`
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	OldCode string `json:"old_code"`
	NewCode string `json:"new_code"`
}

type CockpitReconcileProject struct {
	NodeID     string   `json:"node_id"`
	L1Code     string   `json:"l1_code"`
	ProjectID  string   `json:"project_id"`
	Title      string   `json:"title"`
	Method     string   `json:"method"`
	Candidates []string `json:"candidates,omitempty"`
}

type CockpitReconcileNewProject struct {
	NodeID     string `json:"node_id"`
	ProjectID  string `json:"project_id"`
	Code       string `json:"code"`
	Title      string `json:"title"`
	CollabPath string `json:"collab_path,omitempty"`
}

type CockpitReconcileNewRoot struct {
	ProjectID string `json:"project_id"`
	NodeID    string `json:"node_id"`
	Code      string `json:"code"`
	Title     string `json:"title"`
	Source    string `json:"source"`
}

type CockpitReconcileModule struct {
	NodeID      string `json:"node_id"`
	ModuleID    string `json:"module_id"`
	Title       string `json:"title"`
	Method      string `json:"method"`
	NeedsReview bool   `json:"needs_review,omitempty"`
}

type CockpitReconcileNewModule struct {
	NodeID   string `json:"node_id"`
	ModuleID string `json:"module_id"`
	Title    string `json:"title"`
}

type CockpitReconcileNewModuleNode struct {
	ModuleID string `json:"module_id"`
	NodeID   string `json:"node_id"`
	Code     string `json:"code"`
	Title    string `json:"title"`
	Source   string `json:"source"`
}

type CockpitReconcileReflowProject struct {
	ProjectID string   `json:"project_id"`
	L1NodeID  string   `json:"l1_node_id"`
	Modules   []string `json:"modules"`
}

type CockpitReconcileReflow struct {
	OldRootID  string                          `json:"old_root_id"`
	OldCode    string                          `json:"old_code"`
	OldName    string                          `json:"old_name"`
	Projects   []CockpitReconcileReflowProject `json:"projects"`
	Milestones int64                           `json:"milestones_moved"`
}

type CockpitReconcileTitleSplit struct {
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	OldTitle string `json:"old_title"`
	NewTitle string `json:"new_title"`
	Code     string `json:"code"`
}

type CockpitReconcileIssue struct {
	IssueID     string `json:"issue_id"`
	Identifier  string `json:"identifier"`
	Rule        string `json:"rule"`
	OldWorkItem string `json:"old_work_item,omitempty"`
	NewWorkItem string `json:"new_work_item,omitempty"`
	OldProject  string `json:"old_project,omitempty"`
	NewProject  string `json:"new_project,omitempty"`
	Note        string `json:"note,omitempty"`
}

// CockpitReconcileUnfiled records an issue the backfill left unfiled. §3.3
// requires the report to name every issue no rule could decide, so a human
// files it by hand instead of it silently vanishing from the migration.
type CockpitReconcileUnfiled struct {
	IssueID    string `json:"issue_id"`
	Identifier string `json:"identifier"`
	Reason     string `json:"reason"`
	Note       string `json:"note,omitempty"`
}

type CockpitReconcileDirectory struct {
	NodeID        string `json:"node_id"`
	Code          string `json:"code"`
	Name          string `json:"name"`
	DirectoryName string `json:"directory_name"`
	Source        string `json:"source"`
}

type CockpitReconcileReport struct {
	WorkspaceID    string                          `json:"workspace_id"`
	Apply          bool                            `json:"apply"`
	GeneratedAt    string                          `json:"generated_at"`
	Groups         []CockpitReconcileGroup         `json:"groups,omitempty"`
	CodeChanges    []CockpitReconcileCodeChange    `json:"code_changes,omitempty"`
	Projects       []CockpitReconcileProject       `json:"projects,omitempty"`
	NewProjects    []CockpitReconcileNewProject    `json:"new_projects,omitempty"`
	NewRoots       []CockpitReconcileNewRoot       `json:"new_roots,omitempty"`
	Modules        []CockpitReconcileModule        `json:"modules,omitempty"`
	NewModules     []CockpitReconcileNewModule     `json:"new_modules,omitempty"`
	NewModuleNodes []CockpitReconcileNewModuleNode `json:"new_module_nodes,omitempty"`
	Reflows        []CockpitReconcileReflow        `json:"reflows,omitempty"`
	TitleSplits    []CockpitReconcileTitleSplit    `json:"title_splits,omitempty"`
	Issues         []CockpitReconcileIssue         `json:"issues,omitempty"`
	Unfiled        []CockpitReconcileUnfiled       `json:"unfiled_issues,omitempty"`
	// UnfiledWithoutEvidence counts issues left unfiled that carry NO evidence
	// (no links, no title code) and are therefore not listed one by one: the
	// total is what a reviewer still needs to see.
	UnfiledWithoutEvidence int64                       `json:"unfiled_without_evidence"`
	DanglingLinks          int64                       `json:"dangling_links"`
	DirectoryNames         []CockpitReconcileDirectory `json:"directory_names,omitempty"`
	Blockers               []string                    `json:"blockers,omitempty"`
	SnapshotID             string                      `json:"snapshot_id,omitempty"`
}

// CockpitReconcileSnapshot writes the pre-apply backup inside the apply
// transaction. nil disables the backup (tests / dry runs).
type CockpitReconcileSnapshot func(ctx context.Context, q *db.Queries, board db.Cockpit) (string, error)

// ---------------------------------------------------------------------------
// Display structure (must match packages/core/cockpit/model.ts)

type reconcileSummaryGroup struct {
	ID       string
	Name     string
	RootCode string
	Members  []string
}

var reconcileSummaryGroups = []reconcileSummaryGroup{
	{ID: "02.02-09", Name: "平台架构与开发", RootCode: "L1-02", Members: []string{"02.02", "02.03", "02.04", "02.05", "02.06", "02.07", "02.08", "02.09"}},
	{ID: "03.01-02", Name: "场景的定义及方向", RootCode: "L1-03", Members: []string{"03.01", "03.02"}},
	{ID: "03.03-05", Name: "数据与工具的开发", RootCode: "L1-03", Members: []string{"03.03", "03.04", "03.05"}},
	{ID: "03.06-07", Name: "科学测评与用户验证", RootCode: "L1-03", Members: []string{"03.06", "03.07"}},
}

var reconcileSummaryRenames = map[string]string{
	"02.10": "院端一体机与部署",
}

var reconcileZeroSegmentCode = regexp.MustCompile(`^\d{2}(?:\.\d{2})*\.00$`)
var reconcileTitlePrefix = regexp.MustCompile(`^\s*(\d{2}(?:\.\d{2})*)\s*`)
var reconcileIssueTitleCode = regexp.MustCompile(`^\s*(\d{2}\.\d{2}\.\d{2})(?:\s|$)`)

// ---------------------------------------------------------------------------
// State

type reconcileNode struct {
	id        pgtype.UUID
	parentID  pgtype.UUID
	projectID pgtype.UUID
	moduleID  pgtype.UUID
	code      string
	name      string
	position  float64
	directory pgtype.Text
	created   bool
	deleted   bool
	// pendingCode marks a created root whose L1 number is provisional:
	// assignDeferredRootCodes re-numbers every pending root in position order
	// once reflowed rows release theirs. rootSource keeps the report label.
	pendingCode bool
	rootSource  string
	// original values, for the code/directory report and diffing
	oldCode      string
	oldName      string
	oldParentID  pgtype.UUID
	oldProject   pgtype.UUID
	oldModule    pgtype.UUID
	oldDirectory pgtype.Text
	oldPosition  float64
}

type reconcileProjectInfo struct {
	project db.Project
	code    string
	name    string
	modules int
	issues  int
}

type reconcileModuleInfo struct {
	module db.Module
	code   string
	name   string
}

type reconcileFiling struct {
	workItem, project, module pgtype.UUID
	rule, note                string
	valid                     bool
}

type cockpitReconciler struct {
	ctx        context.Context
	q          *db.Queries
	ws         pgtype.UUID
	board      db.Cockpit
	nodes      map[pgtype.UUID]*reconcileNode
	order      []pgtype.UUID
	children   map[pgtype.UUID][]pgtype.UUID
	roots      []pgtype.UUID
	projects   []db.Project
	projectIdx map[pgtype.UUID]*reconcileProjectInfo
	modules    []db.Module
	moduleIdx  map[pgtype.UUID]*reconcileModuleInfo
	issues     []db.ListCockpitReconcileIssuesRow
	issueIdx   map[pgtype.UUID]*db.ListCockpitReconcileIssuesRow
	unfiled    map[pgtype.UUID]string
	links      []db.CockpitNodeIssue
	dependents map[pgtype.UUID]db.ListCockpitNodeDependentsRow
	usedCodes  map[string]bool
	usedL1     map[string]bool
	report     CockpitReconcileReport
	// final writes
	projectTitles map[pgtype.UUID]string
	moduleTitles  map[pgtype.UUID]string

	createdProjects map[pgtype.UUID]bool
	createdModules  map[pgtype.UUID]bool
	// blockedRoots/blockedProjects remember the rows a blocked reflow would
	// have moved, so the dry run does not then invent substitute projects or
	// roots for them.
	blockedRoots    map[pgtype.UUID]bool
	blockedProjects map[pgtype.UUID]bool
	// reflowedRoots collects the workstream rows a reflow removed; their L1
	// numbers are freed once every root has been decided.
	reflowedRoots   []pgtype.UUID
	filings         map[pgtype.UUID]reconcileFiling
	danglingLinks   int64
	milestonesMoves []milestoneMove
}

// ReconcileCockpitPlan runs the one-time plan migration. A dry run computes
// the whole target state and writes nothing; apply repeats the same
// computation inside one transaction after taking a snapshot.
func (s *IssueService) ReconcileCockpitPlan(ctx context.Context, in CockpitReconcileInput, snapshot CockpitReconcileSnapshot) (CockpitReconcileReport, error) {
	report := CockpitReconcileReport{WorkspaceID: util.UUIDToString(in.WorkspaceID), Apply: in.Apply, GeneratedAt: time.Now().UTC().Format(time.RFC3339)}
	if in.Apply && snapshot == nil {
		return report, errors.New("plan reconcile requires a snapshot writer for apply")
	}
	board, err := s.Queries.GetCockpitByWorkspace(ctx, in.WorkspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return report, fmt.Errorf("%w: workspace has no plan board", ErrCockpitWorkflowNotFound)
	}
	if err != nil {
		return report, err
	}
	if in.Apply && board.PlanReconciledAt.Valid {
		// Codes are fixed once the plan is reconciled (§2.5); re-applying
		// would renumber rows users have reordered since. Preview stays open.
		return report, ErrCockpitPlanAlreadyReconciled
	}
	if !in.Apply {
		st, err := newCockpitReconciler(ctx, s.Queries, in.WorkspaceID, board)
		if err != nil {
			return report, err
		}
		if err := st.run(); err != nil {
			return report, err
		}
		if err := st.checkCrossProjectStatus(ctx, s.Queries); err != nil {
			return report, err
		}
		report = st.report
		report.Apply = false
		return report, nil
	}

	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return report, err
	}
	defer tx.Rollback(ctx)
	qtx := s.Queries.WithTx(tx)
	if _, err := qtx.LockCockpitForWorkspaceChanges(ctx, in.WorkspaceID); err != nil {
		return report, err
	}
	board, err = qtx.GetCockpitByWorkspace(ctx, in.WorkspaceID)
	if err != nil {
		return report, err
	}
	st, err := newCockpitReconciler(ctx, qtx, in.WorkspaceID, board)
	if err != nil {
		return report, err
	}
	if err := st.run(); err != nil {
		return report, err
	}
	if len(st.report.Blockers) > 0 {
		report = st.report
		report.Apply = true
		return report, nil
	}
	if err := st.checkCrossProjectStatus(ctx, qtx); err != nil {
		return report, err
	}
	snapshotID, err := snapshot(ctx, qtx, board)
	if err != nil {
		return report, fmt.Errorf("plan snapshot: %w", err)
	}
	// The report persisted with the apply carries what the caller sees: it is
	// an applied run and which snapshot precedes it.
	st.report.Apply = true
	st.report.SnapshotID = snapshotID
	if err := st.apply(); err != nil {
		return report, err
	}
	if err := tx.Commit(ctx); err != nil {
		return report, err
	}
	report = st.report
	report.Apply = true
	report.SnapshotID = snapshotID
	s.publishCockpitReconciled(in.WorkspaceID, in.ActorID)
	return report, nil
}

func (s *IssueService) publishCockpitReconciled(ws, actor pgtype.UUID) {
	if s.Bus == nil {
		return
	}
	s.Bus.Publish(events.Event{Type: protocol.EventCockpitChanged, WorkspaceID: util.UUIDToString(ws), ActorType: "member", ActorID: util.UUIDToString(actor),
		Payload: map[string]any{"scope": "plan", "action": "reconciled"}})
}

func newCockpitReconciler(ctx context.Context, q *db.Queries, ws pgtype.UUID, board db.Cockpit) (*cockpitReconciler, error) {
	st := &cockpitReconciler{
		ctx: ctx, q: q, ws: ws, board: board,
		nodes: make(map[pgtype.UUID]*reconcileNode), children: make(map[pgtype.UUID][]pgtype.UUID),
		projectIdx: make(map[pgtype.UUID]*reconcileProjectInfo), moduleIdx: make(map[pgtype.UUID]*reconcileModuleInfo),
		issueIdx: make(map[pgtype.UUID]*db.ListCockpitReconcileIssuesRow), dependents: make(map[pgtype.UUID]db.ListCockpitNodeDependentsRow),
		unfiled:   make(map[pgtype.UUID]string),
		usedCodes: make(map[string]bool), usedL1: make(map[string]bool),
		projectTitles: make(map[pgtype.UUID]string), moduleTitles: make(map[pgtype.UUID]string),
		createdProjects: make(map[pgtype.UUID]bool), createdModules: make(map[pgtype.UUID]bool),
		blockedRoots: make(map[pgtype.UUID]bool), blockedProjects: make(map[pgtype.UUID]bool),
		filings: make(map[pgtype.UUID]reconcileFiling),
		report:  CockpitReconcileReport{WorkspaceID: util.UUIDToString(ws), GeneratedAt: time.Now().UTC().Format(time.RFC3339)},
	}
	nodes, err := q.ListCockpitNodes(ctx, board.ID)
	if err != nil {
		return nil, err
	}
	for _, n := range nodes {
		st.nodes[n.ID] = &reconcileNode{
			id: n.ID, parentID: n.ParentID, projectID: n.ProjectID, moduleID: n.ModuleID,
			code: n.Code, name: n.Name, position: n.Position, directory: n.DirectoryName,
			oldCode: n.Code, oldName: n.Name, oldParentID: n.ParentID, oldProject: n.ProjectID, oldModule: n.ModuleID, oldDirectory: n.DirectoryName, oldPosition: n.Position,
		}
		st.order = append(st.order, n.ID)
		st.usedCodes[n.Code] = true
		if !n.ParentID.Valid {
			st.usedL1[trailingDigits(n.Code)] = true
		}
	}
	st.rebuildTree()

	if st.projects, err = q.ListProjects(ctx, db.ListProjectsParams{WorkspaceID: ws}); err != nil {
		return nil, err
	}
	for _, p := range st.projects {
		code, name := splitReconcileTitle(p.Title)
		st.projectIdx[p.ID] = &reconcileProjectInfo{project: p, code: code, name: name}
	}
	if st.modules, err = q.ListModules(ctx, db.ListModulesParams{WorkspaceID: ws}); err != nil {
		return nil, err
	}
	for _, m := range st.modules {
		code, name := splitReconcileTitle(m.Title)
		st.moduleIdx[m.ID] = &reconcileModuleInfo{module: m, code: code, name: name}
	}
	if st.issues, err = q.ListCockpitReconcileIssues(ctx, ws); err != nil {
		return nil, err
	}
	for i := range st.issues {
		issue := &st.issues[i]
		st.issueIdx[issue.ID] = issue
		if issue.ProjectID.Valid {
			if info := st.projectIdx[issue.ProjectID]; info != nil {
				info.issues++
			}
		}
	}
	for _, m := range st.modules {
		if info := st.projectIdx[m.ProjectID]; info != nil {
			info.modules++
		}
	}
	if st.links, err = q.ListCockpitNodeIssueLinks(ctx, ws); err != nil {
		return nil, err
	}
	deps, err := q.ListCockpitNodeDependents(ctx, ws)
	if err != nil {
		return nil, err
	}
	for _, d := range deps {
		st.dependents[d.NodeID] = d
	}
	return st, nil
}

func (st *cockpitReconciler) rebuildTree() {
	st.children = make(map[pgtype.UUID][]pgtype.UUID)
	roots := make([]pgtype.UUID, 0, len(st.order))
	for _, id := range st.order {
		n := st.nodes[id]
		if n == nil || n.deleted {
			continue
		}
		if n.parentID.Valid {
			if parent := st.nodes[n.parentID]; parent != nil && !parent.deleted {
				st.children[n.parentID] = append(st.children[n.parentID], id)
				continue
			}
		}
		roots = append(roots, id)
	}
	sort.SliceStable(roots, func(i, j int) bool { return st.less(roots[i], roots[j]) })
	// A fresh slice, never st.roots[:0]: callers iterate st.roots while reflow
	// mutates the tree, and reusing the backing array rewrites the slice being
	// ranged over, skipping or repeating rows (pmo-showcase lost L1-04/L1-06).
	st.roots = roots
	for parent := range st.children {
		ids := st.children[parent]
		sort.SliceStable(ids, func(i, j int) bool { return st.less(ids[i], ids[j]) })
		st.children[parent] = ids
	}
}

func (st *cockpitReconciler) less(a, b pgtype.UUID) bool {
	left, right := st.nodes[a], st.nodes[b]
	if left.position != right.position {
		return left.position < right.position
	}
	return left.code < right.code
}

func (st *cockpitReconciler) depth(id pgtype.UUID) int {
	depth := 0
	for n := st.nodes[id]; n != nil && n.parentID.Valid && depth < 64; n = st.nodes[n.parentID] {
		depth++
	}
	return depth
}

func (st *cockpitReconciler) kind(id pgtype.UUID) string {
	n := st.nodes[id]
	if n == nil {
		return ""
	}
	switch st.depth(id) {
	case 0:
		return "project"
	case 1:
		return "module"
	default:
		return "work_item"
	}
}

func (st *cockpitReconciler) run() error {
	st.restoreDisplayStructure()
	st.assignProjects()
	// Display codes BEFORE module matching: module titles carry the display
	// numbering ("03.03 科学测评与用户验证"), so matching a pre-renumber L2
	// stored code bound project 03's rows to the wrong modules. Both passes
	// record: the second only adds rows created between them (duplicates are
	// suppressed), so a merged board reports each row once with its final code.
	st.applyCodes(true)
	st.assignModules()
	st.applyCodes(true)
	// Backfilled rows keep the provisional numbers their sections recorded
	// them with; the report is what a human reviews before apply, so it must
	// show the FINAL numbers. Refresh in place, keeping each entry's source.
	st.refreshReportCodes()
	st.backfillIssues()
	st.computeDirectoryNames()
	return nil
}

// refreshReportCodes rewrites the code fields of the new-module-node and
// new-root sections after the final applyCodes pass, so a report read before
// apply shows the codes that will actually be written.
func (st *cockpitReconciler) refreshReportCodes() {
	for i := range st.report.NewModuleNodes {
		if n := st.nodes[parseUUIDLenient(st.report.NewModuleNodes[i].NodeID)]; n != nil {
			st.report.NewModuleNodes[i].Code = n.code
		}
	}
	for i := range st.report.NewRoots {
		if n := st.nodes[parseUUIDLenient(st.report.NewRoots[i].NodeID)]; n != nil {
			st.report.NewRoots[i].Code = n.code
		}
	}
}

func parseUUIDLenient(id string) pgtype.UUID {
	parsed, err := util.ParseUUID(id)
	if err != nil {
		return pgtype.UUID{}
	}
	return parsed
}

// ---------------------------------------------------------------------------
// 1. Restore the displayed structure

func (st *cockpitReconciler) restoreDisplayStructure() {
	for _, group := range reconcileSummaryGroups {
		root := st.rootByStoredCode(group.RootCode)
		if root == nil {
			continue
		}
		var members []pgtype.UUID
		for _, code := range group.Members {
			if id := st.childByStoredCode(root.id, code); id.Valid {
				members = append(members, id)
			}
		}
		if len(members) == 0 {
			continue
		}
		keep := st.nodes[members[0]]
		change := CockpitReconcileGroup{ID: group.ID, Name: group.Name, Kept: util.UUIDToString(keep.id), KeptCode: keep.code}
		// Merging is all-or-nothing per group: a member still carrying payments,
		// milestones or links would be deleted with them, so the whole group
		// waits. Reporting a half-merged group would misdescribe a dry run.
		var blocked []string
		for _, id := range members[1:] {
			if deps := st.dependents[id]; deps.Payments > 0 || deps.Milestones > 0 || deps.IssueLinks > 0 || deps.MeetingLinks > 0 || deps.Artifacts > 0 {
				blocked = append(blocked, st.nodes[id].code)
			}
		}
		if len(blocked) > 0 {
			st.report.Blockers = append(st.report.Blockers, fmt.Sprintf("summary group %s: members %s still have payments/milestones/links", group.ID, strings.Join(blocked, ", ")))
			continue
		}
		appendPosition := st.maxChildPosition(keep.id) + 1
		for _, id := range members[1:] {
			member := st.nodes[id]
			for _, childID := range st.children[id] {
				child := st.nodes[childID]
				child.parentID = keep.id
				child.position = appendPosition
				appendPosition++
				change.Moved = append(change.Moved, util.UUIDToString(childID))
			}
			member.deleted = true
			change.Removed = append(change.Removed, member.code)
			change.Notes = append(change.Notes, fmt.Sprintf("%s %s fields not migrated", member.code, member.name))
			delete(st.children, id)
		}
		keep.name = group.Name
		st.rebuildTree()
		st.report.Groups = append(st.report.Groups, change)
	}
	for code, name := range reconcileSummaryRenames {
		if id := st.nodeByStoredCode(code); id.Valid {
			st.nodes[id].name = name
		}
	}
	st.rebuildTree()
}

func (st *cockpitReconciler) rootByStoredCode(code string) *reconcileNode {
	for _, id := range st.roots {
		if st.nodes[id].oldCode == code {
			return st.nodes[id]
		}
	}
	return nil
}

func (st *cockpitReconciler) childByStoredCode(parent pgtype.UUID, code string) pgtype.UUID {
	for _, id := range st.children[parent] {
		if st.nodes[id].oldCode == code {
			return id
		}
	}
	return pgtype.UUID{}
}

func (st *cockpitReconciler) nodeByStoredCode(code string) pgtype.UUID {
	for _, id := range st.order {
		if n := st.nodes[id]; n != nil && !n.deleted && n.oldCode == code {
			return id
		}
	}
	return pgtype.UUID{}
}

func (st *cockpitReconciler) maxChildPosition(parent pgtype.UUID) float64 {
	max := -1.0
	for _, id := range st.children[parent] {
		if p := st.nodes[id].position; p > max {
			max = p
		}
	}
	return max
}

// ---------------------------------------------------------------------------
// 2/3. Projects and modules
