package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/issueworkflow"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
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
	DanglingLinks  int64                           `json:"dangling_links"`
	DirectoryNames []CockpitReconcileDirectory     `json:"directory_names,omitempty"`
	Blockers       []string                        `json:"blockers,omitempty"`
	SnapshotID     string                          `json:"snapshot_id,omitempty"`
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
		return report, fmt.Errorf("%w: this board's plan was already reconciled; only a dry run is available", ErrCockpitWorkflowConflict)
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
	st.backfillIssues()
	st.computeDirectoryNames()
	return nil
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

func (st *cockpitReconciler) assignProjects() {
	matched := make(map[pgtype.UUID]bool)
	// Iterate a copy: tryReflow rebuilds the tree (and st.roots) while this
	// loop runs. Same fix as rebuildTree's fresh slice — a [:0] rewrite made
	// pmo-showcase skip its middle workstream rows.
	for _, rootID := range append([]pgtype.UUID(nil), st.roots...) {
		l1 := st.nodes[rootID]
		if l1 == nil || l1.deleted {
			continue
		}
		project, method, candidates, ok := st.matchProject(l1, matched)
		if ok {
			l1.projectID = project.ID
			matched[project.ID] = true
			st.report.Projects = append(st.report.Projects, CockpitReconcileProject{
				NodeID: util.UUIDToString(l1.id), L1Code: trailingDigits(l1.code), ProjectID: util.UUIDToString(project.ID),
				Title: project.Title, Method: method, Candidates: candidates,
			})
			st.stripProjectTitle(project)
			continue
		}
		if st.tryReflow(l1) {
			continue
		}
		if st.blockedRoots[l1.id] {
			continue
		}
		st.createProjectForRoot(l1)
	}
	// Projects without an L1 row get one, in creation order.
	for _, project := range st.projects {
		if matched[project.ID] || st.blockedProjects[project.ID] || st.projectHasRoot(project.ID) {
			continue
		}
		st.createRootForProject(project)
	}
	st.releaseReflowCodes()
	st.rebuildTree()
}

func (st *cockpitReconciler) matchProject(l1 *reconcileNode, matched map[pgtype.UUID]bool) (db.Project, string, []string, bool) {
	if l1.projectID.Valid && st.projectIdx[l1.projectID] != nil {
		return st.projectIdx[l1.projectID].project, "bound", nil, true
	}
	_, name := splitReconcileTitle(l1.name)
	normalized := normalizeReconcileName(name)
	// Deterministic order: the projects slice is position-stable, a map walk is
	// not, and tie-breaks must not flip between dry runs.
	var candidates []*reconcileProjectInfo
	for _, p := range st.projects {
		info := st.projectIdx[p.ID]
		if info == nil || matched[p.ID] {
			// One L1 per project: a project another row already claimed is not
			// a candidate again.
			continue
		}
		if normalizeReconcileName(info.name) == normalized {
			candidates = append(candidates, info)
		}
	}
	if len(candidates) > 0 {
		best := chooseProject(candidates)
		var alternatives []string
		for _, c := range candidates {
			if c.project.ID != best.project.ID {
				alternatives = append(alternatives, util.UUIDToString(c.project.ID))
			}
		}
		return best.project, "name", alternatives, true
	}
	l1Code := trailingDigits(l1.code)
	for _, p := range st.projects {
		info := st.projectIdx[p.ID]
		if info == nil || matched[p.ID] {
			continue
		}
		if info.code != "" && info.code == l1Code && (strings.Contains(normalizeReconcileName(info.name), normalized) || strings.Contains(normalized, normalizeReconcileName(info.name))) {
			return p, "code_contains", nil, true
		}
	}
	return db.Project{}, "", nil, false
}

func chooseProject(candidates []*reconcileProjectInfo) *reconcileProjectInfo {
	best := candidates[0]
	for _, c := range candidates[1:] {
		if c.modules > best.modules || (c.modules == best.modules && c.issues > best.issues) {
			best = c
		}
	}
	return best
}

func (st *cockpitReconciler) stripProjectTitle(project db.Project) {
	code, name := splitReconcileTitle(project.Title)
	if code == "" || name == "" {
		return
	}
	st.projectTitles[project.ID] = name
	st.report.TitleSplits = append(st.report.TitleSplits, CockpitReconcileTitleSplit{Kind: "project", ID: util.UUIDToString(project.ID), OldTitle: project.Title, NewTitle: name, Code: code})
}

func (st *cockpitReconciler) createProjectForRoot(l1 *reconcileNode) {
	_, name := splitReconcileTitle(l1.name)
	// The row already sits at this position in the tree; its own number is not
	// a conflict, only an empty/unparseable one needs the next free code.
	code := trailingDigits(l1.code)
	if code == "" {
		code = st.nextL1Code()
	}
	st.usedL1[code] = true
	title := name
	id := dbid.NewV7()
	collabPath := st.projectPathSuggestion(code, name)
	project := db.Project{ID: id, WorkspaceID: st.ws, Title: title, Status: "in_progress", CollabPath: pgtype.Text{String: collabPath, Valid: collabPath != ""}}
	st.projectIdx[id] = &reconcileProjectInfo{project: project, code: code, name: title}
	st.createdProjects[id] = true
	l1.projectID = id
	l1.name = title
	st.report.NewProjects = append(st.report.NewProjects, CockpitReconcileNewProject{NodeID: util.UUIDToString(l1.id), ProjectID: util.UUIDToString(id), Code: code, Title: title, CollabPath: collabPath})
}

