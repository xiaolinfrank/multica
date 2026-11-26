package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/multica-ai/multica/server/internal/cli"
)

const minShortIDPrefixLen = 4
const resolverListPageLimit = 50

type resolvedID struct {
	ID string
	// Display is a best-effort label for human-facing messages. It may equal
	// ID when resolution does not fetch display metadata from the server.
	Display string
	// Archived is set when the prefix matched only an archived candidate. A
	// full UUID is not looked up, so it never sets this.
	Archived bool
}

type idCandidate struct {
	ID      string
	Display string
	Detail  string
	// Archived candidates only resolve when no live candidate matches the
	// prefix, so an archived project never makes a live one ambiguous.
	Archived bool
}

func displayID(id string, full bool) string {
	if full {
		return id
	}
	return truncateID(id)
}

func issueDisplayKey(issue map[string]any) string {
	if key := strVal(issue, "identifier"); key != "" {
		return key
	}
	id := strVal(issue, "id")
	if id != "" {
		slog.Warn("issue response missing identifier", "issue_id", id)
	}
	return id
}

func issueCandidate(issue map[string]any) idCandidate {
	return idCandidate{
		ID:      strVal(issue, "id"),
		Display: issueDisplayKey(issue),
		Detail:  strVal(issue, "title"),
	}
}

func normalizeUUIDPrefix(input string) (string, error) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return "", fmt.Errorf("id is required")
	}
	prefix := strings.ToLower(strings.ReplaceAll(trimmed, "-", ""))
	if len(prefix) < minShortIDPrefixLen {
		return "", fmt.Errorf("expected a full UUID or at least %d hex characters, got %q", minShortIDPrefixLen, input)
	}
	for _, r := range prefix {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return "", fmt.Errorf("expected a UUID prefix containing only hex characters, got %q", input)
		}
	}
	return prefix, nil
}

func compactUUID(id string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(id), "-", ""))
}

const defaultListHint = "run the list command with --full-id"

func resolveIDByPrefix(ctx context.Context, client *cli.APIClient, kind, input string, fetch func(context.Context, *cli.APIClient) ([]idCandidate, error)) (resolvedID, error) {
	return resolveIDByPrefixWithListHint(ctx, client, kind, input, defaultListHint, fetch)
}

// resolveIDByPrefixWithListHint is resolveIDByPrefix for resources whose list
// command needs a different hint, e.g. one that always prints full UUIDs and
// has no --full-id flag. listHint completes "Use more characters or ...".
func resolveIDByPrefixWithListHint(ctx context.Context, client *cli.APIClient, kind, input, listHint string, fetch func(context.Context, *cli.APIClient) ([]idCandidate, error)) (resolvedID, error) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return resolvedID{}, fmt.Errorf("%s id is required", kind)
	}
	if uuidRegexp.MatchString(trimmed) {
		return resolvedID{ID: trimmed, Display: trimmed}, nil
	}

	prefix, err := normalizeUUIDPrefix(trimmed)
	if err != nil {
		return resolvedID{}, fmt.Errorf("resolve %s: %w", kind, err)
	}

	candidates, err := fetch(ctx, client)
	if err != nil {
		return resolvedID{}, fmt.Errorf("resolve %s: %w", kind, err)
	}

	matches := make([]idCandidate, 0, 1)
	for _, c := range candidates {
		if c.ID == "" {
			continue
		}
		if strings.HasPrefix(compactUUID(c.ID), prefix) {
			matches = append(matches, c)
		}
	}

	live := make([]idCandidate, 0, len(matches))
	for _, m := range matches {
		if !m.Archived {
			live = append(live, m)
		}
	}
	if len(live) > 0 {
		matches = live
	}

	switch len(matches) {
	case 0:
		return resolvedID{}, fmt.Errorf("no %s found matching id prefix %q; %s to copy the full UUID", kind, input, listHint)
	case 1:
		display := matches[0].Display
		if display == "" {
			display = matches[0].ID
		}
		return resolvedID{ID: matches[0].ID, Display: display, Archived: matches[0].Archived}, nil
	default:
		return resolvedID{}, ambiguousIDPrefixErrorWithListHint(kind, input, listHint, matches)
	}
}

