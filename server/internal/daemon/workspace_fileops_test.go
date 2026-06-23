package daemon

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// envRootFixture builds {root}/{wsID}/{taskShort}/ with a realistic layout:
// an agent file at the top, a git checkout, and a node_modules artifact dir.
func envRootFixture(t *testing.T) (root, wsID, taskShort, envRoot string) {
	t.Helper()
	root = t.TempDir()
	wsID = "11111111-2222-3333-4444-555555555555"
	taskShort = "abcd1234"
	envRoot = filepath.Join(root, wsID, taskShort)
	mustMkdir(t, filepath.Join(envRoot, "workdir"))
	mustWrite(t, filepath.Join(envRoot, "workdir", "report.md"), "# deliverable\nhello")
	mustWrite(t, filepath.Join(envRoot, "workdir", "data.json"), `{"k":1}`)

	// A git checkout: a dir holding a .git entry plus working-tree files.
	repo := filepath.Join(envRoot, "workdir", "myrepo")
	mustMkdir(t, filepath.Join(repo, ".git"))
	mustWrite(t, filepath.Join(repo, ".git", "HEAD"), "ref: refs/heads/main")
	mustWrite(t, filepath.Join(repo, "main.go"), "package main")
	mustMkdir(t, filepath.Join(repo, "node_modules", "left-pad"))
	mustWrite(t, filepath.Join(repo, "node_modules", "left-pad", "index.js"), "module.exports={}")

	// A standalone artifact dir outside any checkout.
	mustMkdir(t, filepath.Join(envRoot, "workdir", "node_modules", "dep"))
	mustWrite(t, filepath.Join(envRoot, "workdir", "node_modules", "dep", "x.js"), "x")
	return
}

func mustMkdir(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(p, 0o755); err != nil {
		t.Fatal(err)
	}
}