func (st *cockpitReconciler) createRootForProject(project db.Project) {
	code, name := splitReconcileTitle(project.Title)
	source := "title_prefix"
	if code == "" || len(code) > 2 || st.usedL1[code] {
		code = st.nextL1Code()
		source = "next"
	}
	st.usedL1[code] = true
	st.stripProjectTitle(project)
	if name == "" {
		name = project.Title
	}
	id := dbid.NewV7()
	node := &reconcileNode{
		id: id, projectID: project.ID, code: code, name: name,
		position: st.maxRootPosition() + 1, created: true,
	}
	st.nodes[id] = node
	st.order = append(st.order, id)
	st.roots = append(st.roots, id)
	st.report.NewRoots = append(st.report.NewRoots, CockpitReconcileNewRoot{ProjectID: util.UUIDToString(project.ID), NodeID: util.UUIDToString(id), Code: code, Title: name, Source: source})
	if st.projectTitles[project.ID] == "" {
		st.projectTitles[project.ID] = name
	}
}

// maxRootPosition is the largest root position; new roots append after it so
// two rows never share a sort position (len(roots) could collide with an
// imported board whose positions are not 0..n-1).
func (st *cockpitReconciler) maxRootPosition() float64 {
	max := -1.0
	for _, id := range st.roots {
		if n := st.nodes[id]; n != nil && n.position > max {
			max = n.position
		}
	}
	return max
}

// releaseReflowCodes frees the L1 numbers of removed workstream rows so a
// reflowed board numbers its new project rows from 01. The old rows' codes
// would otherwise keep 01–08 occupied and push the new roots to 09+.
func (st *cockpitReconciler) releaseReflowCodes() {
	if len(st.reflowedRoots) == 0 {
		return
	}
	for _, id := range st.reflowedRoots {
		delete(st.usedL1, trailingDigits(st.nodes[id].code))
	}
	st.reflowedRoots = nil
}

func (st *cockpitReconciler) projectHasRoot(project pgtype.UUID) bool {
	for _, id := range st.roots {
		if st.nodes[id].projectID == project {
			return true
		}
	}
	return false
}

func (st *cockpitReconciler) nextL1Code() string {
	max := 0
	for _, rootID := range st.roots {
		if n := trailingNumber(st.nodes[rootID].code); n > max {
			max = n
		}
	}
	for code := range st.usedL1 {
		if n := trailingNumber(code); n > max {
			max = n
		}
	}
	for {
		max++
		code := fmt.Sprintf("%02d", max)
		if !st.usedL1[code] {
			return code
		}
	}
}

func (st *cockpitReconciler) projectPathSuggestion(code, name string) string {
	root := ""
	for _, p := range st.projects {
		if p.CollabPath.Valid && p.CollabPath.String != "" {
			root = parentFolder(p.CollabPath.String)
			break
		}
	}
	if root == "" {
		return ""
	}
	return root + "/" + code + name
}

func (st *cockpitReconciler) assignModules() {
	bound := make(map[pgtype.UUID]pgtype.UUID) // module id -> the L2 row that holds it
	for _, rootID := range append([]pgtype.UUID(nil), st.roots...) {
		root := st.nodes[rootID]
		if root == nil || root.deleted || !root.projectID.Valid {
			continue
		}
		for _, l2ID := range st.children[rootID] {
			l2 := st.nodes[l2ID]
			if l2 == nil || l2.deleted {
				continue
			}
			if l2.projectID.Valid && l2.moduleID.Valid {
				bound[l2.moduleID] = l2ID
				continue
			}
			module, method, confirm, ok := st.matchModule(root.projectID, l2)
			if !ok {
				module = st.createModule(root.projectID, l2)
				st.report.NewModules = append(st.report.NewModules, CockpitReconcileNewModule{NodeID: util.UUIDToString(l2.id), ModuleID: util.UUIDToString(module.ID), Title: module.Title})
			} else if holder, clash := bound[module.ID]; clash {
				// Two rows claiming one module breaks the binding's unique
				// index on apply; name it instead of failing the transaction.
				st.report.Blockers = append(st.report.Blockers, fmt.Sprintf("module %q (%s) matched both %s and %s; resolve before apply", module.Title, util.UUIDToString(module.ID), st.nodes[holder].oldCode, l2.oldCode))
				continue
			} else {
				st.report.Modules = append(st.report.Modules, CockpitReconcileModule{NodeID: util.UUIDToString(l2.id), ModuleID: util.UUIDToString(module.ID), Title: module.Title, Method: method, NeedsReview: confirm})
				st.stripModuleTitle(module)
				bound[module.ID] = l2ID
			}
			l2.projectID = root.projectID
			l2.moduleID = module.ID
			l2.name = st.moduleIdx[module.ID].name
		}
	}
	// Modules without an L2 row get one under their project's L1.
	for _, module := range st.modules {
		if _, ok := bound[module.ID]; ok {
			continue
		}
		root := st.rootForProject(module.ProjectID)
		if root == nil {
			continue
		}
		info := st.moduleIdx[module.ID]
		code := info.code
		source := "title_prefix"
		if code == "" || !strings.HasPrefix(code, trailingDigits(root.code)+".") || st.usedCodes[code] {
			code = st.nextChildCode(root.code)
			source = "next"
		}
		st.usedCodes[code] = true
		id := dbid.NewV7()
		node := &reconcileNode{id: id, parentID: root.id, projectID: module.ProjectID, moduleID: module.ID, code: code, name: info.name, position: st.maxChildPosition(root.id) + 1, created: true}
		st.nodes[id] = node
		st.order = append(st.order, id)
		st.children[root.id] = append(st.children[root.id], id)
		bound[module.ID] = id
		st.report.NewModuleNodes = append(st.report.NewModuleNodes, CockpitReconcileNewModuleNode{ModuleID: util.UUIDToString(module.ID), NodeID: util.UUIDToString(id), Code: code, Title: info.name, Source: source})
	}
	st.rebuildTree()
}