func ambiguousIDPrefixError(kind, input string, matches []idCandidate) error {
	return ambiguousIDPrefixErrorWithListHint(kind, input, defaultListHint, matches)
}

func ambiguousIDPrefixErrorWithListHint(kind, input, listHint string, matches []idCandidate) error {
	sort.Slice(matches, func(i, j int) bool {
		return matches[i].ID < matches[j].ID
	})
	parts := make([]string, 0, len(matches))
	for _, m := range matches {
		parts = append(parts, "  "+m.ID)
	}
	return fmt.Errorf("ambiguous %s id prefix %q; matches:\n%s\nUse more characters or %s", kind, input, strings.Join(parts, "\n"), listHint)
}

// resolveIssueRef accepts only the two canonical issue references:
//
//   - the human-facing issue key, e.g. "MUL-1852" (validated by
//     looksLikeIssueIdentifier and resolved server-side);
//   - the full UUID in dashed canonical form (validated by uuidRegexp).
//
// Short UUID prefixes (e.g. "1881abcd") were briefly supported but are no
// longer — on large workspaces the CLI had to page the entire issue list
// client-side to disambiguate, causing 14–35s timeouts (GH #4701). Since
// `MUL-123` already covers every human use case for an issue reference, the
// short-prefix path is removed instead of being moved server-side. Other
// resources without a human-readable key (autopilots, projects, labels,
// task runs, workspaces, ...) continue to accept short UUID prefixes; see
// resolveIDByPrefix.
func resolveIssueRef(ctx context.Context, client *cli.APIClient, input string) (resolvedID, error) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return resolvedID{}, fmt.Errorf("issue id is required")
	}

	if looksLikeIssueIdentifier(trimmed) {
		return fetchIssueRef(ctx, client, trimmed)
	}
	if uuidRegexp.MatchString(trimmed) {
		// A full UUID is self-identifying: the resolver GET added a round
		// trip and no information, and agents pay it several times per run
		// during bootstrap (GH #7017). Lowercased to the canonical form the
		// server emits. Messages without an issue response may show this UUID
		// rather than the issue key, and failures now come from the command's
		// next issue-aware endpoint. Every write path re-validates server-side
		// (e.g. parent_issue_id on create), so nothing is stored on the strength
		// of the ref alone.
		id := strings.ToLower(trimmed)
		return resolvedID{ID: id, Display: id}, nil
	}

	// Detect the common "I copied a truncated UUID" case and give a
	// tailored hint. normalizeUUIDPrefix succeeds for any input that is
	// ≥4 hex chars (after stripping dashes), which matches what the old
	// resolver used to accept as a prefix.
	if _, err := normalizeUUIDPrefix(trimmed); err == nil {
		return resolvedID{}, fmt.Errorf(
			"issue ref %q looks like a short UUID prefix; short prefixes are no longer supported for issues. "+
				"Use the issue key (e.g. MUL-123) shown by `multica issue list`, or pass the full UUID (run a list command with --full-id to copy it)",
			input,
		)
	}
	return resolvedID{}, fmt.Errorf(
		"issue ref %q is not a recognized issue reference; use the issue key (e.g. MUL-123) shown by `multica issue list`, or pass the full UUID",
		input,
	)
}

func fetchIssueRef(ctx context.Context, client *cli.APIClient, ref string) (resolvedID, error) {
	var issue map[string]any
	if err := client.GetJSON(ctx, "/api/issues/"+url.PathEscape(ref), &issue); err != nil {
		return resolvedID{}, err
	}
	c := issueCandidate(issue)
	if c.Display == "" {
		c.Display = c.ID
	}
	return resolvedID{ID: c.ID, Display: c.Display}, nil
}

func looksLikeIssueIdentifier(input string) bool {
	if input == "" {
		return false
	}
	dash := strings.LastIndex(input, "-")
	if dash <= 0 || dash >= len(input)-1 {
		return false
	}
	prefix := input[:dash]
	for _, r := range prefix {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	_, ok := parsePositiveInt(input[dash+1:])
	return ok
}

func parsePositiveInt(input string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(input))
	if err != nil || n <= 0 {
		return 0, false
	}
	return n, true
}

