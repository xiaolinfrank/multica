package service

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/issueworkflow"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type milestoneMove struct{ from, to pgtype.UUID }

// checkCrossProjectStatus defers cross-project workflow mapping to a human.
// The reconcile does not translate statuses (the platform's move logic lives
// on the issue update path); instead, an issue whose filing moves it into a
// project with a NAMED workflow that does not list its current status is left
// unfiled and reported, so nothing lands on a status the project forbids.
// "Moves" includes an issue with no project gaining one — the update path
// counts that as a project move too (projectMoving).
// When one member of an issue family is held, the whole family is held and
// each row is listed with its own reason: a parent filing that its child
// cannot follow would break I4 on the very first write after the migration.
func (st *cockpitReconciler) checkCrossProjectStatus(ctx context.Context, q *db.Queries) error {
	defs := make(map[pgtype.UUID]*issueworkflow.Definition)
	allows := func(filing reconcileFiling, issue *db.ListCockpitReconcileIssuesRow) (bool, error) {
		if filing.project == issue.ProjectID {
			return true, nil
		}
		def := defs[filing.project]
		if def == nil {
			loaded, _, err := issueworkflow.ForProject(ctx, q, st.ws, filing.project)
			if err != nil {
				// A failed lookup is not a decision: reporting it as "held"
				// would hide the error, and inside apply the transaction is
				// already aborted by then.
				return false, err
			}
			// A default workflow accepts every status; only a named one limits.
			// The empty Definition marks "no restriction" via its nil Steps.
			def = &issueworkflow.Definition{}
			if loaded != nil && !loaded.IsDefault {
				def = loaded
			}
			defs[filing.project] = def
		}
		return def.Steps == nil || def.Has(issue.Status), nil
	}
	held := make(map[pgtype.UUID]bool)
	// Families: hold the ROOT first so descendants follow for the reason of
	// their own filing, not a blanket one.
	familyRoot := func(id pgtype.UUID) pgtype.UUID {
		seen := map[pgtype.UUID]bool{id: true}
		for issue := st.issueIdx[id]; issue != nil && issue.ParentIssueID.Valid; {
			parent := st.issueIdx[issue.ParentIssueID]
			if parent == nil || seen[parent.ID] {
				break
			}
			seen[parent.ID] = true
			id = parent.ID
			issue = parent
		}
		return id
	}
	members := func(root pgtype.UUID) []pgtype.UUID {
		out := []pgtype.UUID{root}
		for i := 0; i < len(out); i++ {
			for _, issue := range st.issues {
				if issue.ParentIssueID == out[i] {
					out = append(out, issue.ID)
				}
			}
		}
		return out
	}
	for i := range st.issues {
		issue := &st.issues[i]
		filing := st.filings[issue.ID]
		if !filing.valid || held[issue.ID] {
			continue
		}
		ok, err := allows(filing, issue)
		if err != nil {
			return err
		}
		if ok {
			continue
		}
		// Hold the whole family: the parent's filing cannot strand children
		// (I4), and a child cannot move where its parent stays.
		root := familyRoot(issue.ID)
		for _, member := range members(root) {
			memberFiling := st.filings[member]
			if memberFiling.valid {
				reason := "family_cross_project_status"
				if member == issue.ID {
					reason = "cross_project_status_not_in_workflow"
				}
				memberFiling.valid = false
				memberFiling.note = reason
				st.filings[member] = memberFiling
				st.unfiled[member] = reason
			}
			held[member] = true
		}
	}
	st.buildIssueReports()
	return nil
}

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
			// thousand in production) would bury the ones a human must decide;
			// they are counted instead.
			reason := st.unfiled[issue.ID]
			if reason == "" {
				switch {
				case len(linksByIssue[issue.ID]) == 0 && issueTitleCode(issue.Title) != "":
					reason = "title_code_unmatched"
				case len(linksByIssue[issue.ID]) == 0:
					// Counted once the filings are final (buildIssueReports): a
					// child with no evidence still gets filed by its parent, so
					// incrementing here would overcount.
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
	st.report.UnfiledWithoutEvidence = 0
	for _, issue := range st.issues {
		filing := st.filings[issue.ID]
		if !filing.valid {
			// Only issues with evidence are named; see backfillIssues. A row
			// with no reason would read as "nothing to do" anyway.
			reason := st.unfiled[issue.ID]
			if reason == "" {
				// No evidence (no links, no title code): never a candidate, so
				// not listed; the total still has to be visible.
				st.report.UnfiledWithoutEvidence++
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
	// New rows are created with a TEMPORARY code ("~<id>"): a created row's
	// final code can equal an old row's code that the merge deletes below
	// (fosun-bio: a module backfilled as 03.04 while the merged-away 03.04
	// still exists). They take their final codes with every other changed row
	// in phase 2.
	for _, n := range created {
		if _, err := st.q.CreateCockpitReconcileNode(st.ctx, db.CreateCockpitReconcileNodeParams{
			ID: n.id, WorkspaceID: st.ws, CockpitID: st.board.ID, ParentID: n.parentID,
			ProjectID: n.projectID, ModuleID: n.moduleID, Code: "~" + util.UUIDToString(n.id), Name: n.name,
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
	// Phase 2: final codes, for changed existing rows AND the created rows
	// still on their temporary codes. No two surviving rows share one.
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
	for _, n := range created {
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
