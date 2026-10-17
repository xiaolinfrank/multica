package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"reflect"
	"testing"
)

func TestBuiltinPolicySeparatesOwnerWorkerAndMika(t *testing.T) {
	for _, role := range []string{"owner", "worker"} {
		if got := BuiltinSkillNamesForRole(role); !reflect.DeepEqual(got, []string{"multica-platform", "multica-cockpit"}) {
			t.Fatalf("%s gets %v", role, got)
		}
	}
	if got := BuiltinSkillNamesForRole("mika"); !reflect.DeepEqual(got, []string{"multica-platform", "multica-cockpit", "multica-onboarding"}) {
		t.Fatalf("Mika gets %v", got)
	}
	if len(BuiltinSkillNamesForRole("untrusted-role")) != 0 {
		t.Fatal("unknown role received skills")
	}
	for _, key := range []string{"", "owner", "renamed-Mika"} {
		if len(loadBuiltinSkills(key)) != 2 {
			t.Fatalf("ordinary system key %q received Mika content", key)
		}
	}
	if len(loadBuiltinSkills(MikaSystemKey)) != 3 {
		t.Fatal("native Mika did not receive its declared scope")
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
