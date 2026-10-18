package storage

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalStoragePrivateNamespacesRejectAnonymousAliases(t *testing.T) {
	for _, namespace := range []string{"artifact-versions", "input-versions"} {
		t.Run(namespace, func(t *testing.T) { assertPrivateNamespace(t, namespace) })
	}
}

func assertPrivateNamespace(t *testing.T, namespace string) {
	t.Helper()
	root := t.TempDir()
	store := &LocalStorage{uploadDir: root}
	key := "workspaces/owned-workspace/" + namespace + "/version/attempt.txt"
	if _, err := store.Upload(context.Background(), key, []byte("private fixed bytes"), "text/plain", "evidence.txt"); err != nil {
		t.Fatal(err)
	}
	for name, filename := range map[string]string{
		"exact":                       key,
		"case insensitive filesystem": "WORKSPACES/owned-workspace/" + strings.ToUpper(namespace) + "/version/attempt.txt",
		"cleaned":                     "public/../" + key,
		"encoded":                     "workspaces%2Fowned-workspace%2F" + namespace + "%2Fversion%2Fattempt.txt",
		"double encoded":              "workspaces%252Fowned-workspace%252F" + namespace + "%252Fversion%252Fattempt.txt",
		"directory":                   "workspaces/owned-workspace/" + namespace,
		"ancestor listing":            "workspaces/owned-workspace",
	} {
		t.Run(name, func(t *testing.T) {
			r := httptest.NewRecorder()
			store.ServeFile(r, httptest.NewRequest(http.MethodGet, "/uploads/object", nil), filename)
			if r.Code != http.StatusNotFound {
				t.Fatalf("anonymous read = %d: %q", r.Code, r.Body.String())
			}
		})
	}
	for name, target := range map[string]string{"file-alias.txt": key, "dir-alias": "workspaces/owned-workspace/" + namespace} {
		if err := os.Symlink(filepath.Join(root, target), filepath.Join(root, name)); err != nil {
			t.Fatal(err)
		}
		filename := name
		if name == "dir-alias" {
			filename += "/version/attempt.txt"
		}
		r := httptest.NewRecorder()
		store.ServeFile(r, httptest.NewRequest(http.MethodGet, "/uploads/"+filename, nil), filename)
		if r.Code != http.StatusNotFound {
			t.Fatalf("symlink anonymous read = %d: %q", r.Code, r.Body.String())
		}
	}
	reader, err := store.GetReader(context.Background(), key)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil || string(body) != "private fixed bytes" {
		t.Fatalf("authorized storage read = %q, %v", body, err)
	}
	if _, err := store.Upload(context.Background(), "workspaces/owned-workspace/attachment.txt", []byte("ordinary attachment"), "text/plain", "notes.txt"); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRecorder()
	store.ServeFile(r, httptest.NewRequest(http.MethodGet, "/uploads/attachment.txt", nil), "workspaces/owned-workspace/attachment.txt")
	if r.Code != http.StatusOK || r.Body.String() != "ordinary attachment" {
		t.Fatalf("ordinary attachment changed: %d %q", r.Code, r.Body.String())
	}
}

func TestArtifactStorageRequiresAnExplicitPrivateProvider(t *testing.T) {
	if SupportsPrivateArtifactFiles(nil) || SupportsPrivateArtifactFiles(struct{}{}) || SupportsPrivateArtifactFiles(&S3Storage{}) {
		t.Fatal("unconfirmed cloud or unknown provider claimed private artifact storage")
	}
	if !SupportsPrivateArtifactFiles(&LocalStorage{uploadDir: t.TempDir()}) {
		t.Fatal("protected local provider unavailable")
	}
}

func TestInputStorageRequiresAnIndependentPrivateProvider(t *testing.T) {
	if SupportsPrivateInputFiles(nil) || SupportsPrivateInputFiles(struct{}{}) || SupportsPrivateInputFiles(&S3Storage{}) || SupportsPrivateInputFiles(artifactOnlyProvider{}) {
		t.Fatal("unconfirmed provider claimed private input storage")
	}
	if !SupportsPrivateInputFiles(&LocalStorage{uploadDir: t.TempDir()}) {
		t.Fatal("protected input namespace unavailable")
	}
}

type artifactOnlyProvider struct{}

func (artifactOnlyProvider) SupportsPrivateArtifactFiles() bool { return true }
