//go:build darwin || linux

package cockpitnas

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func inputFixture(t *testing.T, scopes []string) (*Files, Root) {
	t.Helper()
	root := Root{WorkspaceID: uuid.NewString(), RootID: uuid.NewString(), Path: t.TempDir(), AllowLocal: true, WriteMode: ModeCreateOnly, InputSubpaths: scopes}
	raw, err := json.Marshal([]Root{root})
	if err != nil {
		t.Fatal(err)
	}
	files, err := New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root.Path, MarkerName), []byte(root.RootID+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return files, root
}
func TestInputScopeIsIndependentFromPreparationAndExport(t *testing.T) {
	files, root := preparationFixture(t, []string{"."})
	if _, err := files.Resolve(root.WorkspaceID, root.Path, uuid.NewString(), 1); err != nil {
		t.Fatal(err)
	}
	if _, err := files.ResolvePreparation(root.WorkspaceID, root.RootID, "meeting"); err != nil {
		t.Fatal(err)
	}
	_, _, err := files.inputRoot(root.WorkspaceID, root.RootID, ".")
	wantCode(t, err, "input_scope_not_configured")
	root.InputSubpaths = []string{"inputs"}
	raw, _ := json.Marshal([]Root{root})
	files, err = New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = files.inputRoot(root.WorkspaceID, root.RootID, "inputs/ordinary.txt"); err != nil {
		t.Fatal(err)
	}
	for _, outside := range []string{".", "inputs-sibling/file.txt", "meeting/file.txt", "inputs/../outside", "inputs//file.txt", "/absolute"} {
		_, _, err = files.inputRoot(root.WorkspaceID, root.RootID, outside)
		wantCode(t, err, "input_path_outside_scope")
	}
	_, _, err = files.inputRoot(uuid.NewString(), root.RootID, "inputs/file.txt")
	wantCode(t, err, "input_scope_not_configured")
	_, _, err = files.inputRoot(root.WorkspaceID, uuid.NewString(), "inputs/file.txt")
	wantCode(t, err, "input_path_outside_scope")
	entries, err := os.ReadDir(root.Path)
	if err != nil || len(entries) != 1 || entries[0].Name() != MarkerName {
		t.Fatal("configuration or scope resolution touched filesystem contents")
	}
}
func TestInputScopeConfigurationIsCanonicalAndBounded(t *testing.T) {
	_, root := inputFixture(t, nil)
	invalid := [][]string{{""}, {"../other"}, {"a/../b"}, {"/absolute"}, {"a//b"}, {"a\\b"}, {"a\nb"}, {strings.Repeat("x", 256)}, {"same", "same"}}
	many := make([]string, 33)
	for i := range many {
		many[i] = uuid.NewString()
	}
	invalid = append(invalid, many)
	for _, scopes := range invalid {
		root.InputSubpaths = scopes
		raw, _ := json.Marshal([]Root{root})
		if _, err := New(string(raw)); err == nil {
			t.Fatalf("accepted invalid input scopes: %q", scopes)
		}
	}
	root.InputSubpaths = []string{"two", "one"}
	raw, _ := json.Marshal([]Root{root})
	files, err := New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if files.roots[root.WorkspaceID].InputSubpaths[0] != "one" {
		t.Fatal("equivalent configuration did not normalize consistently")
	}
}
func TestInputScopeHashDoesNotInheritWriteAuthority(t *testing.T) {
	files, root := inputFixture(t, []string{"inputs"})
	_, before, err := files.inputRoot(root.WorkspaceID, root.RootID, "inputs/file")
	if err != nil {
		t.Fatal(err)
	}
	root.PrepareSubpaths = []string{"."}
	root.WriteMode = ModeAtomic
	raw, _ := json.Marshal([]Root{root})
	changed, err := New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	_, after, err := changed.inputRoot(root.WorkspaceID, root.RootID, "inputs/file")
	if err != nil || before != after {
		t.Fatal("export/preparation changes silently changed the independent input grant")
	}
	root.InputSubpaths = []string{"inputs", "other"}
	raw, _ = json.Marshal([]Root{root})
	changed, err = New(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	_, after, err = changed.inputRoot(root.WorkspaceID, root.RootID, "inputs/file")
	if err != nil || before == after {
		t.Fatal("input scope changes did not invalidate their observations")
	}
}