// matchModule binds an L2 row to a module of its project, in the order the
// plan fixes: code AND name, then name alone (flagged for review), then code.
// l2.code is the DISPLAY code (applyCodes ran first), which is the numbering
// module titles carry. A module another row already bound is never returned.
func (st *cockpitReconciler) matchModule(projectID pgtype.UUID, l2 *reconcileNode) (db.Module, string, bool, bool) {
	_, name := splitReconcileTitle(l2.name)
	normalized := normalizeReconcileName(name)
	var byName, byCode []db.Module
	for _, m := range st.modules {
		if m.ProjectID != projectID {
			continue
		}
		info := st.moduleIdx[m.ID]
		if info == nil {
			continue
		}
		if info.code != "" && info.code == l2.code {
			byCode = append(byCode, m)
		}
		if normalizeReconcileName(info.name) == normalized {
			byName = append(byName, m)
		}
	}
	for _, m := range byCode {
		if normalizeReconcileName(st.moduleIdx[m.ID].name) == normalized {
			return m, "code_name", false, true
		}
	}
	if len(byCode) == 1 {
		return byCode[0], "code", true, true
	}
	if len(byName) == 1 {
		return byName[0], "name", true, true
	}
	return db.Module{}, "", false, false
}

func (st *cockpitReconciler) createModule(projectID pgtype.UUID, l2 *reconcileNode) db.Module {
	_, name := splitReconcileTitle(l2.name)
	id := dbid.NewV7()
	module := db.Module{ID: id, WorkspaceID: st.ws, ProjectID: projectID, Title: name}
	st.moduleIdx[id] = &reconcileModuleInfo{module: module, name: name}
	st.createdModules[id] = true
	return module
}

func (st *cockpitReconciler) stripModuleTitle(module db.Module) {
	code, name := splitReconcileTitle(module.Title)
	if code == "" || name == "" {
		return
	}
	st.moduleTitles[module.ID] = name
	st.report.TitleSplits = append(st.report.TitleSplits, CockpitReconcileTitleSplit{Kind: "module", ID: util.UUIDToString(module.ID), OldTitle: module.Title, NewTitle: name, Code: code})
}

func (st *cockpitReconciler) rootForProject(projectID pgtype.UUID) *reconcileNode {
	for _, id := range st.roots {
		if n := st.nodes[id]; n != nil && !n.deleted && n.projectID == projectID {
			return n
		}
	}
	return nil
}

func (st *cockpitReconciler) nextChildCode(parentCode string) string {
	max := 0
	for code := range st.usedCodes {
		if !strings.HasPrefix(code, parentCode+".") {
			continue
		}
		if n := trailingNumber(code); n > max {
			max = n
		}
	}
	for {
		max++
		code := fmt.Sprintf("%s.%02d", parentCode, max)
		if !st.usedCodes[code] {
			return code
		}
	}
}