func mustWrite(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestResolveEnvRootSandboxed(t *testing.T) {
	root, wsID, taskShort, envRoot := envRootFixture(t)

	got, err := resolveEnvRootSandboxed(root, wsID, taskShort)
	if err != nil {
		t.Fatalf("valid envRoot rejected: %v", err)
	}
	if got != envRoot {
		t.Fatalf("got %q want %q", got, envRoot)
	}

	// Path traversal in either component must be refused, never resolved.
	for _, tc := range []struct{ ws, task string }{
		{"../../etc", taskShort},
		{wsID, ".."},
		{wsID, "../" + taskShort},
		{"", taskShort},
		{wsID, ""},
		{wsID, "a/b"},
	} {
		if _, err := resolveEnvRootSandboxed(root, tc.ws, tc.task); err == nil {
			t.Fatalf("expected rejection for ws=%q task=%q", tc.ws, tc.task)
		}
	}

	// Missing dir is an error, not a path.
	if _, err := resolveEnvRootSandboxed(root, wsID, "deadbeef"); err == nil {
		t.Fatal("expected error for missing workspace dir")
	}
}

func TestWorkspaceTree_CollapsesReposAndArtifacts(t *testing.T) {
	_, _, _, envRoot := envRootFixture(t)
	res, err := workspaceTree(envRoot, buildPatternSet([]string{"node_modules"}))
	if err != nil {
		t.Fatal(err)
	}

	byPath := map[string]wsFileEntry{}
	for _, e := range res.Entries {
		byPath[e.Path] = e
	}

	// Agent files are listed.
	if e, ok := byPath["workdir/report.md"]; !ok || e.IsDir {
		t.Fatalf("report.md missing or marked dir: %+v", e)
	}
	// The git checkout is one collapsed "repo" node — its inner files are NOT
	// listed individually.
	repo, ok := byPath["workdir/myrepo"]
	if !ok || !repo.IsDir || repo.Kind != "repo" {
		t.Fatalf("myrepo not collapsed as repo: %+v", repo)
	}
	if _, leaked := byPath["workdir/myrepo/main.go"]; leaked {
		t.Fatal("repo checkout was expanded into the tree")
	}
	// The standalone node_modules is a collapsed "artifact" node.
	art, ok := byPath["workdir/node_modules"]
	if !ok || art.Kind != "artifact" {
		t.Fatalf("node_modules not collapsed as artifact: %+v", art)
	}
	if _, leaked := byPath["workdir/node_modules/dep/x.js"]; leaked {
		t.Fatal("artifact dir was expanded into the tree")
	}
	// .git is never surfaced.
	for p := range byPath {
		if strings.Contains(p, ".git") {
			t.Fatalf("git metadata leaked into tree: %s", p)
		}
	}
}

func TestReadWorkspaceFile_TextAndSandbox(t *testing.T) {
	_, _, _, envRoot := envRootFixture(t)

	// Happy path: text file comes back with content.
	res, err := readWorkspaceFile(envRoot, "workdir/report.md")
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsText || !strings.Contains(res.Content, "deliverable") {
		t.Fatalf("text read wrong: %+v", res)
	}

	// Traversal is refused.
	for _, bad := range []string{"../../../etc/passwd", "workdir/../../escape", "/etc/passwd"} {
		if _, err := readWorkspaceFile(envRoot, bad); err == nil {
			t.Fatalf("expected rejection reading %q", bad)
		}
	}

	// A symlink planted inside the workspace that points outside must not be
	// followed — this is the load-bearing guard.
	secret := filepath.Join(t.TempDir(), "secret.txt")
	mustWrite(t, secret, "TOP SECRET")
	link := filepath.Join(envRoot, "workdir", "escape.txt")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if _, err := readWorkspaceFile(envRoot, "workdir/escape.txt"); err == nil {
		t.Fatal("symlink escaping the workspace was read")
	}
}

func TestReadWorkspaceFile_SymlinkDirEscape(t *testing.T) {
	_, _, _, envRoot := envRootFixture(t)

	// A secret outside the workspace, reachable only by escaping it.
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "secret.txt"), "TOP SECRET")

	// Plant a symlinked *directory* inside the workspace pointing outside. This
	// is the harder escape (and the TOCTOU-class case): os.Root must refuse to
	// traverse a component whose symlink target leaves the root.
	link := filepath.Join(envRoot, "workdir", "out")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if _, err := readWorkspaceFile(envRoot, "workdir/out/secret.txt"); err == nil {
		t.Fatal("read escaped the workspace through a symlinked directory")
	}
}

func TestReadWorkspaceFile_BinaryAndTruncation(t *testing.T) {
	_, _, _, envRoot := envRootFixture(t)

	// Binary file: NUL byte -> IsText false, no content.
	mustWrite(t, filepath.Join(envRoot, "workdir", "bin.dat"), "ab\x00cd")
	res, err := readWorkspaceFile(envRoot, "workdir/bin.dat")
	if err != nil {
		t.Fatal(err)
	}
	if res.IsText || res.Content != "" {
		t.Fatalf("binary detected as text: %+v", res)
	}

	// Oversized file is capped + flagged truncated.
	big := strings.Repeat("x", workspaceOpMaxReadBytes+1024)
	mustWrite(t, filepath.Join(envRoot, "workdir", "big.txt"), big)
	res, err = readWorkspaceFile(envRoot, "workdir/big.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !res.Truncated || len(res.Content) != workspaceOpMaxReadBytes {
		t.Fatalf("expected truncation to cap, got truncated=%v len=%d", res.Truncated, len(res.Content))
	}
}

