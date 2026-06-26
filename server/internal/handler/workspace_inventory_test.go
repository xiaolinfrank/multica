package handler

import (
	"testing"
	"time"
)

func TestWorkspaceInventoryStore_PutAndList(t *testing.T) {
	t.Parallel()
	s := NewInMemoryWorkspaceInventoryStore()

	s.Put("ws1", "daemonA", "rt-A2", "agent_2", []inventoryTask{
		{WorkspaceID: "ws1", TaskShort: "t1", Kind: "issue", IssueID: "i1", SizeBytes: 100},
		{WorkspaceID: "ws1", TaskShort: "t2", Kind: "issue", IssueID: "i2", SizeBytes: 200},
	})
	s.Put("ws1", "daemonB", "rt-B5", "agent_5", []inventoryTask{
		{WorkspaceID: "ws1", TaskShort: "t3", Kind: "issue", IssueID: "i3", SizeBytes: 50},
	})
	s.Put("ws2", "daemonA", "rt-A2-ws2", "agent_2", []inventoryTask{
		{WorkspaceID: "ws2", TaskShort: "t9", Kind: "issue", IssueID: "i9", SizeBytes: 999},
	})

	got := s.TasksForWorkspace("ws1")
	if len(got) != 3 {
		t.Fatalf("ws1: expected 3 tasks across both daemons, got %d", len(got))
	}
	// Cross-workspace isolation: ws2's task must not leak into ws1.
	for _, dt := range got {
		if dt.TaskShort == "t9" {
			t.Fatal("ws2 task leaked into ws1 listing")
		}
	}
	// Device annotation is carried through.
	devices := map[string]bool{}
	for _, dt := range got {
		devices[dt.DeviceName] = true
	}
	if !devices["agent_2"] || !devices["agent_5"] {
		t.Fatalf("expected both device names, got %v", devices)
	}
	// The reporting runtime is carried through so an on-demand op can be routed
	// back to the daemon that holds the files.
	for _, dt := range got {
		if dt.TaskShort == "t1" && dt.RuntimeID != "rt-A2" {
			t.Fatalf("t1 should route to rt-A2, got %q", dt.RuntimeID)
		}
		if dt.TaskShort == "t3" && dt.RuntimeID != "rt-B5" {
			t.Fatalf("t3 should route to rt-B5, got %q", dt.RuntimeID)
		}
	}

	if got := s.TasksForWorkspace("ws2"); len(got) != 1 {
		t.Fatalf("ws2: expected 1 task, got %d", len(got))
	}
}

func TestWorkspaceInventoryStore_LatestSnapshotWins(t *testing.T) {
	t.Parallel()
	s := NewInMemoryWorkspaceInventoryStore()

	s.Put("ws1", "daemonA", "rt-A2", "agent_2", []inventoryTask{
		{WorkspaceID: "ws1", TaskShort: "old", Kind: "issue", SizeBytes: 100},
	})
	// Same daemon re-reports after a workspace was deleted on disk: empty slice
	// must replace the prior snapshot, not merge with it.
	s.Put("ws1", "daemonA", "rt-A2", "agent_2", nil)

	if got := s.TasksForWorkspace("ws1"); len(got) != 0 {
		t.Fatalf("expected stale tasks cleared by empty re-report, got %d", len(got))
	}
}

func TestWorkspaceInventoryStore_StaleSnapshotDropped(t *testing.T) {
	t.Parallel()
	s := NewInMemoryWorkspaceInventoryStore()
	s.Put("ws1", "daemonA", "rt-A2", "agent_2", []inventoryTask{
		{WorkspaceID: "ws1", TaskShort: "t1", Kind: "issue", SizeBytes: 100},
	})

	// Force the snapshot to look older than the staleness window.
	s.mu.Lock()
	snap := s.byWorkspace["ws1"]["daemonA"]
	snap.receivedAt = time.Now().Add(-workspaceInventoryStaleAfter - time.Minute)
	s.byWorkspace["ws1"]["daemonA"] = snap
	s.mu.Unlock()

	if got := s.TasksForWorkspace("ws1"); len(got) != 0 {
		t.Fatalf("expected stale daemon snapshot to be dropped, got %d tasks", len(got))
	}
}

func TestWorkspaceInventoryStore_DedupsSameTaskShortAcrossDaemons(t *testing.T) {
	t.Parallel()
	s := NewInMemoryWorkspaceInventoryStore()

	// A runtime re-registered with a fresh daemon_id; the prior daemon's
	// snapshot is still inside the staleness window. Both report the SAME
	// physical directory (same task_short) for the same workspace — exactly the
	// transient that would otherwise double the row.
	s.Put("ws1", "daemon-old", "rt-old", "dev-1", []inventoryTask{
		{WorkspaceID: "ws1", TaskShort: "dup", Kind: "issue", IssueID: "i1", SizeBytes: 100, FileCount: 5},
	})
	s.Put("ws1", "daemon-new", "rt-new", "dev-1", []inventoryTask{
		{WorkspaceID: "ws1", TaskShort: "dup", Kind: "issue", IssueID: "i1", SizeBytes: 140, FileCount: 7},
	})
	// Pin receivedAt so the winner is deterministic regardless of clock
	// resolution: daemon-new is newer, both within the staleness window.
	s.mu.Lock()
	now := time.Now()
	snapOld := s.byWorkspace["ws1"]["daemon-old"]
	snapOld.receivedAt = now.Add(-2 * time.Minute)
	s.byWorkspace["ws1"]["daemon-old"] = snapOld
	snapNew := s.byWorkspace["ws1"]["daemon-new"]
	snapNew.receivedAt = now.Add(-1 * time.Minute)
	s.byWorkspace["ws1"]["daemon-new"] = snapNew
	s.mu.Unlock()

	got := s.TasksForWorkspace("ws1")
	if len(got) != 1 {
		t.Fatalf("expected the duplicate task_short collapsed to 1 row, got %d", len(got))
	}
	// The most recently received snapshot wins, so the row reflects the latest
	// scan (size/file_count) and routes to the live runtime.
	if got[0].RuntimeID != "rt-new" {
		t.Fatalf("expected latest snapshot's runtime rt-new, got %q", got[0].RuntimeID)
	}
	if got[0].SizeBytes != 140 || got[0].FileCount != 7 {
		t.Fatalf("expected latest scan size/count 140/7, got %d/%d", got[0].SizeBytes, got[0].FileCount)
	}
}
