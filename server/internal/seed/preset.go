package seed

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

//go:embed preset.json
var presetJSON []byte

// PresetSkillImport is a skill sourced from a public repo URL; the server
// re-fetches its content at seed time via the same path /api/skills/import uses.
type PresetSkillImport struct {
	Name      string `json:"name"`
	SourceURL string `json:"source_url"`
}

// PresetSkillInline is a hand-authored skill carried verbatim in the bundle, so
// seeding never depends on any external host for our own material.
type PresetSkillInline struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Content     string            `json:"content"`
	Files       []PresetSkillFile `json:"files"`
}

type PresetSkillFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// PresetAgent is one agent in the bundle: identity + instructions + MCP servers
// + the skill names it binds. AvatarURL is a site-relative path served by the
// embedded avatar route (see avatars.go).
type PresetAgent struct {
	Name               string          `json:"name"`
	Description        string          `json:"description"`
	Instructions       string          `json:"instructions"`
	AvatarURL          string          `json:"avatar_url"`
	McpConfig          json.RawMessage `json:"mcp_config"`
	MaxConcurrentTasks int32           `json:"max_concurrent_tasks"`
	SkillNames         []string        `json:"skill_names"`
}

// PresetSquad organizes agents under a leader. LeaderName and every MemberNames
// entry must reference a PresetAgent.Name in the same bundle.
type PresetSquad struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	LeaderName  string   `json:"leader_name"`
	MemberNames []string `json:"member_names"`
}

// Preset is the complete default-workspace bundle: skills, agents, and squads.
// container_images is intentionally omitted — it is a host-level build-once step.
type Preset struct {
	Preset       string              `json:"preset"`
	Title        string              `json:"title"`
	Description  string              `json:"description"`
	SkillsImport []PresetSkillImport `json:"skills_import"`
	SkillsInline []PresetSkillInline `json:"skills_inline"`
	Agents       []PresetAgent       `json:"agents"`
	Squads       []PresetSquad       `json:"squads"`
}

// LoadPreset parses and validates the embedded default preset. A malformed or
// internally-inconsistent bundle is a build-time error, so callers should treat
// a non-nil error as fatal at startup.
func LoadPreset() (*Preset, error) {
	var p Preset
	if err := json.Unmarshal(presetJSON, &p); err != nil {
		return nil, fmt.Errorf("seed: parse preset.json: %w", err)
	}
	if err := validatePreset(&p); err != nil {
		return nil, fmt.Errorf("seed: preset.json: %w", err)
	}
	return &p, nil
}

// avatarSlugFromURL extracts "research-lead" from
// "/uploads/agent-avatars/research-lead.png". Returns "" if the URL is not an
// embedded-avatar reference (e.g. an external URL), which callers treat as
// "not our avatar, skip the existence check".
func avatarSlugFromURL(url string) string {
	if !strings.HasPrefix(url, AvatarRoutePrefix) {
		return ""
	}
	return strings.TrimSuffix(strings.TrimPrefix(url, AvatarRoutePrefix), ".png")
}

func validatePreset(p *Preset) error {
	if len(p.Agents) == 0 {
		return fmt.Errorf("no agents")
	}
	names := make(map[string]bool, len(p.Agents))
	skillNames := make(map[string]bool)
	for _, s := range p.SkillsInline {
		skillNames[s.Name] = true
	}
	for _, s := range p.SkillsImport {
		skillNames[s.Name] = true
	}
	for i := range p.Agents {
		a := &p.Agents[i]
		if strings.TrimSpace(a.Name) == "" {
			return fmt.Errorf("agent %d: missing name", i)
		}
		if names[a.Name] {
			return fmt.Errorf("duplicate agent name %q", a.Name)
		}
		names[a.Name] = true
		if slug := avatarSlugFromURL(a.AvatarURL); slug != "" && !HasAvatar(slug) {
			return fmt.Errorf("agent %q: avatar %q has no embedded asset", a.Name, slug)
		}
		if len(a.McpConfig) > 0 && !json.Valid(a.McpConfig) {
			return fmt.Errorf("agent %q: invalid mcp_config json", a.Name)
		}
		for _, sn := range a.SkillNames {
			if !skillNames[sn] {
				return fmt.Errorf("agent %q: skill %q is not declared in skills_inline/skills_import", a.Name, sn)
			}
		}
	}
	squadNames := make(map[string]bool, len(p.Squads))
	for i := range p.Squads {
		s := &p.Squads[i]
		if strings.TrimSpace(s.Name) == "" {
			return fmt.Errorf("squad %d: missing name", i)
		}
		if squadNames[s.Name] {
			return fmt.Errorf("duplicate squad name %q", s.Name)
		}
		squadNames[s.Name] = true
		if !names[s.LeaderName] {
			return fmt.Errorf("squad %q: leader %q is not an agent in this preset", s.Name, s.LeaderName)
		}
		for _, m := range s.MemberNames {
			if !names[m] {
				return fmt.Errorf("squad %q: member %q is not an agent in this preset", s.Name, m)
			}
		}
	}
	return nil
}
