package daemon

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

// TaskDiskUsage describes one task workdir's footprint on disk.
//
// Fork: IssueID/AgentID identify the persistent workspace by its (agent, issue)
// pair — what the workspace management UI lists and reasons about. Upstream:
// ParentID is the id of the record that governs this directory's lifecycle,
// discriminated by Kind (issue id, chat session id, autopilot run id, or task
// id). Both are kept: IssueID/AgentID drive the fork's per-(agent,issue)
// management UI, ParentID drives ResolveParentStatuses. ParentStatus is that
// record's current status; it stays empty until ResolveParentStatuses fills it
// in, because ScanDiskUsage itself is purely local and .gc_meta.json does not
// persist a status. RepoCheckoutBytes is the working-tree footprint of git
// checkouts inside the workdir; together with ArtifactSizeBytes it forms the
// "regenerable" total that a "clear repo checkouts" action can reclaim without
// touching the agent's own files.
type TaskDiskUsage struct {
	WorkspaceID       string `json:"workspace_id"`
	WorkspaceShort    string `json:"workspace_short"`
	TaskShort         string `json:"task_short"`
	Path              string `json:"path"`
	Kind              string `json:"kind"`
	IssueID           string `json:"issue_id,omitempty"`
	AgentID           string `json:"agent_id,omitempty"`
	ParentID          string `json:"parent_id,omitempty"`
	ParentStatus      string `json:"parent_status"`
	AgeSeconds        int64  `json:"age_seconds"`
	SizeBytes         int64  `json:"size_bytes"`
	ArtifactSizeBytes int64  `json:"artifact_size_bytes"`
	RepoCheckoutBytes int64  `json:"repo_checkout_bytes"`
	FileCount         int64  `json:"file_count"`
}

// WorkspaceDiskUsage aggregates per-workspace footprint across all tasks.
// ArtifactRatio is the fraction (0..1) of SizeBytes that the GC artifact
// cleanup could reclaim — kept here so the JSON consumer doesn't have to
// re-derive it (and so the table view can render the column without dividing
// by zero on empty workspaces).
type WorkspaceDiskUsage struct {
	WorkspaceID       string  `json:"workspace_id"`
	WorkspaceShort    string  `json:"workspace_short"`
	TaskCount         int     `json:"task_count"`
	SizeBytes         int64   `json:"size_bytes"`
	ArtifactSizeBytes int64   `json:"artifact_size_bytes"`
	RepoCheckoutBytes int64   `json:"repo_checkout_bytes"`
	ArtifactRatio     float64 `json:"artifact_ratio"`
	OldestAgeSeconds  int64   `json:"oldest_age_seconds"`
}

// DiskUsageReport is the full result of a single ScanDiskUsage call. Total*
// fields always reflect the entire scan, never the post-`--top` truncated
// view — consumers that need the displayed subtotals can sum the slice.
type DiskUsageReport struct {
	WorkspacesRoot          string               `json:"workspaces_root"`
	GeneratedAt             time.Time            `json:"generated_at"`
	ArtifactPatterns        []string             `json:"artifact_patterns"`
	ManagedArtifactSubpaths []string             `json:"managed_artifact_subpaths"`
	Tasks                   []TaskDiskUsage      `json:"tasks"`
	Workspaces              []WorkspaceDiskUsage `json:"workspaces"`
	TotalTaskCount          int                  `json:"total_task_count"`
	TotalWorkspaceCount     int                  `json:"total_workspace_count"`
	TotalSizeBytes          int64                `json:"total_size_bytes"`
	TotalArtifactSizeBytes  int64                `json:"total_artifact_size_bytes"`
	TotalRepoCheckoutBytes  int64                `json:"total_repo_checkout_bytes"`
	TotalArtifactRatio      float64              `json:"total_artifact_ratio"`
	// RepoCacheSizeBytes is the bare-repo cache (.repos) footprint. It is a
	// sibling of the task directories, not one of them, so it is reported
	// separately and deliberately excluded from Total*: those totals describe
	// task dirs, and folding a shared cache into them would double-count it
	// against per-task numbers that do not contain it.
	RepoCacheSizeBytes int64 `json:"repo_cache_size_bytes"`
	RepoCacheCount     int   `json:"repo_cache_count"`
}

// DiskUsageRoot pairs a workspaces root with the profile it was derived from
// ("" = the default root). ScanDiskUsageRoots scans each one and labels its
// report with the profile so the cross-root view can attribute footprint back
// to a profile (e.g. the Desktop app's `desktop-<host>` root).
type DiskUsageRoot struct {
	Profile string
	Root    string
}

