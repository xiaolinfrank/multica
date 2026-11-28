package daemon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"time"

	"github.com/multica-ai/multica/server/internal/daemon/execenv"
)

const issueArtifactSweepFile = ".gc_issue_artifacts"

func (d *Daemon) issueArtifactEligible(meta *execenv.GCMeta) bool {
	return d.cfg.GCArtifactTTL > 0 && !meta.CompletedAt.IsZero() && time.Since(meta.CompletedAt) > d.cfg.GCArtifactTTL
}

// cleanIssueTaskArtifacts sweeps a completed issue task's regenerable artifacts
// at most once per completed run.
//
// Issue workspaces are persistent: once the artifact pass has run for a given
// completed run there is nothing left to reclaim, so walking the whole tree
// again every GC cycle (every 2h) would burn shared-storage/SMB round-trips for
// no benefit. The marker records (workspace, issue, task, completed_at,
// artifact matcher) — the exact inputs that determine what the sweep removes —
// and a matching marker skips the walk entirely. Because an issue can run again
// while the server gc-check request is in flight, revalidate the on-disk meta
// under the env-root reservation before sweeping or stamping the marker.
func (d *Daemon) cleanIssueTaskArtifacts(ctx context.Context, taskDir string, checked *execenv.GCMeta, stats *gcStats) {
	matcher := newArtifactMatcher(d.cfg.GCArtifactPatterns, execenv.ManagedReclaimableArtifactSubpaths())
	if checked == nil || checked.Kind != execenv.GCKindIssue {
		removed, bytes, perPattern := d.cleanTaskArtifactsMatching(ctx, taskDir, matcher)
		recordArtifactCleanup(stats, removed, bytes, perPattern)
		return
	}
	if ctx.Err() != nil {
		return
	}

	meta, err := execenv.ReadGCMeta(taskDir)
	if err != nil || meta.Kind != execenv.GCKindIssue || !d.issueArtifactEligible(meta) ||
		meta.WorkspaceID != checked.WorkspaceID || meta.IssueID != checked.IssueID ||
		meta.TaskID != checked.TaskID || !meta.CompletedAt.Equal(checked.CompletedAt) {
		return
	}

	marker := issueArtifactSweepMarker(meta, matcher)
	if issueArtifactSweepRecorded(taskDir, marker) {
		return
	}

	removed, bytes, perPattern, complete := d.sweepTaskArtifacts(ctx, taskDir, matcher)
	recordArtifactCleanup(stats, removed, bytes, perPattern)
	if complete && ctx.Err() == nil {
		if err := writeArtifactSweepMarker(filepath.Join(taskDir, issueArtifactSweepFile), issueArtifactSweepFile, marker[:]); err != nil {
			d.logger.Warn("gc: write issue artifact sweep marker failed", "dir", taskDir, "error", err)
		}
	}
}

func issueArtifactSweepMarker(meta *execenv.GCMeta, matcher artifactMatcher) [sha256.Size]byte {
	return sha256.Sum256(fmt.Appendf(nil, "v1:%q:%q:%q:%q:%q:%q", meta.WorkspaceID, meta.IssueID, meta.TaskID,
		meta.CompletedAt.UTC().Format(time.RFC3339Nano), slices.Sorted(maps.Keys(matcher.basenames)), matcher.managedSubpaths()))
}

func issueArtifactSweepRecorded(taskDir string, marker [sha256.Size]byte) bool {
	return artifactSweepRecorded(taskDir, issueArtifactSweepFile, marker)
}

// artifactSweepRecorded reports whether taskDir already carries a sweep marker
// for the given file that exactly matches marker. Any mismatch — missing,
// wrong size, unreadable, or stale — means the sweep must run again.
func artifactSweepRecorded(taskDir, markerFile string, marker [sha256.Size]byte) bool {
	path := filepath.Join(taskDir, markerFile)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != int64(len(marker)) {
		return false
	}
	saved, err := os.ReadFile(path)
	return err == nil && bytes.Equal(saved, marker[:])
}

// writeArtifactSweepMarker atomically replaces path with marker so an
// interrupted write can never leave a truncated marker that a later cycle reads
// as "already swept".
func writeArtifactSweepMarker(path, tmpPrefix string, marker []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), tmpPrefix+"-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	_, writeErr := tmp.Write(marker)
	closeErr := tmp.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(tmp.Name(), path)
}
