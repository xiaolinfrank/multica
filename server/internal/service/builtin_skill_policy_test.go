package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"slices"
	"testing"
)

func TestBuiltinPolicySeparatesOwnerWorkerAndMika(t *testing.T) {
	// Derived from the policy rather than hard-coded: adding a universal skill
	// must not require editing this test, but the two load-bearing invariants
	// below must survive every addition.
	all := make([]string, 0, len(builtinPolicy.Skills))
	universal := make([]string, 0, len(builtinPolicy.Skills))
	var mikaOnly []string
	for _, entry := range builtinPolicy.Skills {
		all = append(all, entry.Name)
		if slices.Contains(entry.Roles, "mika") && len(entry.Roles) == 1 {
			mikaOnly = append(mikaOnly, entry.Name)
			continue
		}
		universal = append(universal, entry.Name)
	}

	for _, role := range []string{"owner", "worker"} {
		if got := BuiltinSkillNamesForRole(role); !reflect.DeepEqual(got, universal) {
			t.Fatalf("%s gets %v, want %v", role, got, universal)
		}
	}
	if got := BuiltinSkillNamesForRole("mika"); !reflect.DeepEqual(got, all) {
		t.Fatalf("Mika gets %v, want %v", got, all)
	}

	// Invariant 1: every built-in carries the platform contract. A new skill
	// that forgets to include multica-platform in its own role would leave
	// agents without the API contracts the rest of the listing assumes.
	for _, name := range []string{"multica-platform", "multica-cockpit"} {
		if !slices.Contains(universal, name) {
			t.Fatalf("%s must reach every role, policy says %v", name, universal)
		}
	}
	// Invariant 2: only the product-authored kickoff is Mika-exclusive.
	if !reflect.DeepEqual(mikaOnly, []string{"multica-onboarding"}) {
		t.Fatalf("Mika-only skills = %v, want only the onboarding kickoff", mikaOnly)
	}

	if len(BuiltinSkillNamesForRole("untrusted-role")) != 0 {
		t.Fatal("unknown role received skills")
	}
	for _, key := range []string{"", "owner", "renamed-Mika"} {
		if got := len(loadBuiltinSkills(key)); got != len(universal) {
			t.Fatalf("ordinary system key %q received %d skills, want %d", key, got, len(universal))
		}
	}
	if got := len(loadBuiltinSkills(MikaSystemKey)); got != len(all) {
		t.Fatalf("native Mika received %d skills, want its declared scope of %d", got, len(all))
	}
}

func TestBuiltinArtifactHashesActualEmbeddedFiles(t *testing.T) {
	revision := "0123456789012345678901234567890123456789"
	artifact, err := BuiltinSkillsArtifact(revision)
	if err != nil || artifact.Commit != revision || artifact.Format != "multica-builtin-artifact-v1" {
		t.Fatalf("artifact identity: %+v %v", artifact, err)
	}
	policy, _ := builtinSkillsFS.ReadFile(builtinSkillsRoot + "/policy.json")
	sum := sha256.Sum256(policy)
	if artifact.PolicySHA256 != hex.EncodeToString(sum[:]) {
		t.Fatal("policy hash differs")
	}
	all := loadBuiltinSkillDirs(func(string) bool { return true })
	for _, skill := range all {
		var files map[string]string
		for _, entry := range artifact.Skills {
			if entry.Name == skill.Name {
				files = entry.Files
			}
		}
		payload := map[string]string{"SKILL.md": skill.Content}
		for _, file := range skill.Files {
			payload[file.Path] = file.Content
		}
		if len(payload) != len(files) {
			t.Fatalf("inventory differs for %s", skill.Name)
		}
		for path, body := range payload {
			sum := sha256.Sum256([]byte(body))
			if files[path] != hex.EncodeToString(sum[:]) {
				t.Fatalf("embedded hash differs for %s/%s", skill.Name, path)
			}
		}
	}
}

func TestBuiltinPolicyRejectsAmbiguousScopes(t *testing.T) {
	base, _ := builtinSkillsFS.ReadFile(builtinSkillsRoot + "/policy.json")
	for _, change := range []func(*BuiltinSkillPolicy){
		func(p *BuiltinSkillPolicy) { p.Skills[0].Roles = []string{"root"} },
		func(p *BuiltinSkillPolicy) { p.Skills[0].Roles = []string{"owner", "owner"} },
		func(p *BuiltinSkillPolicy) { p.Skills[1].Name = p.Skills[0].Name },
		func(p *BuiltinSkillPolicy) { p.Skills[2].Roles = []string{"owner", "mika"} },
		func(p *BuiltinSkillPolicy) { p.Skills[0].Activation = "always-write-memory" },
	} {
		var policy BuiltinSkillPolicy
		_ = json.Unmarshal(base, &policy)
		change(&policy)
		data, _ := json.Marshal(policy)
		if _, err := parseBuiltinSkillPolicy(data); err == nil {
			t.Fatal("ambiguous policy accepted")
		}
	}
	if _, err := parseBuiltinSkillPolicy(append(base, []byte("{}")...)); err == nil {
		t.Fatal("trailing object accepted")
	}
}