// tryReflow handles a board whose L1 rows are workstreams rather than projects:
// every L2 maps by name to an existing module, so the L2s move under their
// modules' projects and the old L1 is removed. The whole old row is decided
// up front (all L2s mapped, no dependents) before any tree mutation, so a
// failed reflow leaves the board untouched.
func (st *cockpitReconciler) tryReflow(l1 *reconcileNode) bool {
	children := st.children[l1.id]
	if len(children) == 0 {
		return false
	}
	type group struct {
		project db.Project
		l2s     []pgtype.UUID
		modules []string
	}
	groups := make(map[pgtype.UUID]*group)
	var order []pgtype.UUID
	for _, l2ID := range children {
		l2 := st.nodes[l2ID]
		_, name := splitReconcileTitle(l2.name)
		var found *reconcileModuleInfo
		for _, m := range st.modules {
			info := st.moduleIdx[m.ID]
			if info == nil {
				continue
			}
			if normalizeReconcileName(info.name) == normalizeReconcileName(name) {
				if found != nil && found.module.ID != m.ID {
					return false
				}
				found = info
			}
		}
		if found == nil {
			return false
		}
		project := st.projectIdx[found.module.ProjectID]
		if project == nil {
			return false
		}
		g := groups[project.project.ID]
		if g == nil {
			g = &group{project: project.project}
			groups[project.project.ID] = g
			order = append(order, project.project.ID)
		}
		g.l2s = append(g.l2s, l2ID)
		g.modules = append(g.modules, util.UUIDToString(found.module.ID))
	}
	if len(groups) == 0 {
		return false
	}
	deps := st.dependents[l1.id]
	if deps.Payments > 0 || deps.IssueLinks > 0 || deps.MeetingLinks > 0 || deps.Artifacts > 0 {
		st.report.Blockers = append(st.report.Blockers, fmt.Sprintf("reflow %s: the workstream row still has payments/links", l1.oldCode))
		st.blockedRoots[l1.id] = true
		for _, projectID := range order {
			st.blockedProjects[projectID] = true
		}
		return false
	}
	reflow := CockpitReconcileReflow{OldRootID: util.UUIDToString(l1.id), OldCode: l1.oldCode, OldName: l1.name}
	// Projects take the L1 numbers in the original tree order of their first
	// L2 row (§3.2 item 7); usedL1 still holds the old row's code, freed later
	// by releaseReflowCodes, so numbers are assigned by order, not by lookup.
	seen := 1
	rootsByProject := make(map[pgtype.UUID]pgtype.UUID, len(order))
	for _, projectID := range order {
		g := groups[projectID]
		root := st.rootForProject(projectID)
		if root == nil {
			code := ""
			for {
				candidate := fmt.Sprintf("%02d", seen)
				seen++
				if !st.usedL1[candidate] {
					code = candidate
					break
				}
			}
			st.usedL1[code] = true
			id := dbid.NewV7()
			root = &reconcileNode{id: id, projectID: projectID, code: code, name: splitName(g.project.Title), position: st.maxRootPosition() + 1, created: true}
			st.nodes[id] = root
			st.order = append(st.order, id)
			st.roots = append(st.roots, id)
			st.stripProjectTitle(g.project)
			st.report.NewRoots = append(st.report.NewRoots, CockpitReconcileNewRoot{ProjectID: util.UUIDToString(projectID), NodeID: util.UUIDToString(id), Code: code, Title: root.name, Source: "reflow"})
		} else if !root.projectID.Valid {
			root.projectID = projectID
		}
		rootsByProject[projectID] = root.id
		appendPosition := st.maxChildPosition(root.id) + 1
		for i, l2ID := range g.l2s {
			l2 := st.nodes[l2ID]
			l2.parentID = root.id
			l2.projectID = projectID
			l2.position = appendPosition
			appendPosition++
			if moduleID, err := util.ParseUUID(g.modules[i]); err == nil {
				l2.moduleID = moduleID
				if info := st.moduleIdx[moduleID]; info != nil {
					l2.name = info.name
				}
			}
		}
		reflow.Projects = append(reflow.Projects, CockpitReconcileReflowProject{ProjectID: util.UUIDToString(projectID), L1NodeID: util.UUIDToString(root.id), Modules: g.modules})
	}
	if deps.Milestones > 0 {
		var target pgtype.UUID
		largest := -1
		for _, projectID := range order {
			if len(groups[projectID].l2s) > largest {
				largest = len(groups[projectID].l2s)
				target = rootsByProject[projectID]
			}
		}
		if target.Valid {
			reflow.Milestones = deps.Milestones
			st.milestonesMoves = append(st.milestonesMoves, milestoneMove{from: l1.id, to: target})
		}
	}
	l1.deleted = true
	st.reflowedRoots = append(st.reflowedRoots, l1.id)
	delete(st.children, l1.id)
	st.rebuildTree()
	st.report.Reflows = append(st.report.Reflows, reflow)
	return true
}

// milestonesMoves records reflow milestone reattachments.
type milestoneMove struct{ from, to pgtype.UUID }