// RootDiskUsage is one root's report inside an AggregateDiskUsageReport.
type RootDiskUsage struct {
	Profile string          `json:"profile"`
	Report  DiskUsageReport `json:"report"`
}

// AggregateDiskUsageReport is the result of scanning several workspace roots in
// one pass. Total* fields are the grand totals across every root's full scan
// (never the post-`--top` truncated view) so the combined footprint stays
// accurate even when each root's table is trimmed for display.
type AggregateDiskUsageReport struct {
	GeneratedAt             time.Time       `json:"generated_at"`
	ArtifactPatterns        []string        `json:"artifact_patterns"`
	ManagedArtifactSubpaths []string        `json:"managed_artifact_subpaths"`
	Roots                   []RootDiskUsage `json:"roots"`
	TotalTaskCount          int             `json:"total_task_count"`
	TotalWorkspaceCount     int             `json:"total_workspace_count"`
	TotalSizeBytes          int64           `json:"total_size_bytes"`
	TotalArtifactSizeBytes  int64           `json:"total_artifact_size_bytes"`
	TotalArtifactRatio      float64         `json:"total_artifact_ratio"`
	TotalRepoCacheSizeBytes int64           `json:"total_repo_cache_size_bytes"`
	TotalRepoCacheCount     int             `json:"total_repo_cache_count"`
}

// ScanDiskUsageRoots scans every root in order and returns the combined report.
// It reuses ScanDiskUsage per root — a missing root yields an empty per-root
// report (not an error), matching the single-root command, so a never-used
// profile root simply contributes zero. A genuinely unreadable root (e.g. a
// permission error on the root directory itself) aborts the whole scan.
func ScanDiskUsageRoots(roots []DiskUsageRoot, artifactPatterns []string) (AggregateDiskUsageReport, error) {
	agg := AggregateDiskUsageReport{GeneratedAt: time.Now().UTC()}
	matcher := newArtifactMatcher(artifactPatterns, execenv.ManagedReclaimableArtifactSubpaths())
	agg.ArtifactPatterns = sortedKeys(matcher.basenames)
	agg.ManagedArtifactSubpaths = matcher.managedSubpaths()

	for _, r := range roots {
		report, err := ScanDiskUsage(r.Root, artifactPatterns)
		if err != nil {
			return agg, err
		}
		agg.Roots = append(agg.Roots, RootDiskUsage{Profile: r.Profile, Report: report})
		agg.TotalTaskCount += report.TotalTaskCount
		agg.TotalWorkspaceCount += report.TotalWorkspaceCount
		agg.TotalSizeBytes += report.TotalSizeBytes
		agg.TotalArtifactSizeBytes += report.TotalArtifactSizeBytes
		agg.TotalRepoCacheSizeBytes += report.RepoCacheSizeBytes
		agg.TotalRepoCacheCount += report.RepoCacheCount
	}
	agg.TotalArtifactRatio = ratio(agg.TotalArtifactSizeBytes, agg.TotalSizeBytes)
	return agg, nil
}

// DiskUsageKindUnknown is the kind reported for task directories whose
// .gc_meta.json is missing or unreadable. Mirrors how the GC orphan path
// treats them — present on disk, but no parent record we can lock onto.
const DiskUsageKindUnknown = "unknown"