func TestDownloadWorkspaceFile(t *testing.T) {
	_, _, _, envRoot := envRootFixture(t)

	// Text file: round-trips through base64 with a text MIME and IsImage=false.
	res, err := downloadWorkspaceFile(envRoot, "workdir/report.md")
	if err != nil {
		t.Fatal(err)
	}
	if res.Encoding != "base64" || res.TooLarge || res.IsImage {
		t.Fatalf("unexpected text download flags: %+v", res)
	}
	decoded, err := base64.StdEncoding.DecodeString(res.Content)
	if err != nil || string(decoded) != "# deliverable\nhello" {
		t.Fatalf("base64 round-trip wrong: decoded=%q err=%v", decoded, err)
	}

	// PNG: the 8-byte signature is enough for http.DetectContentType to type it
	// as image/png, so IsImage is set and the UI can render it inline.
	png := []byte("\x89PNG\r\n\x1a\nrest-of-file")
	mustWrite(t, filepath.Join(envRoot, "output", "chart.png"), string(png))
	res, err = downloadWorkspaceFile(envRoot, "output/chart.png")
	if err != nil {
		t.Fatal(err)
	}
	if res.Mime != "image/png" || !res.IsImage {
		t.Fatalf("png not detected as image: %+v", res)
	}

	// SVG sniffs as text/xml; the extension override must still mark it an image.
	mustWrite(t, filepath.Join(envRoot, "output", "plot.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>")
	res, err = downloadWorkspaceFile(envRoot, "output/plot.svg")
	if err != nil {
		t.Fatal(err)
	}
	if res.Mime != "image/svg+xml" || !res.IsImage {
		t.Fatalf("svg not marked image: %+v", res)
	}

	// Oversized: refused with TooLarge and no content (a partial binary is junk).
	big := strings.Repeat("x", workspaceOpMaxDownloadBytes+1)
	mustWrite(t, filepath.Join(envRoot, "output", "huge.bin"), big)
	res, err = downloadWorkspaceFile(envRoot, "output/huge.bin")
	if err != nil {
		t.Fatal(err)
	}
	if !res.TooLarge || res.Content != "" {
		t.Fatalf("oversized file not refused: too_large=%v len=%d", res.TooLarge, len(res.Content))
	}

	// Sandbox: traversal and a missing file are both errors, never reads.
	for _, bad := range []string{"../../../etc/passwd", "/etc/passwd", "workdir/nope.txt"} {
		if _, err := downloadWorkspaceFile(envRoot, bad); err == nil {
			t.Fatalf("expected rejection downloading %q", bad)
		}
	}

	// A symlinked directory escaping the workspace must not be traversed.
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "secret.txt"), "TOP SECRET")
	if err := os.Symlink(outside, filepath.Join(envRoot, "workdir", "out")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}
	if _, err := downloadWorkspaceFile(envRoot, "workdir/out/secret.txt"); err == nil {
		t.Fatal("download escaped the workspace through a symlinked directory")
	}
}

func TestReclaimWorkspace_ArtifactsKeepsAgentFiles(t *testing.T) {
	_, _, _, envRoot := envRootFixture(t)
	res, err := reclaimWorkspace(envRoot, "artifacts", buildPatternSet([]string{"node_modules"}))
	if err != nil {
		t.Fatal(err)
	}
	if res.ReclaimedBytes <= 0 || len(res.Removed) == 0 {
		t.Fatalf("nothing reclaimed: %+v", res)
	}
	// Regenerable subtrees gone.
	if _, err := os.Stat(filepath.Join(envRoot, "workdir", "myrepo")); !os.IsNotExist(err) {
		t.Fatal("repo checkout should have been reclaimed")
	}
	if _, err := os.Stat(filepath.Join(envRoot, "workdir", "node_modules")); !os.IsNotExist(err) {
		t.Fatal("standalone node_modules should have been reclaimed")
	}
	// Agent's own files preserved.
	if _, err := os.Stat(filepath.Join(envRoot, "workdir", "report.md")); err != nil {
		t.Fatalf("agent file was destroyed: %v", err)
	}
}

func TestReclaimWorkspace_FullRemovesEverything(t *testing.T) {
	_, _, _, envRoot := envRootFixture(t)
	res, err := reclaimWorkspace(envRoot, "full", buildPatternSet([]string{"node_modules"}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Mode != "full" || res.ReclaimedBytes <= 0 {
		t.Fatalf("unexpected full reclaim result: %+v", res)
	}
	if _, err := os.Stat(envRoot); !os.IsNotExist(err) {
		t.Fatal("full reclaim should have removed the envRoot")
	}
}
