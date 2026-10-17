package main

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/multica-ai/multica/server/internal/service"
)

func exportBuiltinSkills(args []string, out io.Writer, revision string) (bool, error) {
	if len(args) == 0 || args[0] != "--builtin-skills-manifest" {
		return false, nil
	}
	if len(args) != 1 {
		return true, fmt.Errorf("use --builtin-skills-manifest without other arguments")
	}
	manifest, err := service.BuiltinSkillsArtifact(revision)
	if err != nil {
		return true, err
	}
	return true, json.NewEncoder(out).Encode(manifest)
}