func resolveAutopilotID(ctx context.Context, client *cli.APIClient, input string) (resolvedID, error) {
	return resolveIDByPrefix(ctx, client, "autopilot", input, fetchAutopilotCandidates)
}

func fetchAutopilotCandidates(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
	if client.WorkspaceID == "" {
		return nil, fmt.Errorf("workspace_id is required to resolve autopilot id prefixes")
	}
	const limit = resolverListPageLimit
	candidates := []idCandidate{}
	seen := map[string]struct{}{}
	for offset := 0; ; {
		params := url.Values{}
		params.Set("workspace_id", client.WorkspaceID)
		params.Set("limit", strconv.Itoa(limit))
		if offset > 0 {
			params.Set("offset", strconv.Itoa(offset))
		}
		var resp struct {
			Autopilots []map[string]any `json:"autopilots"`
			Total      int              `json:"total"`
			HasMore    bool             `json:"has_more"`
		}
		if err := client.GetJSON(ctx, "/api/autopilots?"+params.Encode(), &resp); err != nil {
			return nil, err
		}
		added := 0
		for _, a := range resp.Autopilots {
			id := strVal(a, "id")
			if id == "" {
				continue
			}
			if _, ok := seen[id]; ok {
				continue
			}
			seen[id] = struct{}{}
			added++
			candidates = append(candidates, idCandidate{
				ID:      id,
				Display: strVal(a, "title"),
				Detail:  strVal(a, "status"),
			})
		}
		pageLen := len(resp.Autopilots)
		offset += pageLen
		if pageLen == 0 || added == 0 {
			break
		}
		if pageLen < limit {
			break
		}
		if resp.HasMore {
			continue
		}
		if resp.Total > 0 {
			if offset >= resp.Total {
				break
			}
			continue
		}
	}
	return candidates, nil
}

func resolveTaskRunID(ctx context.Context, client *cli.APIClient, issueID, input string) (resolvedID, error) {
	trimmed := strings.TrimSpace(input)
	if uuidRegexp.MatchString(trimmed) {
		return resolvedID{ID: trimmed, Display: trimmed}, nil
	}
	if strings.TrimSpace(issueID) == "" {
		return resolvedID{}, fmt.Errorf("short task run prefixes require --issue <issue-id>; pass a full task UUID or run `multica issue runs <issue-id> --full-id`")
	}
	fetch := func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		return fetchTaskRunCandidatesForIssue(ctx, client, issueID)
	}
	return resolveIDByPrefix(ctx, client, "task run", input, fetch)
}

func fetchTaskRunCandidatesForIssue(ctx context.Context, client *cli.APIClient, issueID string) ([]idCandidate, error) {
	var runs []map[string]any
	if err := client.GetJSON(ctx, "/api/issues/"+url.PathEscape(issueID)+"/task-runs", &runs); err != nil {
		return nil, err
	}
	candidates := make([]idCandidate, 0, len(runs))
	for _, r := range runs {
		id := strVal(r, "id")
		if id == "" {
			continue
		}
		candidates = append(candidates, idCandidate{
			ID:      id,
			Display: id,
		})
	}
	return candidates, nil
}

func resolveAutopilotTriggerID(ctx context.Context, client *cli.APIClient, autopilotID, input string) (resolvedID, error) {
	trimmed := strings.TrimSpace(input)
	if uuidRegexp.MatchString(trimmed) {
		return resolvedID{ID: trimmed, Display: trimmed}, nil
	}
	fetch := func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		var resp map[string]any
		if err := client.GetJSON(ctx, "/api/autopilots/"+url.PathEscape(autopilotID), &resp); err != nil {
			return nil, err
		}
		triggersRaw, _ := resp["triggers"].([]any)
		candidates := make([]idCandidate, 0, len(triggersRaw))
		for _, raw := range triggersRaw {
			t, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			detail := strVal(t, "kind")
			if label := strVal(t, "label"); label != "" {
				detail = label
			}
			candidates = append(candidates, idCandidate{
				ID:      strVal(t, "id"),
				Display: strVal(t, "id"),
				Detail:  detail,
			})
		}
		return candidates, nil
	}
	return resolveIDByPrefix(ctx, client, "autopilot trigger", input, fetch)
}

