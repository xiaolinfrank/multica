package seed

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// repoPresetDir is the deployment preset directory checked into the repository
// root, used here as the end-to-end fixture: it is the one preset we ship an
// example of, and it must stay loadable.
const repoPresetDir = "../../../presets"

func TestLoadPresetFromDeploymentDir(t *testing.T) {
	p, err := LoadPreset("bayclaw-biopharma", repoPresetDir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(p.Agents) == 0 {
		t.Fatal("no agents")
	}
	declared := map[string]bool{}
	for _, s := range p.SkillsInline {
		declared[s.Name] = true
	}
	for _, s := range p.SkillsImport {
		declared[s.Name] = true
	}
	for _, a := range p.Agents {
		if a.Instructions == "" {
			t.Errorf("agent %q: empty instructions", a.Name)
		}
		if slug := avatarSlugFromURL(a.AvatarURL); slug == "" || !HasAvatar(slug) {
			t.Errorf("agent %q: avatar %q not embedded", a.Name, a.AvatarURL)
		}
		if len(a.McpConfig) > 0 && !json.Valid(a.McpConfig) {
			t.Errorf("agent %q: invalid mcp_config", a.Name)
		}
		for _, sn := range a.SkillNames {
			if !declared[sn] {
				t.Errorf("agent %q: skill %q not declared", a.Name, sn)
			}
		}
	}
	for _, sq := range p.Squads {
		found := false
		for _, a := range p.Agents {
			if a.Name == sq.LeaderName {
				found = true
			}
		}
		if !found {
			t.Errorf("squad %q: leader %q not an agent", sq.Name, sq.LeaderName)
		}
	}
}

// The generic product ships no template: seeding is opt-in and everything is
// resolved at run time, so the binary must not carry a default roster.
func TestNoEmbeddedPresets(t *testing.T) {
	if got := AvailableTemplates(""); len(got) != 0 {
		t.Fatalf("binary ships templates %v, want none", got)
	}
}

func TestLoadPresetMissingTemplate(t *testing.T) {
	dir := t.TempDir()
	_, err := LoadPreset("does-not-exist", dir)
	if err == nil {
		t.Fatal("expected error")
	}
	msg := err.Error()
	if !strings.Contains(msg, filepath.Join(dir, "does-not-exist.json")) {
		t.Errorf("error should name the path it tried, got %q", msg)
	}
	if !strings.Contains(msg, "embedded") {
		t.Errorf("error should mention the embedded fallback, got %q", msg)
	}
}

func TestLoadPresetRejectsBadName(t *testing.T) {
	for _, name := range []string{"../etc/passwd", "Upper", "with space", "", "trailing/"} {
		if _, err := LoadPreset(name, t.TempDir()); err == nil {
			t.Errorf("name %q: expected rejection", name)
		}
	}
}

func TestLoadPresetPrefersDeploymentDir(t *testing.T) {
	dir := t.TempDir()
	data, err := json.Marshal(&Preset{Preset: "local", Agents: []PresetAgent{{
		Name:         "A",
		Instructions: "x",
		AvatarURL:    "https://example.test/a.png",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "team.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	p, err := LoadPreset("team", dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if p.Preset != "local" {
		t.Fatalf("preset = %q, want the deployment file to win", p.Preset)
	}
}

func TestAvailableTemplatesListsDir(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"alpha.json", "beta.json"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "notes.md"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub.json"), 0o700); err != nil {
		t.Fatal(err)
	}
	got := AvailableTemplates(dir)
	want := []string{"alpha", "beta"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("AvailableTemplates = %v, want %v", got, want)
	}
}

func TestParsePresetRejectsMalformed(t *testing.T) {
	if _, err := ParsePreset([]byte("{not json")); err == nil {
		t.Fatal("expected parse error")
	}
	// Unknown fields are a typo in a deployment file; fail loudly instead of
	// silently dropping what the author meant to configure.
	unknown := []byte(`{"preset":"x","agents":[{"name":"A"}],"squads_extra":[]}`)
	if _, err := ParsePreset(unknown); err == nil {
		t.Fatal("expected unknown-field error")
	}
}

func TestValidatePresetRejects(t *testing.T) {
	cases := map[string]*Preset{
		"no agents":        {},
		"missing name":     {Agents: []PresetAgent{{AvatarURL: AvatarRoutePrefix + "research-lead.png"}}},
		"unknown avatar":   {Agents: []PresetAgent{{Name: "a", AvatarURL: AvatarRoutePrefix + "ghost.png"}}},
		"missing avatar":   {Agents: []PresetAgent{{Name: "a"}}},
		"bad avatar ref":   {Agents: []PresetAgent{{Name: "a", AvatarURL: "avatars/a.png"}}},
		"dup agent":        {Agents: []PresetAgent{{Name: "a"}, {Name: "a"}}},
		"bad mcp":          {Agents: []PresetAgent{{Name: "a", McpConfig: json.RawMessage("{not json")}}},
		"undeclared skill": {Agents: []PresetAgent{{Name: "a", SkillNames: []string{"ghost"}}}},
		"leader not agent": {Agents: []PresetAgent{{Name: "a"}},
			Squads: []PresetSquad{{Name: "s", LeaderName: "ghost"}}},
		"member not agent": {Agents: []PresetAgent{{Name: "a"}},
			Squads: []PresetSquad{{Name: "s", LeaderName: "a", MemberNames: []string{"ghost"}}}},
	}
	for name, p := range cases {
		if err := validatePreset(p); err == nil {
			t.Errorf("%s: expected validation error, got nil", name)
		}
	}
}

func TestValidatePresetAcceptsDeploymentAvatarURLs(t *testing.T) {
	p := &Preset{Agents: []PresetAgent{
		{Name: "embedded", AvatarURL: AvatarRoutePrefix + "research-lead.png"},
		{Name: "remote", AvatarURL: "https://cdn.example.test/a.png"},
		{Name: "relative", AvatarURL: "/uploads/own/a.png"},
	}}
	if err := validatePreset(p); err != nil {
		t.Fatalf("validate: %v", err)
	}
}

func TestAvatarURLFor(t *testing.T) {
	if got, want := AvatarURLFor("research-lead"), "/uploads/agent-avatars/research-lead.png"; got != want {
		t.Errorf("AvatarURLFor = %q, want %q", got, want)
	}
}

func TestServeAvatar(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, AvatarRoutePrefix+"research-lead.png", nil)
	rec := httptest.NewRecorder()
	ServeAvatar(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("known avatar: code=%d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/png" {
		t.Errorf("content-type=%q, want image/png", ct)
	}
	if rec.Body.Len() == 0 {
		t.Error("known avatar: empty body")
	}

	for _, p := range []string{"nope.png", "research-lead.txt", "sub/dir.png", "..%2Fpreset.go"} {
		req := httptest.NewRequest(http.MethodGet, AvatarRoutePrefix+p, nil)
		rec := httptest.NewRecorder()
		ServeAvatar(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("path %q: code=%d, want 404", p, rec.Code)
		}
	}
}
