package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"path"
	"regexp"
	"slices"
)

type BuiltinSkillPolicyEntry struct {
	Name       string   `json:"name"`
	Roles      []string `json:"roles"`
	Activation string   `json:"activation"`
}

type BuiltinSkillPolicy struct {
	Format string                    `json:"format"`
	Skills []BuiltinSkillPolicyEntry `json:"skills"`
}

type BuiltinSkillArtifactEntry struct {
	BuiltinSkillPolicyEntry
	Files map[string]string `json:"files"`
}

type BuiltinSkillArtifact struct {
	Format       string                      `json:"format"`
	Commit       string                      `json:"commit"`
	PolicySHA256 string                      `json:"policySha256"`
	Skills       []BuiltinSkillArtifactEntry `json:"skills"`
}

var builtinPolicy = mustBuiltinSkillPolicy()

func parseBuiltinSkillPolicy(data []byte) (BuiltinSkillPolicy, error) {
	var policy BuiltinSkillPolicy
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return policy, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return policy, fmt.Errorf("trailing builtin skill policy data")
	}
	if policy.Format != "multica-builtin-skill-policy-v1" || len(policy.Skills) == 0 {
		return policy, fmt.Errorf("invalid builtin skill policy identity")
	}
	seen := map[string]bool{}
	for _, entry := range policy.Skills {
		if !regexp.MustCompile(`^multica-[a-z0-9-]+$`).MatchString(entry.Name) || seen[entry.Name] || len(entry.Roles) == 0 {
			return policy, fmt.Errorf("invalid or duplicate builtin skill name")
		}
		seen[entry.Name] = true
		roles := map[string]bool{}
		for _, role := range entry.Roles {
			if !slices.Contains([]string{"owner", "worker", "mika"}, role) || roles[role] {
				return policy, fmt.Errorf("invalid or duplicate builtin skill role")
			}
			roles[role] = true
		}
		if entry.Activation != "on-demand" && entry.Activation != "product-mika-kickoff-only" {
			return policy, fmt.Errorf("invalid builtin skill activation")
		}
		if entry.Activation == "product-mika-kickoff-only" && (len(entry.Roles) != 1 || entry.Roles[0] != "mika") {
			return policy, fmt.Errorf("Mika kickoff skill cannot seed another role")
		}
	}
	return policy, nil
}

func mustBuiltinSkillPolicy() BuiltinSkillPolicy {
	data, err := builtinSkillsFS.ReadFile(builtinSkillsRoot + "/policy.json")
	if err != nil {
		panic(err)
	}
	policy, err := parseBuiltinSkillPolicy(data)
	if err != nil {
		panic(err)
	}
	dirs, err := fs.ReadDir(builtinSkillsFS, builtinSkillsRoot)
	if err != nil {
		panic(err)
	}
	names := map[string]bool{}
	for _, entry := range policy.Skills {
		if _, err := builtinSkillsFS.ReadFile(path.Join(builtinSkillsRoot, entry.Name, "SKILL.md")); err != nil {
			panic(err)
		}
		names[entry.Name] = true
	}
	for _, dir := range dirs {
		if dir.IsDir() && !names[dir.Name()] {
			panic("builtin skill has no role policy: " + dir.Name())
		}
	}
	return policy
}

// BuiltinSkillNamesForRole is shared by native task delivery and offline
// release inspection. The external owner role is consumed by the integrator;
// native task delivery selects worker or Mika from the immutable system key.
func BuiltinSkillNamesForRole(role string) []string {
	var names []string
	for _, entry := range builtinPolicy.Skills {
		if slices.Contains(entry.Roles, role) {
			names = append(names, entry.Name)
		}
	}
	return names
}

// BuiltinSkillsArtifact reports the files actually embedded in this binary.
// It reads no environment, credentials, workspace database or network state.
func BuiltinSkillsArtifact(commit string) (BuiltinSkillArtifact, error) {
	data, err := builtinSkillsFS.ReadFile(builtinSkillsRoot + "/policy.json")
	if err != nil {
		return BuiltinSkillArtifact{}, err
	}
	sum := sha256.Sum256(data)
	result := BuiltinSkillArtifact{Format: "multica-builtin-artifact-v1", Commit: commit, PolicySHA256: hex.EncodeToString(sum[:])}
	for _, entry := range builtinPolicy.Skills {
		item := BuiltinSkillArtifactEntry{BuiltinSkillPolicyEntry: entry, Files: map[string]string{}}
		root := path.Join(builtinSkillsRoot, entry.Name)
		err := fs.WalkDir(builtinSkillsFS, root, func(file string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return err
			}
			data, err := builtinSkillsFS.ReadFile(file)
			if err != nil {
				return err
			}
			sum := sha256.Sum256(data)
			item.Files[file[len(root)+1:]] = hex.EncodeToString(sum[:])
			return nil
		})
		if err != nil {
			return BuiltinSkillArtifact{}, err
		}
		result.Skills = append(result.Skills, item)
	}
	return result, nil
}
