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

// The routing body is what every activation pays for, and it is also where the
// plan model is stated. Pin the statements an agent must not have to guess:
// three fixed levels, the issue's single work-item filing, L1/L2 names coming
// from titles, related links never filing, and the one-time reconcile command.
func TestCockpitSkillBodyStatesTheWorkItemModel(t *testing.T) {
	body, err := builtinSkillsFS.ReadFile("builtin_skills/multica-cockpit/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, contract := range []string{
		"Project → module → work item",
		"`issue.work_item_id`",
		"`project.title` / `module.title`",
		"Related links never file",
		"multica cockpit reconcile",
		"`--include-closed`",
		"Never run `multica update`",
	} {
		if !strings.Contains(string(body), contract) {
			t.Errorf("cockpit SKILL.md is missing %q", contract)
		}
	}

	changes, err := builtinSkillsFS.ReadFile("builtin_skills/multica-cockpit/references/changes.md")
	if err != nil {
		t.Fatalf("the review queue and event frames moved out of cockpit.md but are not embedded: %v", err)
	}
	for _, contract := range []string{"cockpit:changed", "work_item_changed", "name` is only proposable on a work item"} {
		if !strings.Contains(string(changes), contract) {
			t.Errorf("changes.md is missing %q", contract)
		}
	}
}
