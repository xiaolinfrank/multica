//go:build darwin || linux

package service

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestCockpitInputNASCapturePinsObservedFileAndSurvivesSourceRemoval(t *testing.T) {
	f, s, p, _ := inputUploadFixture(t)
	ctx := context.Background()
	root := t.TempDir()
	rootID := util.UUIDToString(dbid.NewV7())
	if err := os.WriteFile(filepath.Join(root, cockpitnas.MarkerName), []byte(rootID+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "inputs"), 0700); err != nil {
		t.Fatal(err)
	}
	data := []byte("Original team-folder material\n")
	path := filepath.Join(root, "inputs", "recording.txt")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	cfg, _ := json.Marshal([]cockpitnas.Root{{WorkspaceID: util.UUIDToString(p.WorkspaceID), RootID: rootID, Path: root, AllowLocal: true, InputSubpaths: []string{"inputs"}}})
	provider, err := cockpitnas.New(string(cfg))
	if err != nil {
		t.Fatal(err)
	}
	s.ConfigureCockpitInputNAS(provider, "")
	page, err := s.BrowseCockpitInputSpace(ctx, p, rootID, CockpitInputNASBrowseInput{RelativeDirectory: "inputs", PageSize: 25})
	if err != nil || len(page.Items) != 1 || !page.Items[0].CanSelect {
		t.Fatalf("scoped source selection: %+v %v", page, err)
	}
	head, err := s.CreateCockpitInput(ctx, p, CockpitInputCreateInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: "Fixed team-folder file"})
	if err != nil {
		t.Fatal(err)
	}
	q := CockpitInputQuery{CockpitInputRead: p, InputID: inputTrustedID(head.Receipt.InputID)}
	sub, err := s.SubmitCockpitInputVersion(ctx, q, CockpitInputVersionSubmitInput{CommandKey: util.UUIDToString(dbid.NewV7()), ExpectedRevision: 1, Source: CockpitInputSourceInput{Kind: "nas_file", NASFile: &CockpitInputNASSource{RootID: rootID, RelativePath: page.Items[0].RelativePath, ObservationToken: page.Items[0].ObservationToken}}})
	if err != nil {
		t.Fatal(err)
	}
	if worked, e := s.ProcessNextCockpitInputCapture(ctx); e != nil || !worked {
		t.Fatalf("actual source capture: %v %v", worked, e)
	}
	q.VersionID, q.TransferID = inputTrustedID(sub.Receipt.VersionID), inputTrustedID(*sub.Receipt.TransferID)
	transfer, err := f.q.GetCockpitInputTransfer(ctx, db.GetCockpitInputTransferParams{WorkspaceID: p.WorkspaceID, InputID: q.InputID, VersionID: q.VersionID, ID: q.TransferID})
	if err != nil || !transfer.SourceBeforeFileIdentity.Valid || transfer.SourceBeforeFileIdentity != transfer.SourceAfterFileIdentity || transfer.SourceBeforeSize != transfer.SourceAfterSize || transfer.SourceBeforeMtimeNs != transfer.SourceAfterMtimeNs {
		t.Fatalf("verified before/after observation: %+v %v", transfer, err)
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	_, reader, err := s.OpenCockpitInputFile(ctx, q)
	if err != nil {
		t.Fatal(err)
	}
	got, e := io.ReadAll(reader)
	closeErr := reader.Close()
	if e != nil || closeErr != nil || string(got) != string(data) {
		t.Fatalf("fixed copy depended on mutable source: %q %v %v", got, e, closeErr)
	}
	if _, err = os.Stat(filepath.Join(root, cockpitnas.MarkerName)); err != nil {
		t.Fatal("capture changed the source root marker")
	}
}
