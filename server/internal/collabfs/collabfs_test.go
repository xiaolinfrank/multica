//go:build darwin || linux

package collabfs

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSanitizeFolderNameTurnsHostileTextIntoOneSegment(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		maxRunes int
		want     string
	}{
		{"path separators", `a/b\c:d`, 0, "a-b-c-d"},
		{"control characters", "a\x00b\x01c", 0, "a-b-c"},
		{"surrounding spaces and dots", "  ..Módulo..." + "  ", 0, "Módulo"},
		{"nfc normalisation", "Mo\u0301dulo", 0, "Módulo"},
		{"truncation by runes", "注册路径设计说明", 3, "注册路"},
		{"no rune limit", "注册路径设计说明", 0, "注册路径设计说明"},
		{"byte cap under 240", strings.Repeat("测", 100), 0, strings.Repeat("测", 80)},
	}
	for _, tc := range cases {
		if got := SanitizeFolderName(tc.raw, tc.maxRunes); got != tc.want {
			t.Errorf("%s: SanitizeFolderName(%q, %d) = %q, want %q", tc.name, tc.raw, tc.maxRunes, got, tc.want)
		}
	}
}

func TestUniqueNameAppendsSuffixesCaseInsensitively(t *testing.T) {
	taken := map[string]bool{}
	probe := func(name string) bool { return taken[strings.ToLower(name)] }

	first := UniqueName("Confirm", probe)
	taken[strings.ToLower(first)] = true
	if first != "Confirm" {
		t.Fatalf("first = %q", first)
	}
	second := UniqueName("Confirm", probe)
	taken[strings.ToLower(second)] = true
	if second != "Confirm(2)" {
		t.Fatalf("second = %q", second)
	}
	third := UniqueName("CONFIRM", probe)
	if third != "CONFIRM(3)" {
		t.Fatalf("third = %q", third)
	}
	if got := UniqueName("", probe); got == "" {
		t.Fatal("an empty base must still produce a name")
	}
}