// checkCrossProjectStatus defers cross-project workflow mapping to a human.
// The reconcile does not translate statuses (the platform's move logic lives
// on the issue update path); instead, an issue whose filing moves it into a
// project with a NAMED workflow that does not list its current status is left
// unfiled and reported, so nothing lands on a status the project forbids.
func (st *cockpitReconciler) checkCrossProjectStatus(ctx context.Context, q *db.Queries) error {
	defs := make(map[pgtype.UUID]*issueworkflow.Definition)
	for _, issue := range st.issues {
		filing := st.filings[issue.ID]
		if !filing.valid || !issue.ProjectID.Valid || filing.project == issue.ProjectID {
			continue
		}
		def := defs[filing.project]
		if def == nil {
			loaded, _, err := issueworkflow.ForProject(ctx, q, st.ws, filing.project)
			if err != nil {
				return err
			}
			// A default workflow accepts every status; only a named one limits.
			// The empty Definition marks "no restriction" via its nil Steps.
			def = &issueworkflow.Definition{}
			if loaded != nil && !loaded.IsDefault {
				def = loaded
			}
			defs[filing.project] = def
		}
		if def.Steps == nil || def.Has(issue.Status) {
			// Default or unrestricted: any current status survives the move.
			continue
		}
		filing.valid = false
		filing.note = "cross_project_status_not_in_workflow"
		st.filings[issue.ID] = filing
		st.unfiled[issue.ID] = "cross_project_status_not_in_workflow"
	}
	st.buildIssueReports()
	return nil
}

func splitName(title string) string {
	_, name := splitReconcileTitle(title)
	return name
}

// ---------------------------------------------------------------------------
// 4. Codes and directory names

// applyCodes renumbers the tree in position order. The pass runs twice: the
// first fixes display codes so module matching compares like with like, the
// second numbers rows assignModules appended. Only the first pass records code
// changes; the second pass compares each row's CURRENT code, so a row the
// first pass already renumbered (and reported) is not reported again, while a
// row created between the passes reports its first real code.
func (st *cockpitReconciler) applyCodes(record bool) {
	st.rebuildTree()
	report := func(id pgtype.UUID, kind, name, old, new string) {
		if !record {
			return
		}
		if old == new {
			return
		}
		for _, change := range st.report.CodeChanges {
			if change.NodeID == util.UUIDToString(id) && change.NewCode == new {
				return
			}
		}
		st.report.CodeChanges = append(st.report.CodeChanges, CockpitReconcileCodeChange{NodeID: util.UUIDToString(id), Kind: kind, Name: name, OldCode: old, NewCode: new})
	}
	var walk func(id pgtype.UUID, prefix string)
	walk = func(id pgtype.UUID, prefix string) {
		ordinal := 0
		for _, childID := range st.children[id] {
			ordinal++
			child := st.nodes[childID]
			code := fmt.Sprintf("%s.%02d", prefix, ordinal)
			if ordinal == 1 && reconcileZeroSegmentCode.MatchString(child.code) {
				code = child.code
				ordinal = 0
			}
			child.code = code
			st.usedCodes[code] = true
			report(childID, st.kind(childID), child.name, child.oldCode, code)
			walk(childID, code)
		}
	}
	for i, rootID := range st.roots {
		root := st.nodes[rootID]
		code := trailingDigits(root.code)
		if code == "" {
			code = fmt.Sprintf("%02d", i+1)
		}
		root.code = code
		st.usedCodes[code] = true
		report(rootID, "project", root.name, root.oldCode, code)
		walk(rootID, code)
	}
}

func (st *cockpitReconciler) computeDirectoryNames() {
	for _, id := range st.order {
		n := st.nodes[id]
		if n == nil || n.deleted || st.depth(id) == 0 {
			continue
		}
		if n.directory.Valid && n.directory.String != "" {
			st.report.DirectoryNames = append(st.report.DirectoryNames, CockpitReconcileDirectory{NodeID: util.UUIDToString(id), Code: n.code, Name: n.name, DirectoryName: n.directory.String, Source: "existing"})
			continue
		}
		name := n.code + n.name
		n.directory = pgtype.Text{String: name, Valid: true}
		st.report.DirectoryNames = append(st.report.DirectoryNames, CockpitReconcileDirectory{NodeID: util.UUIDToString(id), Code: n.code, Name: n.name, DirectoryName: name, Source: "computed"})
	}
}

// ---------------------------------------------------------------------------
// 5. Issue backfill