// ScanDiskUsage walks workspacesRoot and returns the disk-usage report. The
// walk is read-only, never follows symlinks, and counts only regular files.
// artifactPatterns is filtered through the basename-only check used by
// cleanTaskArtifacts, and exact daemon-managed artifact paths are included, so
// the reported "artifact" footprint matches the bytes the GC would actually
// reclaim. A .git subtree counts toward the total but never toward that
// artifact footprint — see taskSize. Missing roots return an empty report
// (not an error) — a daemon that's never run yet has no directory to walk.
//
// The scan is purely local. ParentStatus is left empty; callers that want the
// STATUS column populated run ResolveParentStatuses afterwards.
func ScanDiskUsage(workspacesRoot string, artifactPatterns []string) (DiskUsageReport, error) {
	report := DiskUsageReport{
		WorkspacesRoot:   workspacesRoot,
		GeneratedAt:      time.Now().UTC(),
		ArtifactPatterns: nil,
	}
	if workspacesRoot == "" {
		return report, fmt.Errorf("disk-usage: workspaces root is required")
	}

	matcher := newArtifactMatcher(artifactPatterns, execenv.ManagedReclaimableArtifactSubpaths())
	report.ArtifactPatterns = sortedKeys(matcher.basenames)
	report.ManagedArtifactSubpaths = matcher.managedSubpaths()

	wsEntries, err := os.ReadDir(workspacesRoot)
	if err != nil {
		if os.IsNotExist(err) {
			return report, nil
		}
		return report, fmt.Errorf("disk-usage: read workspaces root: %w", err)
	}

	wsAgg := map[string]*WorkspaceDiskUsage{}

	for _, wsEntry := range wsEntries {
		if !wsEntry.IsDir() {
			continue
		}
		// The bare-repo cache is not a workspace. Measure it separately rather
		// than skipping it outright: it is reclaimed on its own schedule
		// (GCRepoTTL) and used to be invisible here, which made the reported
		// total disagree with the user's file manager for no stated reason.
		if wsEntry.Name() == reposDirName {
			report.RepoCacheSizeBytes, report.RepoCacheCount = repoCacheSize(filepath.Join(workspacesRoot, wsEntry.Name()))
			continue
		}
		// Other dot-directories are daemon-internal caches (skill bundles and
		// friends), never workspaces. Counting them as workspaces put rows like
		// ".skillca" in the per-workspace table.
		if strings.HasPrefix(wsEntry.Name(), ".") {
			continue
		}
		wsID := wsEntry.Name()
		wsDir := filepath.Join(workspacesRoot, wsID)
		taskEntries, err := os.ReadDir(wsDir)
		if err != nil {
			continue
		}
		for _, t := range taskEntries {
			if !t.IsDir() {
				continue
			}
			taskDir := filepath.Join(wsDir, t.Name())
			usage := buildTaskUsage(taskDir, wsID, t.Name(), matcher)

			report.Tasks = append(report.Tasks, usage)
			report.TotalSizeBytes += usage.SizeBytes
			report.TotalArtifactSizeBytes += usage.ArtifactSizeBytes
			report.TotalRepoCheckoutBytes += usage.RepoCheckoutBytes

			ws, ok := wsAgg[wsID]
			if !ok {
				ws = &WorkspaceDiskUsage{
					WorkspaceID:    wsID,
					WorkspaceShort: ShortID(wsID),
				}
				wsAgg[wsID] = ws
			}
			ws.TaskCount++
			ws.SizeBytes += usage.SizeBytes
			ws.ArtifactSizeBytes += usage.ArtifactSizeBytes
			ws.RepoCheckoutBytes += usage.RepoCheckoutBytes
			if usage.AgeSeconds > ws.OldestAgeSeconds {
				ws.OldestAgeSeconds = usage.AgeSeconds
			}
		}
	}

	sort.Slice(report.Tasks, func(i, j int) bool {
		return report.Tasks[i].SizeBytes > report.Tasks[j].SizeBytes
	})

	report.Workspaces = make([]WorkspaceDiskUsage, 0, len(wsAgg))
	for _, ws := range wsAgg {
		ws.ArtifactRatio = ratio(ws.ArtifactSizeBytes, ws.SizeBytes)
		report.Workspaces = append(report.Workspaces, *ws)
	}
	sort.Slice(report.Workspaces, func(i, j int) bool {
		return report.Workspaces[i].SizeBytes > report.Workspaces[j].SizeBytes
	})

	report.TotalTaskCount = len(report.Tasks)
	report.TotalWorkspaceCount = len(report.Workspaces)
	report.TotalArtifactRatio = ratio(report.TotalArtifactSizeBytes, report.TotalSizeBytes)

	return report, nil
}

// repoCacheSize measures the bare-repo cache and counts the repos in it.
// Layout is .repos/<workspace-id>/<repo-dir>, so the count is the number of
// second-level directories — the unit the GC evicts.
func repoCacheSize(reposRoot string) (sizeBytes int64, repoCount int) {
	wsEntries, err := os.ReadDir(reposRoot)
	if err != nil {
		return 0, 0
	}
	for _, wsEntry := range wsEntries {
		if !wsEntry.IsDir() {
			continue
		}
		wsDir := filepath.Join(reposRoot, wsEntry.Name())
		repoEntries, err := os.ReadDir(wsDir)
		if err != nil {
			continue
		}
		for _, repoEntry := range repoEntries {
			if !repoEntry.IsDir() {
				continue
			}
			repoCount++
			sizeBytes += dirSize(filepath.Join(wsDir, repoEntry.Name()))
		}
	}
	return sizeBytes, repoCount
}

// ratio returns numerator / denominator, mapping 0/0 (and any 0 denominator)
// to 0 instead of NaN. Callers render the result as a percentage so a NaN
// would surface as "NaN%" in the table — guard at the source.
func ratio(numerator, denominator int64) float64 {
	if denominator <= 0 {
		return 0
	}
	return float64(numerator) / float64(denominator)
}

