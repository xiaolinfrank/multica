//go:build darwin && nasintegration

package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func TestRealNASCreateOnlyWorker(t *testing.T) {
	if os.Getenv("MULTICA_RUN_REAL_NAS_TEST") != "1" {
		t.Skip("explicit real NAS validation authorization is required")
	}
	parent := os.Getenv("MULTICA_REAL_NAS_PARENT")
	resolved, err := filepath.EvalSymlinks(parent)
	if err != nil || parent != "/Volumes/人机协作空间" || resolved != parent {
		t.Fatal("expected the explicitly authorized canonical agent3 SMB share")
	}
	mounts, err := exec.Command("/sbin/mount", "-t", "smbfs").Output()
	if err != nil || !strings.Contains(string(mounts), " on "+parent+" (smbfs,") {
		t.Fatal("authorized parent is not mounted as SMB")
	}
	f, version, _ := newCreateOnlyMinutesFixture(t)
	rootID := uuid.NewString()
	root := filepath.Join(parent, ".multica-validation-"+rootID)
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	owned, err := os.Stat(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("real worker private NAS root: %s", root)
	t.Cleanup(func() {
		current, err := os.Lstat(root)
		if err != nil || !current.IsDir() || current.Mode()&os.ModeSymlink != 0 || !os.SameFile(owned, current) {
			t.Errorf("refusing changed worker fixture cleanup: %v", err)
			return
		}
		if err := os.RemoveAll(root); err != nil {
			t.Errorf("worker fixture cleanup: %v", err)
			return
		}
		t.Logf("removed owned worker NAS root: %s", root)
	})
	marker, err := os.OpenFile(filepath.Join(root, cockpitnas.MarkerName), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := marker.WriteString(rootID + "\n"); err != nil {
		t.Fatal(err)
	}
	if err := marker.Close(); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(root, "会议材料")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal([]cockpitnas.Root{{WorkspaceID: util.UUIDToString(f.ws), RootID: rootID, Path: root, WriteMode: cockpitnas.ModeCreateOnly}})
	files, err := cockpitnas.New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	f.issues.CockpitNASExporter = files
	f.Exec(t, "UPDATE cockpit_meeting SET nas_dir=$2 WHERE id=$1", f.meeting, directory)
	target := CockpitMinutesExportTarget{RootID: rootID, Directory: directory, WriteMode: cockpitnas.ModeCreateOnly}
	if err := f.issues.PublishCockpitMeetingMinutes(context.Background(), CockpitMinutesVersionCommand{CockpitWorkPackageCommand: f.command(t), VersionID: version.ID, NASExport: &target}); err != nil {
		t.Fatal(err)
	}
	rows, err := f.q.ListCockpitMinutesExports(context.Background(), db.ListCockpitMinutesExportsParams{WorkspaceID: f.ws, MeetingID: f.meeting})
	if err != nil || len(rows) != 1 {
		t.Fatalf("missing durable intent: %v", err)
	}
	worker := NewCockpitMinutesExportWorker(f.q, files, f.issues.Bus)
	processMinutesExportFixture(t, worker)
	done := getMinutesExportFixture(t, f, rows[0].ID)
	if done.Status != "succeeded" || !done.VerifiedPath.Valid || !done.ReceiptPath.Valid || !done.VerifiedAttemptID.Valid || !done.ReceiptHash.Valid {
		t.Fatalf("real NAS worker did not confirm completion: %+v", done)
	}
	body, err := os.ReadFile(done.VerifiedPath.String)
	if err != nil || string(body) != version.Content || fmt.Sprintf("%x", sha256.Sum256(body)) != version.ContentHash {
		t.Fatalf("worker copy differs from approved source: %v", err)
	}
	receipt, err := os.ReadFile(done.ReceiptPath.String)
	if err != nil || fmt.Sprintf("%x", sha256.Sum256(receipt)) != done.ReceiptHash.String {
		t.Fatalf("worker receipt differs from recorded evidence: %v", err)
	}
	before, err := os.Stat(done.VerifiedPath.String)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := f.issues.RetryCockpitMinutesExport(context.Background(), CockpitMinutesExportRetry{WorkspaceID: f.ws, MeetingID: f.meeting, ExportID: done.ID, ActorID: f.owner, ExpectedRevision: done.Revision})
	if err != nil || retry.ID != done.ID || retry.Revision != done.Revision {
		t.Fatalf("same-operation retry changed an already confirmed copy: %v", err)
	}
	if worked, err := worker.ProcessNext(context.Background()); err != nil || worked {
		t.Fatalf("successful retry dispatched another filesystem operation: %t %v", worked, err)
	}
	after, _ := os.Stat(done.VerifiedPath.String)
	if !os.SameFile(before, after) {
		t.Fatal("successful retry replaced existing content")
	}
	page := createOnlyAttempts(t, f, done)
	if page.Total != 1 || page.Items[0].Status != "verified" || page.Items[0].VerifiedAttemptID == nil || *page.Items[0].VerifiedAttemptID != util.UUIDToString(done.VerifiedAttemptID) {
		t.Fatalf("NAS evidence and database ledger diverged: %+v", page)
	}
	t.Logf("verified operation=%s attempt=%s hash=%s bytes=%d; one durable attempt", util.UUIDToString(done.ID), util.UUIDToString(done.VerifiedAttemptID), done.ContentHash, len(body))
}
