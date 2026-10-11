package service

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/multica-ai/multica/server/internal/util"
)

const cockpitTemplateInputLimit = 256 << 10

func templateText(s string, max int) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, 0) && len(s) <= max
}

func normalizeTemplateSave(in *CockpitMeetingTemplateSaveInput, creating bool) error {
	if _, e := util.ParseUUID(in.CommandKey); e != nil || in.ExpectedRevision < 0 || (creating != (in.ExpectedRevision == 0)) {
		return fmt.Errorf("%w: command_key and the expected template revision are required", ErrCockpitWorkflowInput)
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" || !templateText(in.Title, 500) || !templateText(in.Description, 16000) {
		return fmt.Errorf("%w: template title or description exceeds its supported size", ErrCockpitWorkflowInput)
	}
	if in.Config.SchemaVersion != 1 || len(in.Config.Slots) < 1 || len(in.Config.Slots) > 50 {
		return fmt.Errorf("%w: schema version 1 with 1–50 slots is required", ErrCockpitWorkflowInput)
	}
	agendas := map[string]bool{}
	seen := map[string]bool{}
	for i := range in.Config.Slots {
		s := &in.Config.Slots[i]
		id, e := util.ParseUUID(s.SlotID)
		if e != nil || !id.Valid || seen[util.UUIDToString(id)] {
			return fmt.Errorf("%w: slot IDs must be distinct UUIDs", ErrCockpitWorkflowInput)
		}
		s.SlotID = util.UUIDToString(id)
		seen[s.SlotID] = true
		s.Label = strings.TrimSpace(s.Label)
		if s.Label == "" || !templateText(s.Label, 500) {
			return fmt.Errorf("%w: every slot requires a bounded label", ErrCockpitWorkflowInput)
		}
		switch s.Kind {
		case "agenda":
			if s.Agenda == nil || s.NewIssue != nil || s.AgendaSlotID != nil || s.Purpose != "" {
				return fmt.Errorf("%w: agenda slots only carry agenda defaults", ErrCockpitWorkflowInput)
			}
			a := s.Agenda
			if !templateText(a.DesiredOutcome, 16000) || !templateText(a.Notes, 65536) || !templateText(a.Title, 500) {
				return ErrCockpitWorkflowInput
			}
			v := CockpitAgendaInput{Title: &a.Title, Purposes: &a.Purposes, DesiredOutcome: &a.DesiredOutcome, Notes: &a.Notes}
			if e = normalizeAgendaInput(&v, true); e != nil {
				return e
			}
			a.Title, a.Purposes = *v.Title, *v.Purposes
			agendas[s.SlotID] = true
		case "preparation_issue":
			if s.NewIssue == nil || s.Agenda != nil || s.Purpose != "" {
				return fmt.Errorf("%w: preparation slots only carry new-issue defaults", ErrCockpitWorkflowInput)
			}
			s.NewIssue.Title = strings.TrimSpace(s.NewIssue.Title)
			if s.NewIssue.Title == "" || !templateText(s.NewIssue.Title, 500) || !templateText(s.NewIssue.Description, 16000) {
				return ErrCockpitWorkflowInput
			}
			switch s.NewIssue.Priority {
			case "none", "urgent", "high", "medium", "low":
			default:
				return fmt.Errorf("%w: a known task priority is required", ErrCockpitWorkflowInput)
			}
		case "issue_reference", "material_reference":
			if s.NewIssue != nil || s.Agenda != nil || !templateText(s.Purpose, 500) {
				return fmt.Errorf("%w: reference slots only carry a bounded purpose", ErrCockpitWorkflowInput)
			}
			s.Purpose = strings.TrimSpace(s.Purpose)
			if (s.Kind == "material_reference" && s.Purpose != "material") || (s.Kind == "issue_reference" && s.Purpose != "preparation" && s.Purpose != "material") {
				return fmt.Errorf("%w: reference purpose must match the existing agenda relationship", ErrCockpitWorkflowInput)
			}
		default:
			return fmt.Errorf("%w: unknown template slot kind", ErrCockpitWorkflowInput)
		}
	}
	for i := range in.Config.Slots {
		s := &in.Config.Slots[i]
		if s.Kind == "agenda" {
			continue
		}
		if s.AgendaSlotID == nil {
			return fmt.Errorf("%w: preparation and reference slots require an agenda slot", ErrCockpitWorkflowInput)
		}
		id, e := util.ParseUUID(*s.AgendaSlotID)
		if e != nil || !agendas[util.UUIDToString(id)] {
			return fmt.Errorf("%w: dependency must identify an agenda in this configuration", ErrCockpitWorkflowInput)
		}
		v := util.UUIDToString(id)
		s.AgendaSlotID = &v
	}
	b, e := json.Marshal(in.Config)
	if e != nil || len(b) > cockpitTemplateInputLimit {
		return fmt.Errorf("%w: template configuration exceeds 256 KiB", ErrCockpitWorkflowInput)
	}
	return nil
}