func buildPatternSet(patterns []string) map[string]struct{} {
	set := make(map[string]struct{}, len(patterns))
	for _, p := range patterns {
		p = strings.TrimSpace(p)
		if p == "" || strings.ContainsAny(p, "/\\") {
			continue
		}
		set[p] = struct{}{}
	}
	return set
}

func sortedKeys(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func buildTaskUsage(taskDir, wsID, taskShort string, matcher artifactMatcher) TaskDiskUsage {
	usage := TaskDiskUsage{
		WorkspaceID:    wsID,
		WorkspaceShort: ShortID(wsID),
		TaskShort:      taskShort,
		Path:           taskDir,
		Kind:           DiskUsageKindUnknown,
	}

	metaPresent := false
	if meta, err := execenv.ReadGCMeta(taskDir); err == nil && meta != nil {
		metaPresent = true
		usage.Kind = string(meta.Kind)
		usage.IssueID = meta.IssueID
		usage.AgentID = meta.AgentID
		usage.ParentID = parentIDForMeta(meta)
		if !meta.CompletedAt.IsZero() {
			usage.AgeSeconds = int64(time.Since(meta.CompletedAt).Seconds())
		} else if age, ok := gcMetaFileAge(taskDir); ok {
			usage.AgeSeconds = int64(age.Seconds())
		}
	}
	// With no readable metadata, use taskDir mtime just like orphanByMTime.
	// Legacy readable metadata without completed_at uses its own file mtime,
	// matching gcDecisionIssueResult's managed-only fallback.
	if usage.AgeSeconds <= 0 && !metaPresent {
		if info, err := os.Stat(taskDir); err == nil {
			usage.AgeSeconds = int64(time.Since(info.ModTime()).Seconds())
		}
	}

	usage.SizeBytes, usage.ArtifactSizeBytes, usage.RepoCheckoutBytes, usage.FileCount = taskSize(taskDir, matcher)
	return usage
}

// parentIDForMeta returns the id of the record that governs this task dir's
// lifecycle. GCMeta is a discriminated union keyed on Kind, so only the field
// matching Kind is meaningful.
func parentIDForMeta(meta *execenv.GCMeta) string {
	switch meta.Kind {
	case execenv.GCKindIssue:
		return strings.TrimSpace(meta.IssueID)
	case execenv.GCKindChat:
		return strings.TrimSpace(meta.ChatSessionID)
	case execenv.GCKindAutopilotRun:
		return strings.TrimSpace(meta.AutopilotRunID)
	case execenv.GCKindQuickCreate:
		return strings.TrimSpace(meta.TaskID)
	default:
		return ""
	}
}

// ParentStatusFetcher resolves a batch of issue ids in one workspace to their
// current status. Ids the server does not return (deleted, or invisible to
// this token) must be omitted from the result rather than mapped to a
// placeholder, so callers can tell "unresolved" from a real status.
type ParentStatusFetcher func(ctx context.Context, workspaceID string, issueIDs []string) (map[string]string, error)

// ResolveParentStatuses fills in ParentStatus on every issue-kind task in the
// report. ScanDiskUsage is deliberately network-free — this is the opt-in
// second pass that turns the STATUS column into real data.
//
// Only issue-kind tasks are resolved: they are the overwhelming majority of
// task dirs and the only kind with a batch reconciliation endpoint. Chat,
// autopilot-run, and quick-create dirs keep an empty ParentStatus rather than
// costing one request each.
//
// Best-effort by design: a workspace whose fetch fails leaves its tasks
// unresolved and the error is returned for the caller to surface, but every
// other workspace is still filled in. Callers must not treat a non-nil error
// as "the report is unusable".
func ResolveParentStatuses(ctx context.Context, report *DiskUsageReport, fetch ParentStatusFetcher) error {
	if report == nil || fetch == nil {
		return nil
	}

	idsByWorkspace := map[string][]string{}
	seen := map[string]map[string]bool{}
	for _, task := range report.Tasks {
		if task.Kind != string(execenv.GCKindIssue) || task.ParentID == "" {
			continue
		}
		if seen[task.WorkspaceID] == nil {
			seen[task.WorkspaceID] = map[string]bool{}
		}
		// Several task dirs can share one issue (a re-dispatched task reuses
		// the prior workdir), so de-duplicate before asking the server.
		if seen[task.WorkspaceID][task.ParentID] {
			continue
		}
		seen[task.WorkspaceID][task.ParentID] = true
		idsByWorkspace[task.WorkspaceID] = append(idsByWorkspace[task.WorkspaceID], task.ParentID)
	}
	if len(idsByWorkspace) == 0 {
		return nil
	}

	var firstErr error
	statuses := make(map[string]map[string]string, len(idsByWorkspace))
	for workspaceID, ids := range idsByWorkspace {
		resolved := make(map[string]string, len(ids))
		// Same chunk size the GC loop uses, so one oversized root cannot trip
		// the server's batch cap.
		for start := 0; start < len(ids); start += issueGCBatchSize {
			end := min(start+issueGCBatchSize, len(ids))
			chunk, err := fetch(ctx, workspaceID, ids[start:end])
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			for id, status := range chunk {
				resolved[id] = status
			}
		}
		statuses[workspaceID] = resolved
	}

	for i := range report.Tasks {
		task := &report.Tasks[i]
		if task.Kind != string(execenv.GCKindIssue) || task.ParentID == "" {
			continue
		}
		if status, ok := statuses[task.WorkspaceID][task.ParentID]; ok {
			task.ParentStatus = status
		}
	}
	return firstErr
}

// taskSize walks taskDir and returns (totalBytes, artifactBytes,
// repoCheckoutBytes, fileCount). All honor the GC safety contract: never
// descends into .git, never follows symlinks, counts only regular files.
//
//   - A directory matched by matcher is treated as an artifact subtree — its
//     size is added to both totalBytes and artifactBytes and the walk does not
//     descend further, so the size matches what os.RemoveAll would reclaim if
//     the GC ran cleanTaskArtifacts on it. matcher matches both basename
//     patterns (node_modules, .next, …) and daemon-managed exact subpaths
//     (codex-home, .sandbox-bin), so the two must stay in lockstep with what
//     the reclaim action actually deletes.
//   - A directory that contains a .git entry is a git checkout (worktree). Its
//     working-tree files still count toward totalBytes, and are additionally
//     attributed to repoCheckoutBytes so the UI can show how much is reclaimable
//     by re-checking-out the repo rather than deleting agent work. The .git
//     subtree itself is skipped, so repoCheckoutBytes tracks the working tree,
//     not the (worktree-local, tiny) git metadata.
func taskSize(taskDir string, matcher artifactMatcher) (totalBytes, artifactBytes, repoCheckoutBytes, fileCount int64) {
	if taskDir == "" {
		return
	}
	absRoot, err := filepath.Abs(taskDir)
	if err != nil {
		return
	}

	var repoRoots []string // prefixes of detected git-checkout directories

	_ = filepath.WalkDir(absRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if path == absRoot {
			return nil
		}
		// Symlinks: never followed, never counted. WalkDir already refuses to
		// descend through them, but a symlinked file would otherwise show up
		// here as a non-dir entry — drop it explicitly so the size stays
		// consistent with cleanTaskArtifacts' refusal to touch link targets.
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if entry.IsDir() {
			if entry.Name() == ".git" {
				totalBytes += dirSize(path)
				return filepath.SkipDir
			}
			if _, ok := matcher.matchDirectory(absRoot, path, entry); ok {
				size := dirSize(path)
				totalBytes += size
				artifactBytes += size
				// An artifact subtree sitting inside a checkout is reclaimed
				// when the checkout is cleared, so attribute it to the repo
				// total too (the two lenses intentionally overlap here).
				if hasPrefixAny(path+string(filepath.Separator), repoRoots) {
					repoCheckoutBytes += size
				}
				return filepath.SkipDir
			}
			// A dir holding a .git entry is a checkout root. WalkDir visits a
			// dir before its children, so recording the prefix here means every
			// file below is attributed correctly on the same pass.
			if isGitCheckoutDir(path) {
				repoRoots = append(repoRoots, path+string(filepath.Separator))
			}
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		if info.Mode().IsRegular() {
			totalBytes += info.Size()
			fileCount++
			if hasPrefixAny(path, repoRoots) {
				repoCheckoutBytes += info.Size()
			}
		}
		return nil
	})
	return
}

// hasPrefixAny reports whether s starts with any of prefixes.
func hasPrefixAny(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}

// isGitCheckoutDir reports whether dir is the root of a git working tree (it
// holds a .git entry — a real repo dir or a worktree's gitdir-pointer file).
func isGitCheckoutDir(dir string) bool {
	_, err := os.Lstat(filepath.Join(dir, ".git"))
	return err == nil
}

// ShortID returns the first 8 chars (dashes stripped) of a UUID, falling back
// to the raw input when shorter. Mirrors execenv.shortID, which lives in an
// internal subpackage and isn't exported.
func ShortID(id string) string {
	s := strings.ReplaceAll(id, "-", "")
	if len(s) > 8 {
		return s[:8]
	}
	return s
}