func resolveProjectID(ctx context.Context, client *cli.APIClient, input string) (resolvedID, error) {
	return resolveIDByPrefix(ctx, client, "project", input, fetchProjectCandidates)
}

// resolveProjectIDForNewWork resolves --project on creates that file new work
// into a project (issue create, autopilot create). Updates use
// resolveProjectID: the server alone knows whether the project changes. A prefix that
// only matches an archived project is refused here with the restore command,
// instead of round-tripping to the server's 409 project_archived.
func resolveProjectIDForNewWork(ctx context.Context, client *cli.APIClient, input string) (resolvedID, error) {
	ref, err := resolveProjectID(ctx, client, input)
	if err != nil {
		return resolvedID{}, err
	}
	if ref.Archived {
		return resolvedID{}, fmt.Errorf("project %q is archived and accepts no new work; restore it first with: multica project restore %s", ref.Display, ref.ID)
	}
	return ref, nil
}

func fetchProjectCandidates(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
	if client.WorkspaceID == "" {
		return nil, fmt.Errorf("workspace_id is required to resolve project id prefixes")
	}
	// Archived projects are candidates too, so get / restore / issue list
	// --project still reach them; resolveIDByPrefix prefers live projects.
	params := url.Values{"workspace_id": {client.WorkspaceID}, "include_archived": {"true"}}
	var result map[string]any
	if err := client.GetJSON(ctx, "/api/projects?"+params.Encode(), &result); err != nil {
		return nil, err
	}
	projectsRaw, _ := result["projects"].([]any)
	candidates := make([]idCandidate, 0, len(projectsRaw))
	for _, raw := range projectsRaw {
		p, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		detail := strVal(p, "status")
		if strVal(p, "archived_at") != "" {
			detail += ", archived"
		}
		candidates = append(candidates, idCandidate{
			ID:       strVal(p, "id"),
			Display:  strVal(p, "title"),
			Detail:   detail,
			Archived: strVal(p, "archived_at") != "",
		})
	}
	return candidates, nil
}

func resolveProjectResourceID(ctx context.Context, client *cli.APIClient, projectID, input string) (resolvedID, error) {
	fetch := func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		var result map[string]any
		if err := client.GetJSON(ctx, "/api/projects/"+url.PathEscape(projectID)+"/resources", &result); err != nil {
			return nil, err
		}
		resourcesRaw, _ := result["resources"].([]any)
		candidates := make([]idCandidate, 0, len(resourcesRaw))
		for _, raw := range resourcesRaw {
			r, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			display := strVal(r, "label")
			if display == "" {
				display = strVal(r, "resource_type")
			}
			candidates = append(candidates, idCandidate{
				ID:      strVal(r, "id"),
				Display: display,
				Detail:  summarizeResourceRef(r["resource_ref"]),
			})
		}
		return candidates, nil
	}
	return resolveIDByPrefix(ctx, client, "project resource", input, fetch)
}

// resolveModuleID resolves a module reference to its UUID. A module has no
// human-readable key like an issue's MUL-123, so the reference may be a full
// UUID, a UUID prefix (as for every other resource here), or the module title —
// the title is what a person or an agent reading a project brief actually has
// at hand. projectID narrows the search to one project; an empty projectID
// searches the whole workspace, which is what GET /api/modules does when
// project_id is absent.
//
// Hex-shaped input is tried as an id prefix first so a copied short id keeps
// working; a title that happens to look like hex (e.g. "beef") still resolves
// once no id matches that prefix.
func resolveModuleID(ctx context.Context, client *cli.APIClient, projectID, input string) (resolvedID, error) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return resolvedID{}, fmt.Errorf("module id is required")
	}
	if uuidRegexp.MatchString(trimmed) {
		return resolvedID{ID: trimmed, Display: trimmed}, nil
	}

	candidates, err := fetchModuleCandidates(ctx, client, projectID)
	if err != nil {
		return resolvedID{}, fmt.Errorf("resolve module: %w", err)
	}

	if prefix, prefixErr := normalizeUUIDPrefix(trimmed); prefixErr == nil {
		matches := make([]idCandidate, 0, 1)
		for _, c := range candidates {
			if c.ID != "" && strings.HasPrefix(compactUUID(c.ID), prefix) {
				matches = append(matches, c)
			}
		}
		if len(matches) > 1 {
			return resolvedID{}, ambiguousIDPrefixError("module", input, matches)
		}
		if len(matches) == 1 {
			return moduleResolvedID(matches[0]), nil
		}
	}

	titleMatches := make([]idCandidate, 0, 1)
	for _, c := range candidates {
		if c.ID != "" && strings.EqualFold(strings.TrimSpace(c.Display), trimmed) {
			titleMatches = append(titleMatches, c)
		}
	}
	switch len(titleMatches) {
	case 1:
		return moduleResolvedID(titleMatches[0]), nil
	case 0:
		return resolvedID{}, fmt.Errorf(
			"no module found matching %q%s; run `multica module list --full-id` to see the modules and their ids",
			input, moduleScopeSuffix(projectID))
	default:
		return resolvedID{}, ambiguousModuleTitleError(input, titleMatches)
	}
}

