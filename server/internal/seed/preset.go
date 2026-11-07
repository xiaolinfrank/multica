package seed

import (
	"bytes"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// A preset is an optional curated workspace bundle — agents, squads, and the
// skills they bind — materialized into a workspace the first time it brings a
// runtime online.
//
// Presets are deployment assets, not product defaults: the generic product
// ships none, so a fresh install starts with an empty roster and whatever the
// owner creates. A deployment opts in by setting
// DEFAULT_WORKSPACE_SEED_TEMPLATE to a preset name and WORKSPACE_SEED_DIR to
// the directory that holds <name>.json (default: ./presets).
//
// The embedded templates/ directory is a fallback for builds that want a
// bundle pinned into the binary; it ships documentation only, so no
// deployment-specific content ends up in a generic binary.
//
//go:embed all:templates
var templatesFS embed.FS

const (
	templatesRoot = "templates"
	presetSuffix  = ".json"

	// DefaultPresetDir is where a preset name resolves when WORKSPACE_SEED_DIR
	// is unset: a `presets` directory relative to the server's working
	// directory.
	DefaultPresetDir = "presets"
)

// presetNamePattern keeps a template name usable as a file name: lowercase
// letters, digits and dashes. This is what makes path traversal impossible
// without a separate sanitizer.
var presetNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)

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
// + the skill names it binds. AvatarURL is either a site-relative path served
// by the embedded avatar route (see avatars.go) or an absolute http(s) URL the
// deployment hosts itself.
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

// Preset is the complete workspace bundle for one template: skills, agents,
// and squads.
//
// ContainerImages is carried verbatim and deliberately not interpreted: it
// documents the host-level images a bundle's skills expect, which are built
// once per host by an operator, not by the seeder. Keeping the field typed
// means a preset file round-trips through the strict decoder instead of having
// to strip it first.
type Preset struct {
	Preset          string              `json:"preset"`
	Title           string              `json:"title"`
	Description     string              `json:"description"`
	ContainerImages json.RawMessage     `json:"container_images,omitempty"`
	SkillsImport    []PresetSkillImport `json:"skills_import"`
	SkillsInline    []PresetSkillInline `json:"skills_inline"`
	Agents          []PresetAgent       `json:"agents"`
	Squads          []PresetSquad       `json:"squads"`
}

// presetSource is one place a named template may live.
type presetSource struct {
	label string
	read  func() ([]byte, error)
}

// presetSources lists the lookup order for a template: the deployment's own
// directory first (so a deployment can override a pinned template without a
// rebuild), then the embedded fallback.
func presetSources(name, dir string) []presetSource {
	sources := make([]presetSource, 0, 2)
	if strings.TrimSpace(dir) != "" {
		path := filepath.Join(dir, name+presetSuffix)
		sources = append(sources, presetSource{
			label: path,
			read:  func() ([]byte, error) { return os.ReadFile(path) },
		})
	}
	embedded := templatesRoot + "/" + name + presetSuffix
	sources = append(sources, presetSource{
		label: "embedded " + embedded,
		read:  func() ([]byte, error) { return templatesFS.ReadFile(embedded) },
	})
	return sources
}

// LoadPreset resolves a named template and validates it. A malformed bundle is
// a deployment error, so callers treat a non-nil error as "do not seed" and log
// it; a bad preset must never take the server down.
func LoadPreset(name, dir string) (*Preset, error) {
	clean := strings.TrimSpace(name)
	if !presetNamePattern.MatchString(clean) {
		return nil, fmt.Errorf("seed: invalid template name %q (want lowercase letters, digits and dashes)", name)
	}
	sources := presetSources(clean, dir)
	looked := make([]string, 0, len(sources))
	for _, source := range sources {
		looked = append(looked, source.label)
		data, err := source.read()
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return nil, fmt.Errorf("seed: read template %q from %s: %w", clean, source.label, err)
		}
		p, err := ParsePreset(data)
		if err != nil {
			return nil, fmt.Errorf("seed: template %q (%s): %w", clean, source.label, err)
		}
		return p, nil
	}
	return nil, fmt.Errorf("seed: template %q not found; looked in %s", clean, strings.Join(looked, ", "))
}

// ParsePreset parses and validates a bundle from bytes. Exported so a test or a
// deployment tool can check a preset without starting a server.
func ParsePreset(data []byte) (*Preset, error) {
	var p Preset
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&p); err != nil {
		return nil, fmt.Errorf("parse preset json: %w", err)
	}
	if err := validatePreset(&p); err != nil {
		return nil, err
	}
	return &p, nil
}

// AvailableTemplates lists the template names reachable from dir plus the ones
// pinned into this binary, sorted. Used for operator-facing log lines.
func AvailableTemplates(dir string) []string {
	seen := map[string]bool{}
	var names []string
	add := func(name string) {
		if name == "" || seen[name] || !presetNamePattern.MatchString(name) {
			return
		}
		seen[name] = true
		names = append(names, name)
	}
	if strings.TrimSpace(dir) != "" {
		if entries, err := os.ReadDir(dir); err == nil {
			for _, entry := range entries {
				if entry.IsDir() || !strings.HasSuffix(entry.Name(), presetSuffix) {
					continue
				}
				add(strings.TrimSuffix(entry.Name(), presetSuffix))
			}
		}
	}
	if entries, err := fs.ReadDir(templatesFS, templatesRoot); err == nil {
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), presetSuffix) {
				continue
			}
			add(strings.TrimSuffix(entry.Name(), presetSuffix))
		}
	}
	sort.Strings(names)
	return names
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
		if err := validateAvatarRef(a); err != nil {
			return err
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

// validateAvatarRef accepts an embedded avatar reference (which must exist), a
// site-relative path, or an absolute http(s) URL the deployment hosts itself.
// Anything else — including an empty value — is a typo worth failing on.
func validateAvatarRef(a *PresetAgent) error {
	url := strings.TrimSpace(a.AvatarURL)
	if url == "" {
		return fmt.Errorf("agent %q: missing avatar_url", a.Name)
	}
	if slug := avatarSlugFromURL(url); slug != "" {
		if !HasAvatar(slug) {
			return fmt.Errorf("agent %q: avatar %q has no embedded asset", a.Name, slug)
		}
		return nil
	}
	if strings.HasPrefix(url, "https://") || strings.HasPrefix(url, "http://") || strings.HasPrefix(url, "/") {
		return nil
	}
	return fmt.Errorf("agent %q: avatar_url %q is neither an embedded avatar, a site-relative path, nor an http(s) URL", a.Name, url)
}
