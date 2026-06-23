package daemon

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
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
	// workspaceOpMaxDownloadBytes caps a download / image-preview payload.
	// Larger than the text preview cap (binaries like charts need the whole
	// file), but bounded so the base64 result stays manageable through the
	// in-memory op store and the heartbeat-relayed report. A file above this is
	// reported TooLarge with no content — a truncated binary is worthless.
	workspaceOpMaxDownloadBytes = 10 << 20 // 10 MiB
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

// wsDownloadResult carries a file's full bytes (base64) for download or inline
// image preview. Unlike read (text-only, 2 MiB preview cap), download returns
// the raw bytes up to workspaceOpMaxDownloadBytes and a sniffed MIME type, so
// binaries — images especially — can be rendered or saved. A file larger than
// the cap comes back with TooLarge=true and no content.
type wsDownloadResult struct {
	Path     string `json:"path"`
	Size     int64  `json:"size"`
	Mime     string `json:"mime"`
	Encoding string `json:"encoding,omitempty"` // "base64" when Content is set
	Content  string `json:"content,omitempty"`  // base64 of the file bytes
	IsImage  bool   `json:"is_image"`
	TooLarge bool   `json:"too_large"`
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
	case "download":
		var res wsDownloadResult
		res, err = downloadWorkspaceFile(envRoot, pending.Path)
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

// cleanWorkspaceRelPath normalizes a workspace-relative path: rejects NUL and
// empties, and collapses any ".." so the name is a tidy relative path. The
// final escape/symlink containment is enforced atomically by os.Root in the
// caller — this is just input hygiene + the echoed Path.
func cleanWorkspaceRelPath(rel string) (string, error) {
	if strings.IndexByte(rel, 0) != -1 {
		return "", errors.New("path contains NUL")
	}
	cleaned := filepath.Clean("/" + filepath.ToSlash(rel))
	cleaned = strings.TrimPrefix(cleaned, "/")
	if cleaned == "" || cleaned == "." {
		return "", errors.New("empty path")
	}
	return filepath.FromSlash(cleaned), nil
}

// readWorkspaceFile returns one file's contents, size-capped and sandboxed.
//
// The open goes through os.Root, which resolves every path component with
// openat beneath a held directory fd: a component that references anything
// outside envRoot — via "..", an absolute symlink, or a symlink whose target
// escapes — is refused. Crucially this is immune to the symlink-swap TOCTOU a
// plain EvalSymlinks+os.Open would have had (an agent racing the read can't
// redirect a component out of the workspace between check and open), since the
// resolution and open are one operation against the pinned root.
func readWorkspaceFile(envRoot, rel string) (wsReadResult, error) {
	cleaned, err := cleanWorkspaceRelPath(rel)
	if err != nil {
		return wsReadResult{}, err
	}

	root, err := os.OpenRoot(envRoot)
	if err != nil {
		return wsReadResult{}, fmt.Errorf("open workspace root: %w", err)
	}
	defer root.Close()

	f, err := root.Open(cleaned)
	if err != nil {
		// Covers not-found and any path that escaped the root (".." / escaping
		// symlink) — both are reported to the user as an unreadable file.
		return wsReadResult{}, errors.New("file not found")
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return wsReadResult{}, err
	}
	if !info.Mode().IsRegular() {
		return wsReadResult{}, errors.New("not a regular file")
	}

	// Read one byte past the cap so truncation is detected without trusting the
	// stat size (which can lie for special files).
	data, err := io.ReadAll(io.LimitReader(f, workspaceOpMaxReadBytes+1))
	if err != nil {
		return wsReadResult{}, err
	}
	result := wsReadResult{Path: filepath.ToSlash(cleaned), Size: info.Size()}
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

// downloadWorkspaceFile returns a file's full bytes, base64-encoded and
// MIME-typed, sandboxed to envRoot via os.Root exactly like readWorkspaceFile
// (every component resolved with openat beneath the pinned root, so "..",
// absolute symlinks and escaping symlinks are refused, TOCTOU-immune). Used for
// binary download and inline image preview; capped at workspaceOpMaxDownloadBytes
// — an oversized file is refused (TooLarge) rather than truncated, since a
// partial binary is worthless.
func downloadWorkspaceFile(envRoot, rel string) (wsDownloadResult, error) {
	cleaned, err := cleanWorkspaceRelPath(rel)
	if err != nil {
		return wsDownloadResult{}, err
	}

	root, err := os.OpenRoot(envRoot)
	if err != nil {
		return wsDownloadResult{}, fmt.Errorf("open workspace root: %w", err)
	}
	defer root.Close()

	f, err := root.Open(cleaned)
	if err != nil {
		return wsDownloadResult{}, errors.New("file not found")
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return wsDownloadResult{}, err
	}
	if !info.Mode().IsRegular() {
		return wsDownloadResult{}, errors.New("not a regular file")
	}

	result := wsDownloadResult{Path: filepath.ToSlash(cleaned), Size: info.Size()}
	// Read one byte past the cap so oversize is detected without trusting the
	// stat size (which can lie for special files).
	data, err := io.ReadAll(io.LimitReader(f, workspaceOpMaxDownloadBytes+1))
	if err != nil {
		return wsDownloadResult{}, err
	}
	if len(data) > workspaceOpMaxDownloadBytes {
		result.TooLarge = true
		result.Mime = mimeForFile(cleaned, nil)
		result.IsImage = strings.HasPrefix(result.Mime, "image/")
		return result, nil
	}
	result.Mime = mimeForFile(cleaned, data)
	result.IsImage = strings.HasPrefix(result.Mime, "image/")
	result.Encoding = "base64"
	result.Content = base64.StdEncoding.EncodeToString(data)
	return result, nil
}

// mimeForFile picks a MIME type for a workspace file. It sniffs the content
// (http.DetectContentType over the first 512 bytes) and refines it with a few
// extension overrides where sniffing is unreliable: SVG sniffs as text/xml, and
// some image types sniff as the generic octet-stream. data may be nil (the
// size-only TooLarge path), in which case the extension alone decides.
func mimeForFile(name string, data []byte) string {
	ext := strings.ToLower(filepath.Ext(name))
	// SVG is text under the hood; the sniffer never returns an image type for it.
	if ext == ".svg" {
		return "image/svg+xml"
	}
	if len(data) > 0 {
		ct := http.DetectContentType(data)
		if i := strings.IndexByte(ct, ';'); i >= 0 {
			ct = strings.TrimSpace(ct[:i])
		}
		if ct != "" && ct != "application/octet-stream" {
			return ct
		}
	}
	// Sniffing inconclusive (or no bytes): fall back to common extensions.
	switch ext {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".ico":
		return "image/x-icon"
	case ".pdf":
		return "application/pdf"
	}
	return "application/octet-stream"
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