// resolveWorkItemID resolves --work-item. Accepted forms are a full UUID, a
// UUID prefix, or a plan node code as the tree shows it — the code is the
// handle an agent naturally has. Only third-level nodes qualify: an L1/L2 code
// names a project or module branch, not a filing target, and letting it through
// would surface the server's "work item not found" for a node the caller can
// see in the tree. Ambiguity is reported instead of guessed.
func resolveWorkItemID(ctx context.Context, client *cli.APIClient, input string) (resolvedID, error) {
	trimmed := strings.TrimSpace(input)
	if trimmed == "" {
		return resolvedID{}, fmt.Errorf("work item is required")
	}
	if uuidRegexp.MatchString(trimmed) {
		return resolvedID{ID: trimmed, Display: trimmed}, nil
	}
	board, err := cockpitBoard(ctx, client)
	if err != nil {
		return resolvedID{}, err
	}
	nodes := mapList(board, "nodes")
	byID := make(map[string]map[string]any, len(nodes))
	for _, n := range nodes {
		byID[strVal(n, "id")] = n
	}
	isWorkItem := func(n map[string]any) bool { return isThirdLevelNode(n, byID) }

	if prefix, prefixErr := normalizeUUIDPrefix(trimmed); prefixErr == nil {
		matches := make([]idCandidate, 0, 1)
		for _, n := range nodes {
			id := strVal(n, "id")
			if id != "" && strings.HasPrefix(compactUUID(id), prefix) && isWorkItem(n) {
				matches = append(matches, idCandidate{ID: id, Display: nodeDisplay(n)})
			}
		}
		if len(matches) > 1 {
			return resolvedID{}, ambiguousIDPrefixError("work item", input, matches)
		}
		if len(matches) == 1 {
			return moduleResolvedID(matches[0]), nil
		}
	}

	codeMatches := make([]idCandidate, 0, 1)
	for _, n := range nodes {
		if strVal(n, "code") != "" && strings.EqualFold(strVal(n, "code"), trimmed) && isWorkItem(n) {
			codeMatches = append(codeMatches, idCandidate{ID: strVal(n, "id"), Display: nodeDisplay(n)})
		}
	}
	switch len(codeMatches) {
	case 1:
		return moduleResolvedID(codeMatches[0]), nil
	case 0:
		if other := codeMatchAtOtherLevel(nodes, trimmed); other != "" {
			return resolvedID{}, fmt.Errorf("%q is %s, not a work item; --work-item takes a third-level plan node", input, other)
		}
		return resolvedID{}, fmt.Errorf("no work item found matching %q; run `multica cockpit node list` to see the plan codes", input)
	default:
		return resolvedID{}, fmt.Errorf("work item %q is ambiguous: %d nodes share that code", input, len(codeMatches))
	}
}

// isThirdLevelNode reports whether n sits at project → module → work item
// depth. Bindings are not consulted here — the server owns that check.
func isThirdLevelNode(n map[string]any, byID map[string]map[string]any) bool {
	return planNodeDepth(n, byID) == 3
}