func TestEnsureDirCreatesNestedLevelsOnceAndRefusesUnsafeEntries(t *testing.T) {
	root := t.TempDir()
	if err := EnsureDir(root, "Project", "4.01", "4.01确权线"); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDir(root, "Project", "4.01", "4.01确权线"); err != nil {
		t.Fatalf("idempotent create: %v", err)
	}
	if info, err := os.Stat(filepath.Join(root, "Project", "4.01", "4.01确权线")); err != nil || !info.IsDir() {
		t.Fatalf("folder not created: %v", err)
	}

	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDir(root, "link", "nested"); err == nil {
		t.Fatal("followed a symlink")
	}
	if _, err := os.Stat(filepath.Join(outside, "nested")); !os.IsNotExist(err) {
		t.Fatal("wrote through a symlink")
	}

	if err := os.WriteFile(filepath.Join(root, "file"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := EnsureDir(root, "file"); !errors.Is(err, ErrDirectoryChanged) {
		t.Fatalf("file in the way = %v", err)
	}
	if err := EnsureDir(root, "..", "escape"); err == nil {
		t.Fatal("accepted a parent escape")
	}
}

func TestStatDirClassifiesRootAndDirectories(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "present"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if code, err := StatDir(root, "present"); code != StatOK || err != nil {
		t.Fatalf("present = %s %v", code, err)
	}
	if code, err := StatDir(root, "absent"); code != StatMissing || err != nil {
		t.Fatalf("absent = %s %v", code, err)
	}
	if code, _ := StatDir(root, "file"); code != StatInvalid {
		t.Fatalf("file = %s", code)
	}
	if code, _ := StatDir(filepath.Join(root, "nope")); code != StatNoRoot {
		t.Fatalf("missing root = %s", code)
	}
}

func TestRenameOrMoveIsIdempotentAndNeverOverwrites(t *testing.T) {
	root := t.TempDir()
	if err := EnsureDir(root, "mod", "4.01确权线"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "mod", "4.01确权线", "notes.md"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := RenameOrMove(root, []string{"mod", "4.01确权线"}, root, []string{"mod", "4.01确权线"}); err != nil {
		t.Fatalf("same path: %v", err)
	}
	if err := RenameOrMove(root, []string{"mod", "4.01确权线"}, root, []string{"mod", "4.02确权线"}); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(filepath.Join(root, "mod", "4.02确权线", "notes.md")); err != nil || string(content) != "hello" {
		t.Fatalf("content did not move: %q %v", content, err)
	}

	if err := EnsureDir(root, "mod", "4.03占用"); err != nil {
		t.Fatal(err)
	}
	if err := RenameOrMove(root, []string{"mod", "4.02确权线"}, root, []string{"mod", "4.03占用"}); !errors.Is(err, ErrTargetExists) {
		t.Fatalf("collision = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "mod", "4.02确权线")); err != nil {
		t.Fatal("source disappeared on a refused move")
	}

	if err := RenameOrMove(root, []string{"mod", "gone"}, root, []string{"mod", "elsewhere"}); !errors.Is(err, ErrSourceMissing) {
		t.Fatalf("missing source = %v", err)
	}
}

func TestRenameOrMoveAcrossRootsCreatesParents(t *testing.T) {
	srcRoot, dstRoot := t.TempDir(), t.TempDir()
	if err := EnsureDir(srcRoot, "a", "leaf"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcRoot, "a", "leaf", "f.txt"), []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := RenameOrMove(srcRoot, []string{"a", "leaf"}, dstRoot, []string{"b", "c", "leaf"}); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(filepath.Join(dstRoot, "b", "c", "leaf", "f.txt")); err != nil || string(content) != "data" {
		t.Fatalf("moved file: %q %v", content, err)
	}
	if _, err := os.Stat(filepath.Join(srcRoot, "a", "leaf")); !os.IsNotExist(err) {
		t.Fatal("source left behind")
	}
}

// The cross-device branch cannot be provoked with a rename, so the copy it
// falls back to is exercised directly: symlinks are refused and nothing is
// written outside the destination.
func TestCopyTreeRefusesSymlinksAndCopiesRegularFiles(t *testing.T) {
	src, dst := t.TempDir(), filepath.Join(t.TempDir(), "copy")
	if err := EnsureDir(src, "sub"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "sub", "f.txt"), []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyTree(src, dst); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(filepath.Join(dst, "sub", "f.txt")); err != nil || string(content) != "payload" {
		t.Fatalf("copied file: %q %v", content, err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(src, "sub", "escape")); err != nil {
		t.Fatal(err)
	}
	blocked := filepath.Join(t.TempDir(), "blocked")
	if err := copyTree(src, blocked); !errors.Is(err, ErrDirectoryChanged) {
		t.Fatalf("symlink copy = %v", err)
	}
}

func TestOpenRootPinsTheFinalComponent(t *testing.T) {
	parent := t.TempDir()
	real := filepath.Join(parent, "real")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	aliasParent := t.TempDir()
	alias := filepath.Join(aliasParent, "alias")
	if err := os.Symlink(parent, alias); err != nil {
		t.Fatal(err)
	}
	root, err := OpenRoot(filepath.Join(alias, "real"))
	if err != nil {
		t.Fatalf("ancestor alias: %v", err)
	}
	root.Close()
	link := filepath.Join(aliasParent, "root-link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenRoot(link); !errors.Is(err, ErrRootUnavailable) {
		t.Fatalf("final root link = %v", err)
	}
}

func TestDeliveryPathComposesTheFixedSegments(t *testing.T) {
	collab := "/Volumes/share/项目"
	module, workItem, issue := "4.01确权线", "4.01.02接口", "FOS-12注册路径设计"
	ptr := func(s string) *string { return &s }

	path, err := DeliveryPath(collab, ptr(module), ptr(workItem), ptr(issue))
	if err != nil || path != filepath.Join(collab, module, workItem, issue) {
		t.Fatalf("four segments = %q %v", path, err)
	}
	path, err = DeliveryPath(collab, ptr(module), nil, ptr(issue))
	if err != nil || path != filepath.Join(collab, module, issue) {
		t.Fatalf("three segments = %q %v", path, err)
	}
	path, err = DeliveryPath(collab, nil, nil, ptr(issue))
	if err != nil || path != filepath.Join(collab, issue) {
		t.Fatalf("two segments = %q %v", path, err)
	}
	if path, err := DeliveryPath("", ptr(module), nil, ptr(issue)); err != nil || path != "" {
		t.Fatalf("no collab path = %q %v", path, err)
	}
	if path, err := DeliveryPath(collab, ptr(module), nil, nil); err != nil || path != "" {
		t.Fatalf("no issue folder = %q %v", path, err)
	}
	if _, err := DeliveryPath(collab, ptr("../escape"), nil, ptr(issue)); err == nil {
		t.Fatal("accepted an unsafe segment")
	}
}
