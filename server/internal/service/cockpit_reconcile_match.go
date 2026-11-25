package service

import (
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

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
	// Number every new root AFTER the reflowed rows release theirs, in root
	// position order: pmo-showcase's L1-01..L1-08 held 01–08 until now, so an
	// earlier nextL1Code() handed 09 to a project that should own 01. The
	// freed numbers go to the earliest-position new roots (§3.2 item 7).
	st.releaseReflowCodes()
	st.assignDeferredRootCodes()
	st.rebuildTree()
}

// assignDeferredRootCodes gives every created root its final L1 number, in
// root position order, taking the smallest free number each time. Called once,
// after reflowed rows released theirs, so a reflowed board numbers from 01.
func (st *cockpitReconciler) assignDeferredRootCodes() {
	deferred := make([]*reconcileNode, 0)
	for _, id := range st.roots {
		if n := st.nodes[id]; n != nil && n.created && n.pendingCode {
			deferred = append(deferred, n)
		}
	}
	if len(deferred) == 0 {
		return
	}
	// Rebuild the claim set from every surviving row that already owns a
	// number — existing roots AND the created title_prefix roots, whose number
	// is theirs by title. A deferred root's provisional number is left out: it
	// may coincide with a claim above, and deleting by code would strip that
	// claim rather than the deferred row's own.
	st.usedL1 = make(map[string]bool)
	for _, id := range st.roots {
		if n := st.nodes[id]; n != nil && !n.deleted && !n.pendingCode {
			st.usedL1[trailingDigits(n.code)] = true
		}
	}
	for _, n := range deferred {
		n.code = ""
	}
	next := 1
	for _, n := range deferred {
		var code string
		for {
			candidate := fmt.Sprintf("%02d", next)
			next++
			if !st.usedL1[candidate] {
				code = candidate
				break
			}
		}
		st.usedL1[code] = true
		n.code = code
		st.report.NewRoots = append(st.report.NewRoots, CockpitReconcileNewRoot{ProjectID: util.UUIDToString(n.projectID), NodeID: util.UUIDToString(n.id), Code: code, Title: n.name, Source: n.rootSource})
	}
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
	pending := false
	if code == "" || len(code) > 2 || st.usedL1[code] {
		// The title's number is unusable or already held by a surviving row:
		// leave the code empty so the deferred pass assigns a free one.
		source, code = "next", ""
		pending = true
	}
	st.stripProjectTitle(project)
	if name == "" {
		name = project.Title
	}
	if !pending {
		// A usable title number is the row's own and is kept as-is (§3.2 item 3,
		// §0 item 16): claim it now so the deferred pass cannot hand it away.
		st.usedL1[code] = true
	}
	id := dbid.NewV7()
	node := &reconcileNode{
		id: id, projectID: project.ID, code: code, name: name,
		position: st.maxRootPosition() + 1, created: true,
		pendingCode: pending, rootSource: source,
	}
	st.nodes[id] = node
	st.order = append(st.order, id)
	st.roots = append(st.roots, id)
	if !pending {
		st.report.NewRoots = append(st.report.NewRoots, CockpitReconcileNewRoot{ProjectID: util.UUIDToString(project.ID), NodeID: util.UUIDToString(id), Code: code, Title: name, Source: source})
	}
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
	// Pre-bound rows claim their modules BEFORE any matching runs: a row that
	// already holds a binding is the authority, and a later name match on the
	// same module must be the one reported, not the reverse.
	for _, rootID := range append([]pgtype.UUID(nil), st.roots...) {
		root := st.nodes[rootID]
		if root == nil || root.deleted || !root.projectID.Valid {
			continue
		}
		for _, l2ID := range st.children[rootID] {
			l2 := st.nodes[l2ID]
			if l2 == nil || l2.deleted || !l2.projectID.Valid || !l2.moduleID.Valid {
				continue
			}
			if holder, clash := bound[l2.moduleID]; clash {
				st.report.Blockers = append(st.report.Blockers, fmt.Sprintf("module %q (%s) already bound to %s and %s; resolve before apply", st.moduleIdx[l2.moduleID].module.Title, util.UUIDToString(l2.moduleID), st.nodes[holder].oldCode, l2.oldCode))
				continue
			}
			bound[l2.moduleID] = l2ID
		}
	}
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
		st.stripModuleTitle(module)
		st.report.NewModuleNodes = append(st.report.NewModuleNodes, CockpitReconcileNewModuleNode{ModuleID: util.UUIDToString(module.ID), NodeID: util.UUIDToString(id), Code: code, Title: info.name, Source: source})
	}
	st.rebuildTree()
}

// matchModule binds an L2 row to a module of its project, in the order the
// plan fixes: code AND name, then name alone (flagged for review), then code.
// l2.code is the DISPLAY code (applyCodes ran first), which is the numbering
// module titles carry. A module another row already holds is still returned;
// assignModules turns the second claim into a blocker.
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
	if len(byName) == 1 {
		return byName[0], "name", true, true
	}
	if len(byCode) == 1 {
		return byCode[0], "code", true, true
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
	rootsByProject := make(map[pgtype.UUID]pgtype.UUID, len(order))
	for _, projectID := range order {
		g := groups[projectID]
		root := st.rootForProject(projectID)
		if root == nil {
			// A provisional code: assignDeferredRootCodes numbers every new
			// root in position order once reflowed rows release theirs, so a
			// board whose old L1s held 01–08 still numbers its projects 01+.
			id := dbid.NewV7()
			root = &reconcileNode{id: id, projectID: projectID, code: st.nextL1Code(), name: splitName(g.project.Title), position: st.maxRootPosition() + 1, created: true, pendingCode: true, rootSource: "reflow"}
			st.nodes[id] = root
			st.order = append(st.order, id)
			st.roots = append(st.roots, id)
			st.stripProjectTitle(g.project)
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
		// Keep a bound module's existing folder name when it already has one so
		// the L2 row and its module never drift onto separate NAS folders.
		if st.depth(id) == 1 && n.moduleID.Valid {
			if info := st.moduleIdx[n.moduleID]; info != nil && info.module.DirectoryName.Valid && info.module.DirectoryName.String != "" {
				n.directory = info.module.DirectoryName
				st.report.DirectoryNames = append(st.report.DirectoryNames, CockpitReconcileDirectory{NodeID: util.UUIDToString(id), Code: n.code, Name: n.name, DirectoryName: n.directory.String, Source: "existing"})
				continue
			}
		}
		name := n.code + n.name
		n.directory = pgtype.Text{String: name, Valid: true}
		st.report.DirectoryNames = append(st.report.DirectoryNames, CockpitReconcileDirectory{NodeID: util.UUIDToString(id), Code: n.code, Name: n.name, DirectoryName: name, Source: "computed"})
	}
}

// ---------------------------------------------------------------------------
// 5. Issue backfill