func normalizeTemplateBindings(config CockpitMeetingTemplateConfig, bindings []CockpitMeetingTemplateBinding) (map[string]CockpitMeetingTemplateBinding, error) {
	if len(bindings) != len(config.Slots) || len(bindings) > 50 {
		return nil, fmt.Errorf("%w: provide exactly one binding per configured slot", ErrCockpitWorkflowInput)
	}
	byID := map[string]CockpitMeetingTemplateBinding{}
	for _, b := range bindings {
		id, e := util.ParseUUID(b.SlotID)
		if e != nil || !id.Valid {
			return nil, ErrCockpitWorkflowInput
		}
		b.SlotID = util.UUIDToString(id)
		if _, found := byID[b.SlotID]; found {
			return nil, fmt.Errorf("%w: duplicate binding", ErrCockpitWorkflowInput)
		}
		for _, value := range []*string{b.NodeID, b.FacilitatorUserID, b.ProjectID, b.ModuleID, b.AssigneeID, b.IssueID, b.MaterialReferenceID} {
			if _, e := preparationUUID(value); e != nil {
				return nil, e
			}
		}
		byID[b.SlotID] = b
	}
	for _, s := range config.Slots {
		b, ok := byID[s.SlotID]
		if !ok {
			return nil, fmt.Errorf("%w: a configured slot binding is missing", ErrCockpitWorkflowInput)
		}
		if !b.Selected {
			if b.NodeID != nil || b.FacilitatorUserID != nil || b.ProjectID != nil || b.ModuleID != nil || b.AssigneeID != nil || b.AssigneeType != nil || b.DueDate != nil || b.IssueID != nil || b.MaterialReferenceID != nil {
				return nil, fmt.Errorf("%w: unselected slots cannot carry identities", ErrCockpitWorkflowInput)
			}
			continue
		}
		if s.AgendaSlotID != nil && !byID[*s.AgendaSlotID].Selected {
			return nil, fmt.Errorf("%w: select the parent agenda before its preparation slot", ErrCockpitWorkflowInput)
		}
		bad := false
		switch s.Kind {
		case "agenda":
			bad = b.ProjectID != nil || b.ModuleID != nil || b.AssigneeID != nil || b.AssigneeType != nil || b.DueDate != nil || b.IssueID != nil || b.MaterialReferenceID != nil
		case "preparation_issue":
			bad = b.NodeID != nil || b.FacilitatorUserID != nil || b.IssueID != nil || b.MaterialReferenceID != nil || (b.AssigneeType == nil) != (b.AssigneeID == nil)
			if b.AssigneeType != nil && *b.AssigneeType != "member" && *b.AssigneeType != "agent" && *b.AssigneeType != "squad" {
				bad = true
			}
		case "issue_reference", "material_reference":
			bad = b.NodeID != nil || b.FacilitatorUserID != nil || b.ProjectID != nil || b.ModuleID != nil || b.AssigneeID != nil || b.AssigneeType != nil || b.DueDate != nil
			bad = bad || (s.Kind == "issue_reference" && (b.IssueID == nil || b.MaterialReferenceID != nil)) || (s.Kind == "material_reference" && (b.MaterialReferenceID == nil || b.IssueID != nil))
		}
		if bad {
			return nil, fmt.Errorf("%w: binding fields do not match their slot kind", ErrCockpitWorkflowInput)
		}
	}
	b, e := json.Marshal([]any{config, bindings})
	if e != nil || len(b) > cockpitTemplateInputLimit {
		return nil, fmt.Errorf("%w: template and bindings exceed 256 KiB", ErrCockpitWorkflowInput)
	}
	return byID, nil
}