func (st *cockpitReconciler) backfillIssues() {
	workItems := make(map[pgtype.UUID]reconcileFiling)
	for _, n := range st.nodes {
		if n == nil || n.deleted || !n.parentID.Valid {
			continue
		}
		parent := st.nodes[n.parentID]
		if parent == nil || !parent.moduleID.Valid {
			continue
		}
		workItems[n.id] = reconcileFiling{workItem: n.id, project: parent.projectID, module: parent.moduleID, valid: true}
	}
	byModuleCode := make(map[string]reconcileFiling)
	byProjectCode := make(map[string]reconcileFiling)
	for id, filing := range workItems {
		code := st.nodes[id].code
		byModuleCode[util.UUIDToString(filing.module)+"|"+code] = filing
		byProjectCode[util.UUIDToString(filing.project)+"|"+code] = filing
	}
	linksByIssue := make(map[pgtype.UUID][]pgtype.UUID)
	for _, link := range st.links {
		if _, ok := st.issueIdx[link.IssueID]; !ok {
			st.danglingLinks++
			continue
		}
		linksByIssue[link.IssueID] = append(linksByIssue[link.IssueID], link.NodeID)
	}
	for i := range st.issues {
		issue := &st.issues[i]
		var candidate reconcileFiling
		switch {
		case issue.WorkItemID.Valid && workItems[issue.WorkItemID].valid:
			candidate = workItems[issue.WorkItemID]
			candidate.rule = "already_filed"
		default:
			var l3 []reconcileFiling
			for _, nodeID := range linksByIssue[issue.ID] {
				if filing, ok := workItems[nodeID]; ok {
					l3 = append(l3, filing)
				}
			}
			if len(l3) == 1 {
				candidate = l3[0]
				candidate.rule = "single_work_item"
			} else if len(l3) > 1 {
				var same []reconcileFiling
				for _, filing := range l3 {
					if filingMatchesIssue(filing, issue) {
						same = append(same, filing)
					}
				}
				if len(same) == 1 {
					candidate = same[0]
					candidate.rule = "one_of_many"
				}
			} else if code := issueTitleCode(issue.Title); code != "" {
				// Title codes are human-typed text, so the plan scopes the
				// lookup to the issue's own module; only an issue with no
				// module searches its project (and gains the module it finds).
				// A code that lands in ANOTHER module of the project is not
				// enough evidence to move the issue — it is reported instead.
				if issue.ModuleID.Valid {
					if filing, ok := byModuleCode[util.UUIDToString(issue.ModuleID)+"|"+code]; ok {
						candidate = filing
						candidate.rule = "title_code"
					} else if _, ok := byProjectCode[util.UUIDToString(issue.ProjectID)+"|"+code]; ok && issue.ProjectID.Valid {
						st.unfiled[issue.ID] = "title_code_other_module"
					}
				} else if issue.ProjectID.Valid {
					if filing, ok := byProjectCode[util.UUIDToString(issue.ProjectID)+"|"+code]; ok {
						candidate = filing
						candidate.rule = "title_code"
					}
				}
			}
		}
		if !candidate.valid {
			// Only issues that carried evidence are reported: a link set or a
			// title code the backfill could not resolve. An issue with neither
			// was never a candidate, and listing every one of them (over a
			// thousand in production) would bury the ones a human must decide.
			reason := st.unfiled[issue.ID]
			if reason == "" {
				switch {
				case len(linksByIssue[issue.ID]) == 0 && issueTitleCode(issue.Title) != "":
					reason = "title_code_unmatched"
				case len(linksByIssue[issue.ID]) == 0:
					reason = ""
				case len(workItemLinks(linksByIssue[issue.ID], workItems)) == 0:
					reason = "only_structural_links"
				default:
					reason = "ambiguous_links"
				}
			}
			st.unfiled[issue.ID] = reason
		}
		st.filings[issue.ID] = candidate
	}
	st.applyParentFiling()
	st.buildIssueReports()
}

// buildIssueReports regenerates the applied and unfiled sections from
// st.filings. It is rebuildable on purpose: checkCrossProjectStatus invalidates
// filings after the backfill, and a report that still listed them as moves
// would describe an apply that no longer matches the transaction.
func (st *cockpitReconciler) buildIssueReports() {
	st.report.Issues = nil
	st.report.Unfiled = nil
	for _, issue := range st.issues {
		filing := st.filings[issue.ID]
		if !filing.valid {
			// Only issues with evidence are named; see backfillIssues. A row
			// with no reason would read as "nothing to do" anyway.
			reason := st.unfiled[issue.ID]
			if reason == "" {
				continue
			}
			st.report.Unfiled = append(st.report.Unfiled, CockpitReconcileUnfiled{
				IssueID: util.UUIDToString(issue.ID), Identifier: fmt.Sprintf("#%d", issue.Number), Reason: reason,
			})
			continue
		}
		if filing.workItem == issue.WorkItemID && filing.project == issue.ProjectID && filing.module == issue.ModuleID {
			continue
		}
		st.report.Issues = append(st.report.Issues, CockpitReconcileIssue{
			IssueID: util.UUIDToString(issue.ID), Identifier: fmt.Sprintf("#%d", issue.Number), Rule: filing.rule,
			OldWorkItem: reconcileUUID(issue.WorkItemID), NewWorkItem: reconcileUUID(filing.workItem),
			OldProject: reconcileUUID(issue.ProjectID), NewProject: reconcileUUID(filing.project), Note: filing.note,
		})
	}
}

// workItemLinks filters a link set down to the nodes that can host a filing.
func workItemLinks(links []pgtype.UUID, workItems map[pgtype.UUID]reconcileFiling) []pgtype.UUID {
	var out []pgtype.UUID
	for _, id := range links {
		if workItems[id].valid {
			out = append(out, id)
		}
	}
	return out
}

func filingMatchesIssue(filing reconcileFiling, issue *db.ListCockpitReconcileIssuesRow) bool {
	if issue.ModuleID.Valid {
		return filing.module == issue.ModuleID
	}
	return issue.ProjectID.Valid && filing.project == issue.ProjectID
}