// planNodeDepth walks parent_id to the root and returns the 1-based depth, or
// 0 when the parent chain is broken. The bound keeps a malformed board from
// spinning.
func planNodeDepth(n map[string]any, byID map[string]map[string]any) int {
	depth := 1
	for depth <= 16 {
		parentID := strVal(n, "parent_id")
		if parentID == "" {
			return depth
		}
		parent, ok := byID[parentID]
		if !ok {
			return 0
		}
		n = parent
		depth++
	}
	return 0
}

// codeMatchAtOtherLevel names the level a rejected code belongs to, so the
// error explains why the visible code was not accepted.
func codeMatchAtOtherLevel(nodes []map[string]any, code string) string {
	byID := make(map[string]map[string]any, len(nodes))
	for _, n := range nodes {
		byID[strVal(n, "id")] = n
	}
	for _, n := range nodes {
		if !strings.EqualFold(strVal(n, "code"), code) {
			continue
		}
		switch depth := planNodeDepth(n, byID); {
		case depth == 0:
			return ""
		case depth == 1:
			return "a project-level node"
		case depth == 2:
			return "a module-level node"
		default:
			return fmt.Sprintf("a level-%d node", depth)
		}
	}
	return ""
}

// nodeDisplay renders "code name", the same label the plan tree shows.
func nodeDisplay(n map[string]any) string {
	code := strVal(n, "code")
	name := strVal(n, "name")
	switch {
	case code == "":
		return name
	case name == "":
		return code
	default:
		return code + " " + name
	}
}

func moduleResolvedID(c idCandidate) resolvedID {
	display := c.Display
	if display == "" {
		display = c.ID
	}
	return resolvedID{ID: c.ID, Display: display}
}

func moduleScopeSuffix(projectID string) string {
	if projectID == "" {
		return " in this workspace"
	}
	return " in project " + truncateID(projectID)
}

// ambiguousModuleTitleError lists the colliding modules, since two modules in
// different projects may legitimately carry the same title: the caller
// disambiguates with --project or by passing the id.
func ambiguousModuleTitleError(input string, matches []idCandidate) error {
	sort.Slice(matches, func(i, j int) bool {
		return matches[i].ID < matches[j].ID
	})
	parts := make([]string, 0, len(matches))
	for _, m := range matches {
		line := "  " + m.ID + "  " + m.Display
		if m.Detail != "" {
			line += " (project " + truncateID(m.Detail) + ")"
		}
		parts = append(parts, line)
	}
	return fmt.Errorf("ambiguous module title %q; matches:\n%s\nPass --project to narrow the search, or use the module id",
		input, strings.Join(parts, "\n"))
}

func fetchModuleCandidates(ctx context.Context, client *cli.APIClient, projectID string) ([]idCandidate, error) {
	if client.WorkspaceID == "" {
		return nil, fmt.Errorf("workspace_id is required to resolve module references")
	}
	// The workspace comes from the request header, so project_id is the only
	// query parameter the modules endpoint reads.
	path := "/api/modules"
	if projectID != "" {
		path += "?" + url.Values{"project_id": {projectID}}.Encode()
	}
	var result map[string]any
	if err := client.GetJSON(ctx, path, &result); err != nil {
		return nil, err
	}
	modulesRaw, _ := result["modules"].([]any)
	candidates := make([]idCandidate, 0, len(modulesRaw))
	for _, raw := range modulesRaw {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		candidates = append(candidates, idCandidate{
			ID:      strVal(m, "id"),
			Display: strVal(m, "title"),
			Detail:  strVal(m, "project_id"),
		})
	}
	return candidates, nil
}

func resolveLabelID(ctx context.Context, client *cli.APIClient, input, resourceType string) (resolvedID, error) {
	return resolveIDByPrefix(ctx, client, "label", input, func(ctx context.Context, client *cli.APIClient) ([]idCandidate, error) {
		return fetchLabelCandidates(ctx, client, resourceType)
	})
}

