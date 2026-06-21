package daemon

import (
	"context"
	"time"
)

const (
	// workspaceInventoryInterval is how often the daemon rescans and reports its
	// workspace footprint. Slow enough not to thrash the (NAS-backed) tree, fast
	// enough that the management page reflects reality within a few minutes.
	workspaceInventoryInterval = 3 * time.Minute
	// workspaceInventoryStartDelay lets registration + the first heartbeat settle
	// so the reported runtimes are already known to the server.
	workspaceInventoryStartDelay = 45 * time.Second
)

// workspaceInventoryLoop periodically scans the workspaces root and reports a
// per-workspace footprint snapshot to the server. The server caches it to power
// the workspace management UI — it can never read the daemon's filesystem
// directly (no inbound reachability, no Full Disk Access on NAS volumes), so
// this push is the only way the footprint reaches the UI.
func (d *Daemon) workspaceInventoryLoop(ctx context.Context) {
	if !d.cfg.GCEnabled {
		// The inventory mirrors what the GC manages; with GC disabled the daemon
		// is in a hands-off mode, so don't advertise a manageable inventory.
		d.logger.Info("workspace-inventory: disabled (gc disabled)")
		return
	}
	if err := sleepWithContext(ctx, workspaceInventoryStartDelay); err != nil {
		return
	}
	d.reportWorkspaceInventory(ctx)

	ticker := time.NewTicker(workspaceInventoryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.reportWorkspaceInventory(ctx)
		}
	}
}

// reportWorkspaceInventory scans the workspaces root once and reports each
// watched workspace's task footprint under one of its runtime IDs. Workspaces
// with no remaining tasks are still reported (empty slice) so the server clears
// the snapshot after the user deletes everything.
func (d *Daemon) reportWorkspaceInventory(ctx context.Context) {
	report, err := ScanDiskUsage(d.cfg.WorkspacesRoot, d.cfg.GCArtifactPatterns)
	if err != nil {
		d.logger.Warn("workspace-inventory: scan failed", "error", err)
		return
	}

	byWS := map[string][]TaskDiskUsage{}
	for _, t := range report.Tasks {
		byWS[t.WorkspaceID] = append(byWS[t.WorkspaceID], t)
	}

	for wsID, runtimeID := range d.watchedWorkspaceRuntime() {
		if err := d.client.ReportWorkspaceInventory(ctx, runtimeID, wsID, byWS[wsID], report.GeneratedAt); err != nil {
			d.logger.Warn("workspace-inventory: report failed", "workspace_id", wsID, "error", err)
		}
	}
}

// watchedWorkspaceRuntime maps each watched workspace UUID to one runtime ID the
// daemon can authenticate as for that workspace. Workspaces with no live runtime
// are skipped — there is nothing to authenticate the report with.
func (d *Daemon) watchedWorkspaceRuntime() map[string]string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make(map[string]string, len(d.workspaces))
	for wsID, ws := range d.workspaces {
		if len(ws.runtimeIDs) > 0 {
			out[wsID] = ws.runtimeIDs[0]
		}
	}
	return out
}