func issueTitleCode(title string) string {
	m := reconcileIssueTitleCode.FindStringSubmatch(title)
	if m == nil {
		return ""
	}
	return m[1]
}

// applyParentFiling enforces I4: a child follows its parent's work item, and a
// child that matched while its parent did not is left unfiled for review.
func (st *cockpitReconciler) applyParentFiling() {
	depth := make(map[pgtype.UUID]int, len(st.issues))
	var depthOf func(id pgtype.UUID) int
	depthOf = func(id pgtype.UUID) int {
		if d, ok := depth[id]; ok {
			return d
		}
		issue := st.issueIdx[id]
		if issue == nil || !issue.ParentIssueID.Valid || st.issueIdx[issue.ParentIssueID] == nil {
			depth[id] = 0
			return 0
		}
		d := depthOf(issue.ParentIssueID) + 1
		depth[id] = d
		return d
	}
	sorted := append([]db.ListCockpitReconcileIssuesRow(nil), st.issues...)
	sort.SliceStable(sorted, func(i, j int) bool {
		di, dj := depthOf(sorted[i].ID), depthOf(sorted[j].ID)
		if di != dj {
			return di < dj
		}
		return sorted[i].Number < sorted[j].Number
	})
	for i := range sorted {
		issue := sorted[i]
		if !issue.ParentIssueID.Valid {
			continue
		}
		parent, ok := st.filings[issue.ParentIssueID]
		if !ok || !parent.valid {
			if child := st.filings[issue.ID]; child.valid && child.rule != "already_filed" {
				child.valid = false
				child.note = "child_matched_without_parent"
				st.filings[issue.ID] = child
				st.unfiled[issue.ID] = "child_matched_without_parent"
			}
			continue
		}
		child := st.filings[issue.ID]
		if !child.valid || child.workItem != parent.workItem {
			// The override flag compares the child's OWN computed filing: the
			// stored work_item_id is empty before the migration, so keying on
			// it never flagged anything. A matched child (or an already-filed
			// one pointing elsewhere) that the parent moves is the case §3.3
			// wants named.
			overridden := child.valid && child.workItem != parent.workItem
			child = parent
			child.rule = "followed_parent"
			if overridden {
				child.note = "parent_overrode_child"
			}
			st.filings[issue.ID] = child
		}
	}
}

// ---------------------------------------------------------------------------
// Apply

