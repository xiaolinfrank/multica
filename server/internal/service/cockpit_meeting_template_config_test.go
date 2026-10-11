package service

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func templateInputFixture() CockpitMeetingTemplateSaveInput {
	a := util.UUIDToString(dbid.NewV7())
	return CockpitMeetingTemplateSaveInput{CommandKey: util.UUIDToString(dbid.NewV7()), Title: "  Planning session  ", Description: " original description\n", Active: true,
		Config: CockpitMeetingTemplateConfig{SchemaVersion: 1, Slots: []CockpitMeetingTemplateSlot{
			{SlotID: a, Kind: "agenda", Label: "  Discuss  ", Agenda: &CockpitTemplateAgendaDefaults{Title: "  Plan  ", Purposes: []string{"planning"}, DesiredOutcome: "  outcome\n", Notes: "  original notes\n"}},
			{SlotID: util.UUIDToString(dbid.NewV7()), Kind: "preparation_issue", Label: "Prepare", AgendaSlotID: &a, NewIssue: &CockpitTemplateIssueDefaults{Title: "Collect facts", Description: "  source notes\n", Priority: "none"}},
		}}}
}

func TestCockpitMeetingTemplateConfigKeepsTextAndRejectsExecutableOrCyclicSlots(t *testing.T) {
	in := templateInputFixture()
	if e := normalizeTemplateSave(&in, true); e != nil {
		t.Fatal(e)
	}
	if in.Title != "Planning session" || in.Config.Slots[0].Label != "Discuss" || in.Description != " original description\n" || in.Config.Slots[0].Agenda.Notes != "  original notes\n" || in.Config.Slots[1].NewIssue.Description != "  source notes\n" {
		t.Fatal("normalization removed user-owned body whitespace")
	}
	for _, mutate := range []func(*CockpitMeetingTemplateSaveInput){
		func(v *CockpitMeetingTemplateSaveInput) { v.Config.SchemaVersion = 99 },
		func(v *CockpitMeetingTemplateSaveInput) { v.Config.Slots[1].Kind = "run_agent" },
		func(v *CockpitMeetingTemplateSaveInput) { v.Config.Slots[1].AgendaSlotID = &v.Config.Slots[1].SlotID },
		func(v *CockpitMeetingTemplateSaveInput) { v.Config.Slots[1].SlotID = v.Config.Slots[0].SlotID },
		func(v *CockpitMeetingTemplateSaveInput) { v.Config.Slots[0].Agenda.Notes = "invalid\x00text" },
	} {
		v := templateInputFixture()
		mutate(&v)
		if e := normalizeTemplateSave(&v, true); !errors.Is(e, ErrCockpitWorkflowInput) {
			t.Fatalf("unsafe configuration accepted: %v", e)
		}
	}
}

func TestCockpitMeetingTemplateBindingsRequireExplicitSelectionAndCorrectKind(t *testing.T) {
	in := templateInputFixture()
	if e := normalizeTemplateSave(&in, true); e != nil {
		t.Fatal(e)
	}
	bindings := []CockpitMeetingTemplateBinding{{SlotID: in.Config.Slots[0].SlotID, Selected: true}, {SlotID: in.Config.Slots[1].SlotID, Selected: true}}
	if _, e := normalizeTemplateBindings(in.Config, bindings); e != nil {
		t.Fatal("explicit unassigned/unfiled task must remain valid", e)
	}
	bindings[0].Selected = false
	if _, e := normalizeTemplateBindings(in.Config, bindings); !errors.Is(e, ErrCockpitWorkflowInput) {
		t.Fatal("task accepted without its selected agenda", e)
	}
	bindings[0].Selected = true
	id := util.UUIDToString(dbid.NewV7())
	bindings[1].IssueID = &id
	if _, e := normalizeTemplateBindings(in.Config, bindings); !errors.Is(e, ErrCockpitWorkflowInput) {
		t.Fatal("new issue slot accepted an existing issue replacement", e)
	}
	bindings[1].Selected = false
	if _, e := normalizeTemplateBindings(in.Config, bindings); !errors.Is(e, ErrCockpitWorkflowInput) {
		t.Fatal("unchecked slot still carried a selected identity", e)
	}
}

func TestCockpitMeetingTemplateAggregateSizeIsBounded(t *testing.T) {
	in := templateInputFixture()
	in.Config.Slots = nil
	for i := 0; i < 5; i++ {
		in.Config.Slots = append(in.Config.Slots, CockpitMeetingTemplateSlot{SlotID: util.UUIDToString(dbid.NewV7()), Kind: "agenda", Label: "Large agenda", Agenda: &CockpitTemplateAgendaDefaults{Title: "Large", Notes: strings.Repeat("x", 60000)}})
	}
	b, _ := json.Marshal(in.Config)
	if len(b) <= cockpitTemplateInputLimit {
		t.Fatal("fixture did not reach the aggregate boundary")
	}
	if e := normalizeTemplateSave(&in, true); !errors.Is(e, ErrCockpitWorkflowInput) {
		t.Fatal("individually valid notes exceeded the total request budget", e)
	}
}
