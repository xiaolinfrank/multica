package daemon

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

// Workspace file ops let the management UI browse, read and reclaim a
// persistent agent workspace that lives on the daemon's (NAS-backed) disk. The
// server can neither reach the daemon inbound nor read its filesystem (no Full
// Disk Access on network volumes), so it relays the request through the
// heartbeat ack and the daemon executes it locally and reports the result.
//
// Every op is sandboxed to the target envRoot
// ({WorkspacesRoot}/{WorkspaceID}/{TaskShort}). WorkspaceID, TaskShort and the
// read Path all originate from a workspace member's request and are treated as
// untrusted: a path that escapes the envRoot — via separators, "..", or a
// symlink the agent planted inside its own workspace — is refused, never read.

const (
	// workspaceOpMaxReadBytes caps a single file read, aligned with the
	// attachment-preview text cap. Larger files come back truncated.
	workspaceOpMaxReadBytes = 2 << 20 // 2 MiB
	// workspaceOpMaxTreeEntries bounds the tree payload so a pathological
	// workspace can't produce a multi-megabyte listing. Repo checkouts are
	// already collapsed, so this only bites on genuinely huge agent output.
	workspaceOpMaxTreeEntries = 5000
)

// wsFileEntry is one node in a workspace file tree. Kind is "repo" (a collapsed
// git checkout), "artifact" (a collapsed regenerable dir like node_modules) or
// "" (a normal file or directory). Repo/artifact dirs are reported as a single
// node with their total Size and are not browsable — the UI marks them
// regenerable rather than expanding thousands of files.
type wsFileEntry struct {
	Path  string `json:"path"`
	Size  int64  `json:"size"`
	IsDir bool   `json:"is_dir"`
	Kind  string `json:"kind,omitempty"`
}

type wsTreeResult struct {
	Entries   []wsFileEntry `json:"entries"`
	Truncated bool          `json:"truncated"`
}

type wsReadResult struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	IsText    bool   `json:"is_text"`
	Content   string `json:"content,omitempty"`
	Truncated bool   `json:"truncated"`
}

type wsReclaimResult struct {
	Mode           string   `json:"mode"`
	ReclaimedBytes int64    `json:"reclaimed_bytes"`
	Removed        []string `json:"removed"`
}

// handleWorkspaceOp runs one workspace file op against the local disk and
// reports the result. It deliberately does not depend on the Runtime registry —
// a file op only needs the envRoot path and the runtimeID to authenticate the
// report, so it still works while the runtime index is momentarily out of sync.
func (d *Daemon) handleWorkspaceOp(ctx context.Context, runtimeID string, pending *PendingWorkspaceOp) {
	if pending == nil {
		return
	}
	d.logger.Info("workspace op requested",
		"runtime_id", runtimeID, "request_id", pending.ID, "op", pending.Op,
		"workspace_id", pending.WorkspaceID, "task_short", pending.TaskShort)

	envRoot, err := resolveEnvRootSandboxed(d.cfg.WorkspacesRoot, pending.WorkspaceID, pending.TaskShort)
	if err != nil {
		d.reportWorkspaceOpResult(ctx, runtimeID, pending.ID, map[string]any{"status": "failed", "error": err.Error()})
		return
	}
	patternSet := buildPatternSet(d.cfg.GCArtifactPatterns)

	var payload any
	switch pending.Op {
	case "tree":
		var res wsTreeResult
		res, err = workspaceTree(envRoot, patternSet)
		payload = res
	case "read":
		var res wsReadResult
		res, err = readWorkspaceFile(envRoot, pending.Path)
		payload = res
	case "reclaim":
		mode := pending.Mode
		if mode != "full" {
			mode = "artifacts"
		}
		var res wsReclaimResult
		res, err = reclaimWorkspace(envRoot, mode, patternSet)
		payload = res
	default:
		err = fmt.Errorf("unknown workspace op %q", pending.Op)
	}
	if err != nil {
		d.reportWorkspaceOpResult(ctx, runtimeID, pending.ID, map[string]any{"status": "failed", "error": err.Error()})
		return
	}
	d.reportWorkspaceOpResult(ctx, runtimeID, pending.ID, map[string]any{"status": "completed", "payload": payload})
}

// reportWorkspaceOpResult delivers a workspace-op result to the server with the
// same retry semantics as the other async reports (5xx/network retried, 4xx
// terminal), so a transient store failure doesn't strand the request in
// "running" until its server-side timeout.
func (d *Daemon) reportWorkspaceOpResult(ctx context.Context, runtimeID, requestID string, payload map[string]any) {
	d.reportRuntimeResultWithRetry(ctx, "workspace_op", runtimeID, requestID, func(ctx context.Context) error {
		return d.client.ReportWorkspaceOpResult(ctx, runtimeID, requestID, payload)
	})
}

