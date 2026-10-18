package service

import (
	"strings"
	"testing"
)

func TestMikaReceivesCurrentCockpitSkillAndInstructions(t *testing.T) {
	found := false
	for _, skill := range loadBuiltinSkills(MikaSystemKey) {
		if skill.Name == "multica-cockpit" {
			found = true
		}
	}
	if !found {
		t.Fatal("Mika task claims do not include the cockpit skill")
	}
	instructions := MikaSystemInstructions("Renamed chief")
	for _, contract := range []string{"multica-cockpit", "project/module", "formal human review", "workspace operation"} {
		if !strings.Contains(instructions, contract) {
			t.Errorf("Mika is missing cockpit contract %q", contract)
		}
	}
	text, err := builtinSkillsFS.ReadFile("builtin_skills/multica-cockpit/references/meeting-tasks.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, contract := range []string{"system_key=mika", "ordinary Issues", "not prerequisites", "new compose", "same commit"} {
		if !strings.Contains(string(text), contract) {
			t.Errorf("embedded cockpit skill is missing %q", contract)
		}
	}
}
