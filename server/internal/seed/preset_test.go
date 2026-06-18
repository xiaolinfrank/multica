package seed

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLoadPreset(t *testing.T) {
	p, err := LoadPreset()
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

func TestValidatePresetRejects(t *testing.T) {
	cases := map[string]*Preset{
		"no agents":        {},
		"missing name":     {Agents: []PresetAgent{{AvatarURL: AvatarRoutePrefix + "research-lead.png"}}},
		"unknown avatar":   {Agents: []PresetAgent{{Name: "a", AvatarURL: AvatarRoutePrefix + "ghost.png"}}},
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