// safePathComponent rejects a single path segment that could escape its parent:
// empty, "."/"..", anything with a separator, or an embedded NUL.
func safePathComponent(s string) error {
	if s == "" {
		return errors.New("empty")
	}
	if s == "." || s == ".." {
		return errors.New("traversal component")
	}
	if strings.ContainsAny(s, `/\`) {
		return errors.New("contains path separator")
	}
	if strings.IndexByte(s, 0) != -1 {
		return errors.New("contains NUL")
	}
	return nil
}

// resolveEnvRootSandboxed builds the absolute envRoot for (workspaceID,
// taskShort) and verifies it is a real directory directly under workspacesRoot.
// Both ids are validated as single safe path components first, so the join can
// never climb out of the root.
func resolveEnvRootSandboxed(workspacesRoot, workspaceID, taskShort string) (string, error) {
	if strings.TrimSpace(workspacesRoot) == "" {
		return "", errors.New("workspaces root not configured")
	}
	if err := safePathComponent(workspaceID); err != nil {
		return "", fmt.Errorf("workspace_id: %w", err)
	}
	if err := safePathComponent(taskShort); err != nil {
		return "", fmt.Errorf("task_short: %w", err)
	}
	rootAbs, err := filepath.Abs(workspacesRoot)
	if err != nil {
		return "", err
	}
	envRoot := filepath.Join(rootAbs, workspaceID, taskShort)
	// Defense in depth: the join must have stayed inside the root.
	rel, relErr := filepath.Rel(rootAbs, envRoot)
	if relErr != nil || rel == "." || strings.HasPrefix(rel, "..") {
		return "", errors.New("path escapes workspaces root")
	}
	info, err := os.Lstat(envRoot)
	if err != nil {
		return "", errors.New("workspace not found")
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("workspace root is a symlink")
	}
	if !info.IsDir() {
		return "", errors.New("workspace is not a directory")
	}
	return envRoot, nil
}

// workspaceTree walks envRoot and returns its file tree with git checkouts and
// artifact dirs collapsed to single nodes. Follows the disk-usage safety
// contract: never enters .git, never follows symlinks, counts only regular
// files. Capped at workspaceOpMaxTreeEntries.
func workspaceTree(envRoot string, patternSet map[string]struct{}) (wsTreeResult, error) {
	var result wsTreeResult
	result.Entries = []wsFileEntry{}
	absRoot, err := filepath.Abs(envRoot)
	if err != nil {
		return result, err
	}

	walkErr := filepath.WalkDir(absRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if path == absRoot {
			return nil
		}
		if len(result.Entries) >= workspaceOpMaxTreeEntries {
			result.Truncated = true
			return filepath.SkipAll
		}
		// Symlinks are never followed and never reported — a symlinked dir
		// would otherwise let the tree wander outside the workspace.
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		rel, relErr := filepath.Rel(absRoot, path)
		if relErr != nil || rel == "" || rel == "." || strings.HasPrefix(rel, "..") {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		relSlash := filepath.ToSlash(rel)
		if entry.IsDir() {
			base := entry.Name()
			if base == ".git" {
				return filepath.SkipDir
			}
			if _, ok := patternSet[base]; ok {
				result.Entries = append(result.Entries, wsFileEntry{Path: relSlash, Size: dirSize(path), IsDir: true, Kind: "artifact"})
				return filepath.SkipDir
			}
			if isGitCheckoutDir(path) {
				result.Entries = append(result.Entries, wsFileEntry{Path: relSlash, Size: dirSize(path), IsDir: true, Kind: "repo"})
				return filepath.SkipDir
			}
			result.Entries = append(result.Entries, wsFileEntry{Path: relSlash, IsDir: true})
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		if info.Mode().IsRegular() {
			result.Entries = append(result.Entries, wsFileEntry{Path: relSlash, Size: info.Size()})
		}
		return nil
	})
	if walkErr != nil {
		return result, walkErr
	}
	sort.Slice(result.Entries, func(i, j int) bool { return result.Entries[i].Path < result.Entries[j].Path })
	return result, nil
}

// resolveFileWithin turns a workspace-relative path into an absolute path inside
// envRoot, neutralizing any ".." that tries to climb above the root. It does not
// touch the filesystem; symlink containment is checked by the caller.
func resolveFileWithin(envRoot, rel string) (string, error) {
	if strings.IndexByte(rel, 0) != -1 {
		return "", errors.New("path contains NUL")
	}
	// Force-root then clean so "/a/../../etc" collapses to "/etc" (still inside
	// the forced root) rather than climbing past it.
	cleaned := filepath.Clean("/" + filepath.ToSlash(rel))
	cleaned = strings.TrimPrefix(cleaned, "/")
	if cleaned == "" || cleaned == "." {
		return "", errors.New("empty path")
	}
	abs := filepath.Join(envRoot, filepath.FromSlash(cleaned))
	relCheck, err := filepath.Rel(envRoot, abs)
	if err != nil || relCheck == "." || strings.HasPrefix(relCheck, "..") {
		return "", errors.New("path escapes workspace")
	}
	return abs, nil
}

// readWorkspaceFile returns one file's contents, size-capped and sandboxed. The
// load-bearing guard is the EvalSymlinks containment re-check: an agent can
// write an arbitrary symlink into its own workspace, so the real resolved path
// must still sit inside the real envRoot before a single byte is read.
func readWorkspaceFile(envRoot, rel string) (wsReadResult, error) {
	abs, err := resolveFileWithin(envRoot, rel)
	if err != nil {
		return wsReadResult{}, err
	}

	realEnv, err := filepath.EvalSymlinks(envRoot)
	if err != nil {
		return wsReadResult{}, fmt.Errorf("resolve workspace root: %w", err)
	}
	realFile, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return wsReadResult{}, errors.New("file not found")
	}
	if rc, relErr := filepath.Rel(realEnv, realFile); relErr != nil || rc == "." || strings.HasPrefix(rc, "..") {
		return wsReadResult{}, errors.New("path escapes workspace")
	}

	info, err := os.Lstat(realFile)
	if err != nil {
		return wsReadResult{}, err
	}
	if !info.Mode().IsRegular() {
		return wsReadResult{}, errors.New("not a regular file")
	}

	f, err := os.Open(realFile)
	if err != nil {
		return wsReadResult{}, err
	}
	defer f.Close()

	// Read one byte past the cap so truncation is detected without trusting the
	// stat size (which can lie for special files).
	data, err := io.ReadAll(io.LimitReader(f, workspaceOpMaxReadBytes+1))
	if err != nil {
		return wsReadResult{}, err
	}
	result := wsReadResult{Path: filepath.ToSlash(rel), Size: info.Size()}
	if len(data) > workspaceOpMaxReadBytes {
		data = data[:workspaceOpMaxReadBytes]
		result.Truncated = true
	}
	// Text only: valid UTF-8 with no NUL byte. Binary files come back with
	// IsText=false and no content; the UI offers a download instead.
	if utf8.Valid(data) && bytes.IndexByte(data, 0) == -1 {
		result.IsText = true
		result.Content = string(data)
	}
	return result, nil
}

// reclaimWorkspace frees disk. mode="full" removes the whole envRoot;
// mode="artifacts" removes only regenerable subtrees (git checkouts +
// artifact-pattern dirs), never the agent's own files. Best effort: a subtree
// that fails to remove is skipped, and only what actually succeeded is reported.
func reclaimWorkspace(envRoot, mode string, patternSet map[string]struct{}) (wsReclaimResult, error) {
	result := wsReclaimResult{Mode: mode, Removed: []string{}}
	absRoot, err := filepath.Abs(envRoot)
	if err != nil {
		return result, err
	}

	if mode == "full" {
		size := dirSize(absRoot)
		if err := os.RemoveAll(absRoot); err != nil {
			return result, err
		}
		result.ReclaimedBytes = size
		result.Removed = append(result.Removed, ".")
		return result, nil
	}

	var targets []string
	_ = filepath.WalkDir(absRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if path == absRoot {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if !entry.IsDir() {
			return nil
		}
		rel, relErr := filepath.Rel(absRoot, path)
		if relErr != nil || rel == "" || rel == "." || strings.HasPrefix(rel, "..") {
			return filepath.SkipDir
		}
		base := entry.Name()
		if base == ".git" {
			return filepath.SkipDir
		}
		if _, ok := patternSet[base]; ok {
			targets = append(targets, path)
			return filepath.SkipDir
		}
		if isGitCheckoutDir(path) {
			targets = append(targets, path)
			return filepath.SkipDir
		}
		return nil
	})

	for _, t := range targets {
		size := dirSize(t)
		if err := os.RemoveAll(t); err != nil {
			continue
		}
		result.ReclaimedBytes += size
		if rel, relErr := filepath.Rel(absRoot, t); relErr == nil {
			result.Removed = append(result.Removed, filepath.ToSlash(rel))
		}
	}
	return result, nil
}
