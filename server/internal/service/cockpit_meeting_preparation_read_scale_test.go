package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

// This bounded regression measures service reads plus JSON encoding only. It
// does not represent browser/network latency or an OS cold-cache benchmark.
func preparationReadJSON(t *testing.T, label string, start time.Time, value any, err error) []byte {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%s service_plus_json_ms=%.3f response_bytes=%d (first observation, not cold cache)", label, float64(time.Since(start).Microseconds())/1000, len(body))
	return body
}

func TestCockpitPreparationReadScaleKeepsMetadataBoundedAndContinuationStable(t *testing.T) {
	f := preparationFixture(t)
	foreign := preparationFixture(t)
	ctx, stop := context.WithTimeout(context.Background(), 45*time.Second)
	defer stop()
	largeNotes := "  FIXED_BODY_ONLY_" + strings.Repeat("original evidence ", 2000) + "\n\n"
	query := CockpitMeetingTemplateQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true, PageSize: 25}
	var versions []CockpitMeetingTemplateVersionDetail
	var operations []CockpitPreparationOperationHeader
	var revision int64
	for index := 0; index < 31; index++ {
		input := templateInputFixture()
		input.CommandKey = util.UUIDToString(dbid.NewV7())
		input.ExpectedRevision = revision
		input.Title = fmt.Sprintf("Preparation version %02d", index+1)
		input.Config.Slots = input.Config.Slots[:1]
		input.Config.Slots[0].Agenda.Notes = largeNotes
		if index == 30 {
			input.Config.Slots = nil
			for position := 0; position < 50; position++ {
				input.Config.Slots = append(input.Config.Slots, CockpitMeetingTemplateSlot{
					SlotID: util.UUIDToString(dbid.NewV7()), Kind: "agenda", Label: fmt.Sprintf("Topic %02d", position+1),
					Agenda: &CockpitTemplateAgendaDefaults{Title: fmt.Sprintf("Topic %02d", position+1), Purposes: []string{"planning"}, Notes: "  Last version working notes\n"},
				})
			}
		}
		saved, err := f.issues.SaveCockpitMeetingTemplate(ctx, query, input)
		if err != nil {
			t.Fatalf("save version %d: %v", index+1, err)
		}
		query.TemplateID, err = util.ParseUUID(saved.TemplateID)
		if err != nil {
			t.Fatal(err)
		}
		revision = saved.Current.Revision
		versions = append(versions, saved.Receipt)
		previewInput := CockpitTemplateApplicationPreviewInput{TemplateVersionID: saved.Receipt.ID}
		for _, slot := range saved.Receipt.Config.Slots {
			previewInput.Bindings = append(previewInput.Bindings, CockpitMeetingTemplateBinding{SlotID: slot.SlotID, Selected: true})
		}
		preview, err := f.issues.PreviewCockpitTemplateApplication(ctx, lifecycleRead(f), previewInput)
		if err != nil || !preview.CanConfirm {
			t.Fatalf("preview version %d: %+v %v", index+1, preview, err)
		}
		applied, err := f.issues.CreateCockpitTemplateApplication(ctx, lifecycleRead(f), CockpitTemplateApplicationInput{
			CockpitLifecycleCommandInput: lifecycleInput(preview.LifecycleRevision), CockpitTemplateApplicationPreviewInput: previewInput, ContextToken: preview.ContextToken,
		})
		if err != nil {
			t.Fatalf("authorize version %d: %v", index+1, err)
		}
		operations = append(operations, applied.Current)
	}

	start := time.Now()
	firstVersions, err := f.issues.ListCockpitMeetingTemplateVersions(ctx, query)
	body := preparationReadJSON(t, "versions_page_25", start, firstVersions, err)
	if len(firstVersions.Items) != 25 || firstVersions.Total != 31 || firstVersions.NextCursor == nil || bytes.Contains(body, []byte("FIXED_BODY_ONLY_")) || bytes.Contains(body, []byte(`"config":`)) || len(body) >= len(largeNotes) {
		t.Fatalf("version metadata includes bodies or an unbounded page: items=%d bytes=%d total=%d", len(firstVersions.Items), len(body), firstVersions.Total)
	}
	query.Cursor = *firstVersions.NextCursor
	start = time.Now()
	lastVersions, err := f.issues.ListCockpitMeetingTemplateVersions(ctx, query)
	preparationReadJSON(t, "versions_continuation_6", start, lastVersions, err)
	allVersions := append(firstVersions.Items, lastVersions.Items...)
	if len(lastVersions.Items) != 6 || lastVersions.NextCursor != nil || len(allVersions) != 31 {
		t.Fatal("version continuation did not finish 25+6")
	}
	for index, version := range allVersions {
		if version.ID != versions[30-index].ID || version.Number != int32(31-index) {
			t.Fatal("version continuation duplicated, reordered, or replaced a fixed version")
		}
	}
	query.Cursor = ""
	query.VersionID, _ = util.ParseUUID(versions[0].ID)
	start = time.Now()
	fixed, err := f.issues.GetCockpitMeetingTemplateVersion(ctx, query)
	body = preparationReadJSON(t, "selected_fixed_version_body", start, fixed, err)
	if fixed.Config.Slots[0].Agenda.Notes != largeNotes || len(body) <= len(largeNotes) {
		t.Fatal("selected historical body lost exact text or fixture did not contain a large body")
	}

	p := CockpitPreparationQuery{CockpitLifecycleRead: lifecycleRead(f), PageSize: 25}
	start = time.Now()
	firstOperations, err := f.issues.ListCockpitPreparationOperations(ctx, p)
	body = preparationReadJSON(t, "operations_page_25", start, firstOperations, err)
	if len(firstOperations.Items) != 25 || firstOperations.Total != 31 || firstOperations.NextCursor == nil || len(body) >= 64*1024 || bytes.Contains(body, []byte("FIXED_BODY_ONLY_")) {
		t.Fatalf("operation metadata not bounded: items=%d bytes=%d", len(firstOperations.Items), len(body))
	}
	owner, err := f.q.GetUser(ctx, f.owner)
	if err != nil {
		t.Fatal(err)
	}
	for index, operation := range firstOperations.Items {
		var labels struct {
			Title       string `json:"template_title"`
			Version     *int32 `json:"template_version_number"`
			Responsible string `json:"responsible_user_name"`
		}
		encoded, _ := json.Marshal(operation)
		if err := json.Unmarshal(encoded, &labels); err != nil {
			t.Fatal(err)
		}
		if operation.ID != operations[30-index].ID || labels.Title != versions[30-index].Title || labels.Version == nil || *labels.Version != versions[30-index].Number || labels.Responsible != owner.Name {
			t.Fatalf("operation metadata lost fixed template identity/responsible member: %+v labels=%+v", operation, labels)
		}
	}

	p.OperationID, _ = util.ParseUUID(operations[30].ID)
	start = time.Now()
	firstEffects, err := f.issues.ListCockpitPreparationEffects(ctx, p)
	body = preparationReadJSON(t, "effects_page_25", start, firstEffects, err)
	if len(firstEffects.Items) != 25 || firstEffects.Total != 50 || firstEffects.NextCursor == nil || len(body) >= 64*1024 {
		t.Fatalf("effect page is not bounded: items=%d bytes=%d", len(firstEffects.Items), len(body))
	}
	changed := preparationApply(t, f, operations[30].ID, firstEffects.Items[0])
	if changed.Current.Counts.Applied != 1 || changed.Current.Counts.Pending != 49 {
		t.Fatalf("first-page effect state did not change: %+v", changed.Current.Counts)
	}
	p.Cursor = *firstEffects.NextCursor
	start = time.Now()
	lastEffects, err := f.issues.ListCockpitPreparationEffects(ctx, p)
	preparationReadJSON(t, "effects_continuation_after_write_25", start, lastEffects, err)
	if len(lastEffects.Items) != 25 || lastEffects.NextCursor != nil || lastEffects.Total != 50 || lastEffects.Revision <= firstEffects.Revision {
		t.Fatal("effect state change invalidated stable position continuation or returned stale revision")
	}
	seen := map[string]bool{}
	for position, effect := range append(firstEffects.Items, lastEffects.Items...) {
		if seen[effect.ID] || int(effect.Position) != position {
			t.Fatal("effect continuation repeated or omitted a fixed position")
		}
		seen[effect.ID] = true
	}
	p.Cursor = *firstOperations.NextCursor
	start = time.Now()
	lastOperations, err := f.issues.ListCockpitPreparationOperations(ctx, p)
	preparationReadJSON(t, "operations_continuation_after_write_6", start, lastOperations, err)
	if len(lastOperations.Items) != 6 || lastOperations.NextCursor != nil {
		t.Fatal("operation progress prevented historical continuation")
	}
	for index, operation := range lastOperations.Items {
		if operation.ID != operations[5-index].ID {
			t.Fatal("operation history continuation duplicated or changed order")
		}
	}
	p.Cursor = *firstEffects.NextCursor
	p.OperationID, _ = util.ParseUUID(operations[0].ID)
	if _, err = f.issues.ListCockpitPreparationEffects(ctx, p); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("effect cursor accepted another operation: %v", err)
	}
	foreignQuery := CockpitMeetingTemplateQuery{WorkspaceID: foreign.ws, ActorID: foreign.owner, Human: true, TemplateID: query.TemplateID, PageSize: 25}
	if _, err = f.issues.ListCockpitMeetingTemplateVersions(ctx, foreignQuery); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("foreign workspace read fixed versions: %v", err)
	}
	foreignRead := lifecycleRead(foreign)
	foreignRead.MeetingID = f.meeting
	if _, err = f.issues.ListCockpitPreparationOperations(ctx, CockpitPreparationQuery{CockpitLifecycleRead: foreignRead, PageSize: 25}); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("foreign workspace read operation history: %v", err)
	}
	p.CockpitLifecycleRead = foreignRead
	p.Cursor = ""
	if _, err = f.issues.ListCockpitPreparationEffects(ctx, p); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("foreign workspace read effects: %v", err)
	}
}