func (st *cockpitReconciler) apply() error {
	// Projects first: nodes and modules below point at them.
	for id := range st.createdProjects {
		info := st.projectIdx[id]
		project := info.project
		if project.Title == "" {
			project.Title = info.name
		}
		if _, err := st.q.CreateProjectForReconcile(st.ctx, db.CreateProjectForReconcileParams{
			ID: id, WorkspaceID: st.ws, Title: project.Title, Status: "in_progress",
			CollabPath: project.CollabPath,
		}); err != nil {
			return err
		}
	}
	for id, title := range st.projectTitles {
		if err := st.q.UpdateProjectTitle(st.ctx, db.UpdateProjectTitleParams{WorkspaceID: st.ws, ID: id, Title: title}); err != nil {
			return err
		}
	}
	// Modules before the L2 rows that bind them.
	for id := range st.createdModules {
		info := st.moduleIdx[id]
		if _, err := st.q.CreateModuleForReconcile(st.ctx, db.CreateModuleForReconcileParams{
			ID: id, WorkspaceID: st.ws, ProjectID: info.module.ProjectID, Title: info.name,
		}); err != nil {
			return err
		}
	}
	for id, title := range st.moduleTitles {
		if err := st.q.UpdateModuleTitle(st.ctx, db.UpdateModuleTitleParams{WorkspaceID: st.ws, ID: id, Title: title}); err != nil {
			return err
		}
	}
	// Nodes: create parents before children. Renumbering runs in two phases
	// because (cockpit_id, code) is unique: writing 02.10's new code 02.03
	// while the merged-away 02.03 row still exists violates the index, and a
	// swap (A↔B) can never work row by row. Rows are deleted first, then every
	// renumbered row moves to a temporary code, then to its final code.
	var created []*reconcileNode
	for _, n := range st.nodes {
		if n.created {
			created = append(created, n)
		}
	}
	sort.SliceStable(created, func(i, j int) bool { return st.depth(created[i].id) < st.depth(created[j].id) })
	// New rows are created with their FINAL code: their old codes never existed
	// in the table, so they cannot collide with a surviving row's old code.
	for _, n := range created {
		if _, err := st.q.CreateCockpitReconcileNode(st.ctx, db.CreateCockpitReconcileNodeParams{
			ID: n.id, WorkspaceID: st.ws, CockpitID: st.board.ID, ParentID: n.parentID,
			ProjectID: n.projectID, ModuleID: n.moduleID, Code: n.code, Name: n.name,
			Position: n.position, DirectoryName: n.directory,
		}); err != nil {
			return err
		}
	}
	structure := func(n *reconcileNode, code string) db.UpdateCockpitNodeStructureParams {
		return db.UpdateCockpitNodeStructureParams{
			WorkspaceID: st.ws, ID: n.id, ParentID: n.parentID, ProjectID: n.projectID, ModuleID: n.moduleID,
			Code: code, Name: n.name, Position: n.position,
		}
	}
	// Milestones move off a removed workstream row BEFORE the row goes.
	for _, move := range st.milestonesMoves {
		if err := st.q.MoveCockpitMilestonesToNode(st.ctx, db.MoveCockpitMilestonesToNodeParams{WorkspaceID: st.ws, FromNodeID: move.from, NodeID: move.to}); err != nil {
			return err
		}
	}
	for _, id := range st.order {
		if n := st.nodes[id]; n != nil && n.deleted {
			if err := st.q.DeleteCockpitNodeRow(st.ctx, db.DeleteCockpitNodeRowParams{WorkspaceID: st.ws, ID: id}); err != nil {
				return err
			}
		}
	}
	changed := make([]*reconcileNode, 0)
	for _, id := range st.order {
		n := st.nodes[id]
		if n == nil || n.created || n.deleted {
			continue
		}
		if n.parentID == n.oldParentID && n.projectID == n.oldProject && n.moduleID == n.oldModule &&
			n.code == n.oldCode && n.name == n.oldName && n.directory == n.oldDirectory && n.position == n.oldPosition {
			continue
		}
		changed = append(changed, n)
	}
	// Phase 1: every changed row that keeps existing takes a code no row can
	// hold — "~<id>" is not a valid outline code, so the unique index is safe.
	for _, n := range changed {
		if n.code == n.oldCode {
			continue
		}
		if err := st.q.UpdateCockpitNodeStructure(st.ctx, structure(n, "~"+util.UUIDToString(n.id))); err != nil {
			return err
		}
	}
	// Phase 2: final codes. No two surviving rows share one.
	for _, n := range changed {
		if err := st.q.UpdateCockpitNodeStructure(st.ctx, structure(n, n.code)); err != nil {
			return err
		}
		if n.directory.Valid && n.directory.String != "" {
			if err := st.q.SetCockpitNodeDirectoryName(st.ctx, db.SetCockpitNodeDirectoryNameParams{WorkspaceID: st.ws, ID: n.id, DirectoryName: n.directory.String}); err != nil {
				return err
			}
		}
	}
	for _, issue := range st.issues {
		filing := st.filings[issue.ID]
		if !filing.valid {
			continue
		}
		if filing.workItem == issue.WorkItemID && filing.project == issue.ProjectID && filing.module == issue.ModuleID {
			continue
		}
		if err := st.q.SetIssueWorkItem(st.ctx, db.SetIssueWorkItemParams{
			WorkspaceID: st.ws, IssueID: issue.ID, WorkItemID: filing.workItem, ProjectID: filing.project, ModuleID: filing.module,
		}); err != nil {
			return err
		}
	}
	if err := st.q.DeleteDanglingCockpitNodeIssue(st.ctx, st.ws); err != nil {
		return err
	}
	for _, id := range st.order {
		n := st.nodes[id]
		if n == nil || n.deleted {
			continue
		}
		if _, err := st.q.RecordCockpitUsedCode(st.ctx, db.RecordCockpitUsedCodeParams{WorkspaceID: st.ws, CockpitID: st.board.ID, Code: n.code}); err != nil {
			return err
		}
	}
	if payload, err := json.Marshal(st.report); err == nil {
		if err := st.q.SaveCockpitReconcileReport(st.ctx, db.SaveCockpitReconcileReportParams{WorkspaceID: st.ws, Report: payload}); err != nil {
			return err
		}
	} else {
		return err
	}
	if err := st.q.MarkCockpitPlanReconciled(st.ctx, st.ws); err != nil {
		return err
	}
	return nil
}

func reconcileUUID(id pgtype.UUID) string {
	if !id.Valid {
		return ""
	}
	return util.UUIDToString(id)
}

func trailingDigits(code string) string {
	trimmed := strings.TrimSpace(code)
	i := len(trimmed)
	for i > 0 && trimmed[i-1] >= '0' && trimmed[i-1] <= '9' {
		i--
	}
	if i == len(trimmed) {
		return ""
	}
	return trimmed[i:]
}

func trailingNumber(code string) int {
	digits := trailingDigits(code)
	if digits == "" {
		return 0
	}
	n := 0
	for _, r := range digits {
		n = n*10 + int(r-'0')
	}
	return n
}

func splitReconcileTitle(title string) (code, name string) {
	m := reconcileTitlePrefix.FindStringSubmatch(title)
	if m == nil {
		return "", strings.TrimSpace(title)
	}
	return m[1], strings.TrimSpace(title[len(m[0]):])
}

func normalizeReconcileName(name string) string {
	return strings.ToLower(strings.Join(strings.Fields(name), ""))
}

func parentFolder(path string) string {
	path = strings.TrimRight(path, "/")
	if i := strings.LastIndex(path, "/"); i > 0 {
		return path[:i]
	}
	return ""
}