func fetchLabelCandidates(ctx context.Context, client *cli.APIClient, resourceType string) ([]idCandidate, error) {
	if client.WorkspaceID == "" {
		return nil, fmt.Errorf("workspace_id is required to resolve label id prefixes")
	}
	resourceTypes := []string{resourceType}
	if resourceType == "" {
		resourceTypes = []string{"issue", "skill"}
	}
	candidates := make([]idCandidate, 0)
	for _, candidateType := range resourceTypes {
		params := url.Values{"workspace_id": {client.WorkspaceID}, "resource_type": {candidateType}}
		var result map[string]any
		if err := client.GetJSON(ctx, "/api/labels?"+params.Encode(), &result); err != nil {
			return nil, err
		}
		labelsRaw, _ := result["labels"].([]any)
		for _, raw := range labelsRaw {
			l, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			candidates = append(candidates, idCandidate{
				ID:      strVal(l, "id"),
				Display: strVal(l, "name"),
				Detail:  strVal(l, "color"),
			})
		}
	}
	return candidates, nil
}

type actorDisplayLookup struct {
	ctx    context.Context
	client *cli.APIClient
	state  *actorDisplayLookupState
}

type actorDisplayLookupState struct {
	members       map[string]string
	agents        map[string]string
	squads        map[string]string
	membersLoaded bool
	agentsLoaded  bool
	squadsLoaded  bool
}

func loadActorDisplayLookup(ctx context.Context, client *cli.APIClient) actorDisplayLookup {
	return actorDisplayLookup{
		ctx:    ctx,
		client: client,
		state:  &actorDisplayLookupState{},
	}
}

func (l actorDisplayLookup) loadMembers() {
	if l.state == nil || l.state.membersLoaded {
		return
	}
	l.state.membersLoaded = true
	l.state.members = map[string]string{}
	if l.client == nil || l.client.WorkspaceID == "" {
		return
	}
	var members []map[string]any
	if err := l.client.GetJSON(l.ctx, "/api/workspaces/"+url.PathEscape(l.client.WorkspaceID)+"/members", &members); err == nil {
		for _, m := range members {
			if id := strVal(m, "user_id"); id != "" {
				l.state.members[id] = strVal(m, "name")
			}
		}
	}
}

func (l actorDisplayLookup) loadAgents() {
	if l.state == nil || l.state.agentsLoaded {
		return
	}
	l.state.agentsLoaded = true
	l.state.agents = map[string]string{}
	if l.client == nil || l.client.WorkspaceID == "" {
		return
	}
	var agents []map[string]any
	agentPath := "/api/agents?" + url.Values{"workspace_id": {l.client.WorkspaceID}}.Encode()
	if err := l.client.GetJSON(l.ctx, agentPath, &agents); err == nil {
		for _, a := range agents {
			if id := strVal(a, "id"); id != "" {
				l.state.agents[id] = strVal(a, "name")
			}
		}
	}
}

func (l actorDisplayLookup) loadSquads() {
	if l.state == nil || l.state.squadsLoaded {
		return
	}
	l.state.squadsLoaded = true
	l.state.squads = map[string]string{}
	if l.client == nil || l.client.WorkspaceID == "" {
		return
	}
	var squads []map[string]any
	if err := l.client.GetJSON(l.ctx, "/api/squads", &squads); err == nil {
		for _, s := range squads {
			if id := strVal(s, "id"); id != "" {
				l.state.squads[id] = strVal(s, "name")
			}
		}
	}
}

func (l actorDisplayLookup) actor(actorType, id string) string {
	if actorType == "" || id == "" {
		return ""
	}
	switch actorType {
	case "member":
		l.loadMembers()
		if l.state != nil && l.state.members != nil {
			if name := l.state.members[id]; name != "" {
				return "member:" + name
			}
		}
	case "agent":
		l.loadAgents()
		if l.state != nil && l.state.agents != nil {
			if name := l.state.agents[id]; name != "" {
				return "agent:" + name
			}
		}
	case "squad":
		l.loadSquads()
		if l.state != nil && l.state.squads != nil {
			if name := l.state.squads[id]; name != "" {
				return "squad:" + name
			}
		}
	}
	return actorType + ":" + id
}

func (l actorDisplayLookup) agent(id string) string {
	if id == "" {
		return ""
	}
	l.loadAgents()
	if l.state != nil && l.state.agents != nil {
		if name := l.state.agents[id]; name != "" {
			return name
		}
	}
	return id
}
