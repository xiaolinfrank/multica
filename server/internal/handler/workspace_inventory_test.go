package handler

import (
	"testing"
	"time"
)

func TestWorkspaceInventoryStore_PutAndList(t *testing.T) {
	t.Parallel()
	s := NewInMemoryWorkspaceInventoryStore()

	s.Put("ws1", "daemonA", "agent_2", []inventoryTask{
		{WorkspaceID: "ws1", TaskShort: "t1", Kind: "issue", IssueID: "i1", SizeBytes: 100},
		{WorkspaceID: "ws1", TaskShort: "t2", Kind: "issue", IssueID: "i2", SizeBytes: 200},
	})
	s.Put("ws1", "daemonB", "agent_5", []inventoryTask{
		{WorkspaceID: "ws1", TaskShort: "t3", Kind: "issue", IssueID: "i3", SizeBytes: 50},
	})
	s.Put("ws2", "daemonA", "agent_2", []inventoryTask{
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

	if got := s.TasksForWorkspace("ws2"); len(got) != 1 {
		t.Fatalf("ws2: expected 1 task, got %d", len(got))
	}
}

func TestWorkspaceInventoryStore_LatestSnapshotWins(t *testing.T) {
	t.Parallel()
	s := NewInMemoryWorkspaceInventoryStore()

	s.Put("ws1", "daemonA", "agent_2", []inventoryTask{
		{WorkspaceID: "ws1", TaskShort: "old", Kind: "issue", SizeBytes: 100},
	})
	// Same daemon re-reports after a workspace was deleted on disk: empty slice
	// must replace the prior snapshot, not merge with it.
	s.Put("ws1", "daemonA", "agent_2", nil)

	if got := s.TasksForWorkspace("ws1"); len(got) != 0 {
		t.Fatalf("expected stale tasks cleared by empty re-report, got %d", len(got))
	}
}

func TestWorkspaceInventoryStore_StaleSnapshotDropped(t *testing.T) {
	t.Parallel()
	s := NewInMemoryWorkspaceInventoryStore()
	s.Put("ws1", "daemonA", "agent_2", []inventoryTask{
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
