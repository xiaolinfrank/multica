package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func preparationManager(human bool, actor, creator pgtype.UUID, role string) bool {
	return human && (actor == creator || role == "owner" || role == "admin")
}

func preparationUUID(raw *string) (pgtype.UUID, error) {
	if raw == nil || *raw == "" {
		return pgtype.UUID{}, nil
	}
	return util.ParseUUID(*raw)
}

type CockpitPreparationQuery struct {
	CockpitLifecycleRead
	OperationID, EffectID, IssueID pgtype.UUID
	Query, Cursor                  string
	PageSize                       int32
}

type CockpitPreparationCounts struct {
	Total          int32 `json:"total"`
	Pending        int32 `json:"pending"`
	Applied        int32 `json:"applied"`
	NeedsAttention int32 `json:"needs_attention"`
	Skipped        int32 `json:"skipped"`
}

type CockpitPreparationOperationHeader struct {
	TemplateID            *string                  `json:"template_id"`         // Retired; always null.
	TemplateVersionID     *string                  `json:"template_version_id"` // Retired; always null.
	WorkspaceID           string                   `json:"workspace_id"`
	MeetingID             string                   `json:"meeting_id"`
	ID                    string                   `json:"id"`
	Kind                  string                   `json:"kind"`
	Revision              int64                    `json:"revision"`
	State                 string                   `json:"state"`
	CommandKey            string                   `json:"command_key"`
	CreatedBy             string                   `json:"created_by"`
	CreatedByName         string                   `json:"created_by_name"`
	ResponsibleUserID     string                   `json:"responsible_user_id"`
	CreatedAt             string                   `json:"created_at"`
	UpdatedAt             string                   `json:"updated_at"`
	Counts                CockpitPreparationCounts `json:"counts"`
	CanContinue           bool                     `json:"can_continue"`
	CanResume             bool                     `json:"can_resume"`
	CanPause              bool                     `json:"can_pause"`
	CanClaim              bool                     `json:"can_claim"`
	BlockedReasons        []string                 `json:"blocked_reasons"`
	TemplateTitle         string                   `json:"template_title"`
	TemplateVersionNumber *int32                   `json:"template_version_number"`
	ResponsibleUserName   string                   `json:"responsible_user_name"`
}

type CockpitPreparationEffectReceipt struct {
	EffectID              string               `json:"effect_id"`
	CommandKey            string               `json:"command_key"`
	RequestHash           string               `json:"request_hash"`
	Kind                  string               `json:"kind"`
	AgendaID              *string              `json:"agenda_id"`
	ReferenceID           *string              `json:"reference_id"`
	IssueID               *string              `json:"issue_id"`
	RunID                 *string              `json:"run_id"`
	Issue                 *CockpitIssueSummary `json:"issue"`
	RunStatus             *string              `json:"run_status"`
	StoppedWakeupIDs      []string             `json:"stopped_wakeup_ids"`
	CancelledQueueIDs     []string             `json:"cancelled_queue_ids"`
	AppliedAt             string               `json:"applied_at"`
	AuthorizationKey      string               `json:"authorization_key"`
	AuthorizationRevision int64                `json:"authorization_revision"`
	Changed               bool                 `json:"changed"`
	StoppedWakeupTotal    int64                `json:"stopped_wakeup_total"`
	CancelledQueueTotal   int64                `json:"cancelled_queue_total"`
	FactsHash             string               `json:"facts_hash"`
	TargetMeetingID       *string              `json:"target_meeting_id"`
}

type CockpitPreparationEffect struct {
	ID                    string                           `json:"id"`
	OperationID           string                           `json:"operation_id"`
	SlotID                string                           `json:"slot_id"`
	Position              int32                            `json:"position"`
	Kind                  string                           `json:"kind"`
	Label                 string                           `json:"label"`
	Revision              int64                            `json:"revision"`
	State                 string                           `json:"state"`
	CommandKey            string                           `json:"command_key"`
	DependencyID          *string                          `json:"dependency_id"`
	ErrorCode             string                           `json:"error_code"`
	Reason                string                           `json:"reason"`
	Targets               []IssueOperationTarget           `json:"targets"`
	Receipt               *CockpitPreparationEffectReceipt `json:"receipt"`
	CanApply              bool                             `json:"can_apply"`
	CanSkip               bool                             `json:"can_skip"`
	CanReauthorize        bool                             `json:"can_reauthorize"`
	AuthorizationKey      string                           `json:"authorization_key"`
	AuthorizationRevision int64                            `json:"authorization_revision"`
}

type CockpitPreparationEffectPage struct {
	WorkspaceID string                     `json:"workspace_id"`
	MeetingID   string                     `json:"meeting_id"`
	OperationID string                     `json:"operation_id"`
	Revision    int64                      `json:"revision"`
	PageSize    int32                      `json:"page_size"`
	Items       []CockpitPreparationEffect `json:"items"`
	Total       int64                      `json:"total"`
	NextCursor  *string                    `json:"next_cursor"`
}

type CockpitPreparationOperationPage struct {
	WorkspaceID string                              `json:"workspace_id"`
	MeetingID   string                              `json:"meeting_id"`
	PageSize    int32                               `json:"page_size"`
	Items       []CockpitPreparationOperationHeader `json:"items"`
	Total       int64                               `json:"total"`
	NextCursor  *string                             `json:"next_cursor"`
}

// One confirmation authorizes all selected effects. The client automatically
// applies them in order; each request has one transaction and a durable receipt.
type CockpitPreparationEffectApplyInput struct {
	CommandKey            string `json:"command_key"`
	AuthorizationKey      string `json:"authorization_key"`
	AuthorizationRevision int64  `json:"authorization_revision"`
}

type CockpitPreparationControlInput struct {
	CockpitLifecycleCommandInput
	Transition string  `json:"transition"`
	EffectID   *string `json:"effect_id"`
	Reason     string  `json:"reason"`
}

type CockpitPreparationCommandReceipt struct {
	TemplateVersionID     *string                             `json:"template_version_id"` // Retired; null on cancellation receipts.
	DirectoryEffect       *CockpitDirectoryCancellationEffect `json:"directory_effect"`
	OperationID           string                              `json:"operation_id"`
	Kind                  string                              `json:"kind"`
	Revision              int64                               `json:"revision"`
	State                 string                              `json:"state"`
	EffectIDs             []string                            `json:"effect_ids"`
	EffectID              *string                             `json:"effect_id"`
	Reason                string                              `json:"reason"`
	RequestHash           string                              `json:"request_hash"`
	Occurrence            *CockpitOccurrenceView              `json:"occurrence"`
	ContextToken          string                              `json:"context_token"`
	Authorization         *CockpitPreparationAuthorization    `json:"authorization"`
	PreviousAuthorization *CockpitPreparationAuthorization    `json:"previous_authorization"`
}

type CockpitPreparationCommandResult struct {
	WorkspaceID string                            `json:"workspace_id"`
	MeetingID   string                            `json:"meeting_id"`
	CommandKey  string                            `json:"command_key"`
	Action      string                            `json:"action"`
	Replayed    bool                              `json:"replayed"`
	Receipt     CockpitPreparationCommandReceipt  `json:"receipt"`
	Current     CockpitPreparationOperationHeader `json:"current"`
}

type CockpitPreparationEffectResult struct {
	WorkspaceID string                            `json:"workspace_id"`
	MeetingID   string                            `json:"meeting_id"`
	OperationID string                            `json:"operation_id"`
	EffectID    string                            `json:"effect_id"`
	CommandKey  string                            `json:"command_key"`
	Replayed    bool                              `json:"replayed"`
	Receipt     CockpitPreparationEffectReceipt   `json:"receipt"`
	Current     CockpitPreparationOperationHeader `json:"current"`
}

type CockpitPreparationEffectDetail struct {
	WorkspaceID string                            `json:"workspace_id"`
	MeetingID   string                            `json:"meeting_id"`
	OperationID string                            `json:"operation_id"`
	Effect      CockpitPreparationEffect          `json:"effect"`
	Current     CockpitPreparationOperationHeader `json:"current"`
}

type CockpitPreparationAuthorization struct {
	Key          string                           `json:"key"`
	Revision     int64                            `json:"revision"`
	ContextToken string                           `json:"context_token"`
	FactsHash    string                           `json:"facts_hash"`
	ConfirmedBy  string                           `json:"confirmed_by"`
	ConfirmedAt  string                           `json:"confirmed_at"`
	Impact       *CockpitDispositionIssue         `json:"impact"`
	SelectedRun  *CockpitDispositionRun           `json:"selected_run"`
	Scope        *CockpitPreparationResolvedScope `json:"scope"`
}

type CockpitPreparationReauthorizationPreview struct {
	WorkspaceID           string                           `json:"workspace_id"`
	MeetingID             string                           `json:"meeting_id"`
	OperationID           string                           `json:"operation_id"`
	EffectID              string                           `json:"effect_id"`
	EffectRevision        int64                            `json:"effect_revision"`
	CommandKey            string                           `json:"command_key"`
	FixedIntentHash       string                           `json:"fixed_intent_hash"`
	ContextToken          string                           `json:"context_token"`
	PreviousAuthorization CockpitPreparationAuthorization  `json:"previous_authorization"`
	CurrentImpact         *CockpitDispositionIssue         `json:"current_impact"`
	Targets               []IssueOperationTarget           `json:"targets"`
	CanConfirm            bool                             `json:"can_confirm"`
	BlockedReasons        []string                         `json:"blocked_reasons"`
	CurrentRun            *CockpitDispositionRun           `json:"current_run"`
	CurrentScope          *CockpitPreparationResolvedScope `json:"current_scope"`
}

type CockpitPreparationReauthorizationInput struct {
	CockpitLifecycleCommandInput
	ContextToken string `json:"context_token"`
	Reason       string `json:"reason"`
}

type CockpitPreparationResolvedScope struct {
	NodeID       *string `json:"node_id"`
	NodeTitle    string  `json:"node_title"`
	ProjectID    *string `json:"project_id"`
	ProjectTitle string  `json:"project_title"`
	ModuleID     *string `json:"module_id"`
	ModuleTitle  string  `json:"module_title"`
}

// Slot and binding record the fixed effect intent of a cancellation plan.
type cockpitPreparationSlot struct {
	SlotID string `json:"slot_id"`
	Kind   string `json:"kind"`
	Label  string `json:"label"`
}

type cockpitPreparationBinding struct {
	SlotID   string  `json:"slot_id"`
	Selected bool    `json:"selected"`
	IssueID  *string `json:"issue_id"`
}

type CockpitPreparationPreviewEffect struct {
	SlotID       string                           `json:"slot_id"`
	Kind         string                           `json:"kind"`
	Label        string                           `json:"label"`
	AgendaSlotID *string                          `json:"agenda_slot_id"` // Retired; always null.
	Selected     bool                             `json:"selected"`
	Allowed      bool                             `json:"allowed"`
	ReasonCodes  []string                         `json:"reason_codes"`
	Targets      []IssueOperationTarget           `json:"targets"`
	IssueImpact  *CockpitDispositionIssue         `json:"issue_impact"`
	Scope        *CockpitPreparationResolvedScope `json:"scope"`
}

type preparationEffectIntent struct {
	Slot                  cockpitPreparationSlot           `json:"slot"`
	Binding               cockpitPreparationBinding        `json:"binding"`
	NodeID                *string                          `json:"node_id"`
	ProjectID             *string                          `json:"project_id"`
	ModuleID              *string                          `json:"module_id"`
	ExpectedIssueRevision int64                            `json:"expected_issue_revision"`
	IssueChoice           *CockpitCancellationIssueChoice  `json:"issue_choice,omitempty"`
	RunID                 *string                          `json:"run_id,omitempty"`
	FactsHash             string                           `json:"facts_hash"`
	DispositionFacts      *dispositionIssueFacts           `json:"disposition_facts,omitempty"`
	ExpectedRunStatus     string                           `json:"expected_run_status,omitempty"`
	SelectedRun           *CockpitDispositionRun           `json:"selected_run,omitempty"`
	Scope                 *CockpitPreparationResolvedScope `json:"scope,omitempty"`
	SelectedRunIDs        []string                         `json:"selected_run_ids,omitempty"`
}

func preparationText(s string, max int) bool {
	return utf8.ValidString(s) && !strings.ContainsRune(s, 0) && len(s) <= max
}

type lifecycleCursor struct {
	Scope    string `json:"scope"`
	Revision int64  `json:"revision"`
	ID       string `json:"id"`
	Order    int64  `json:"order"`
	Time     string `json:"time,omitempty"`
}

func lifecycleCursorScope(p CockpitLifecycleList, kind string) string {
	return planningHash(struct {
		Workspace, Meeting pgtype.UUID
		Kind, Query        string
		Size               int32
	}{p.WorkspaceID, p.MeetingID, kind, p.Query, p.PageSize})
}
func decodeLifecycleCursor(raw, scope string, revision int64) (lifecycleCursor, pgtype.UUID, error) {
	var c lifecycleCursor
	if raw == "" {
		return c, pgtype.UUID{}, nil
	}
	if len(raw) > 4096 {
		return c, pgtype.UUID{}, ErrCockpitWorkflowInput
	}
	b, e := base64.RawURLEncoding.DecodeString(raw)
	if e != nil || json.Unmarshal(b, &c) != nil || c.Scope != scope {
		return c, pgtype.UUID{}, fmt.Errorf("%w: cursor does not match this scope", ErrCockpitWorkflowInput)
	}
	if revision > 0 && c.Revision != revision {
		return c, pgtype.UUID{}, fmt.Errorf("%w: collection changed; reload the first page", ErrCockpitWorkflowConflict)
	}
	id, e := util.ParseUUID(c.ID)
	if e != nil || !id.Valid {
		return c, id, ErrCockpitWorkflowInput
	}
	return c, id, nil
}

func encodeLifecycleCursor(c lifecycleCursor) *string {
	b, _ := json.Marshal(c)
	s := base64.RawURLEncoding.EncodeToString(b)
	return &s
}
func (s *IssueService) beginLifecycleRead(ctx context.Context, p CockpitLifecycleRead) (pgx.Tx, *db.Queries, lifecycleState, error) {
	tx, q, e := s.beginPlanningRead(ctx)
	if e != nil {
		return nil, nil, lifecycleState{}, e
	}
	if e = cockpitWorkflowMember(ctx, q, p.WorkspaceID, p.ActorID); e != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, lifecycleState{}, e
	}
	x, e := readLifecycleState(ctx, q, p)
	if e != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, x, e
	}
	return tx, q, x, nil
}
func createPreparationOperation(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, c lifecycleCommand, x lifecycleState, kind string, token string, input any, intents []preparationEffectIntent) (db.CockpitMeetingPreparationOperation, CockpitPreparationCommandReceipt, error) {
	var receipt CockpitPreparationCommandReceipt
	if len(intents) > 50 {
		return db.CockpitMeetingPreparationOperation{}, receipt, ErrCockpitWorkflowInput
	}
	body, e := json.Marshal(input)
	if e != nil || len(body) > 64<<10 {
		return db.CockpitMeetingPreparationOperation{}, receipt, ErrCockpitWorkflowInput
	}
	state := "active"
	if len(intents) == 0 {
		state = "completed"
	}
	o, e := q.CreateCockpitPreparationOperation(ctx, db.CreateCockpitPreparationOperationParams{ID: dbid.NewV7(), WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, Kind: kind, CommandKey: c.key, RequestHash: c.hash, ContextToken: token, Input: body, State: state, AuthorizedLifecycleRevision: x.meeting.LifecycleRevision, CreatedBy: p.ActorID, ResponsibleUserID: p.ActorID})
	if e != nil {
		return o, receipt, e
	}
	effectIDs := []string{}
	for i, intent := range intents {
		id := dbid.NewV7()
		key := dbid.NewV7()
		slot, e := util.ParseUUID(intent.Slot.SlotID)
		if e != nil {
			return o, receipt, e
		}
		encoded, _ := json.Marshal(intent)
		grant := preparationAuthorizationFacts{CockpitPreparationAuthorization: CockpitPreparationAuthorization{Key: util.UUIDToString(c.key), Revision: 1, ContextToken: token, FactsHash: intent.FactsHash, ConfirmedBy: util.UUIDToString(p.ActorID), ConfirmedAt: o.CreatedAt.Time.UTC().Format(time.RFC3339Nano)}, IssueRevision: intent.ExpectedIssueRevision}
		grant.Scope = intent.Scope
		grant.SelectedRun = intent.SelectedRun
		grant.RunStatus = intent.ExpectedRunStatus
		if intent.DispositionFacts != nil {
			impact := intent.DispositionFacts.View
			impact.EvaluatesParentRules = intent.Slot.Kind == "cancel_issue" && impact.ParentIssueID != nil
			grant.Impact = &impact
			grant.WakeupHash = intent.DispositionFacts.Automation.WakeupHash
			grant.TaskHash = intent.DispositionFacts.Automation.TaskHash
		}
		grantBody, _ := json.Marshal(grant)
		issue, _ := preparationUUID(intent.Binding.IssueID)
		run, _ := preparationUUID(intent.RunID)
		var targetMeeting pgtype.UUID
		if intent.IssueChoice != nil {
			targetMeeting, _ = preparationUUID(intent.IssueChoice.TargetMeetingID)
		}
		_, e = q.CreateCockpitPreparationEffect(ctx, db.CreateCockpitPreparationEffectParams{ID: id, WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, OperationID: o.ID, SlotID: slot, Position: int32(i), Kind: intent.Slot.Kind, Label: intent.Slot.Label, CommandKey: key, RequestHash: planningHash(intent), Input: encoded, IssueID: issue, RunID: run, TargetMeetingID: targetMeeting, AuthorizationKey: c.key, AuthorizationHash: grant.FactsHash, AuthorizationSnapshot: grantBody})
		if e != nil {
			return o, receipt, e
		}
		effectIDs = append(effectIDs, util.UUIDToString(id))
	}
	receipt = CockpitPreparationCommandReceipt{OperationID: util.UUIDToString(o.ID), Kind: kind, Revision: o.Revision, State: state, EffectIDs: effectIDs, RequestHash: c.hash, ContextToken: token}
	return o, receipt, nil
}

func readPreparationCommandResult(ctx context.Context, q *db.Queries, p CockpitLifecycleRead, c lifecycleCommand, old CockpitLifecycleCommandResult) (CockpitPreparationCommandResult, error) {
	if old.Receipt.Preparation == nil {
		return CockpitPreparationCommandResult{}, fmt.Errorf("preparation command is missing its fixed receipt")
	}
	id, e := util.ParseUUID(old.Receipt.Preparation.OperationID)
	if e != nil {
		return CockpitPreparationCommandResult{}, e
	}
	o, e := q.GetCockpitPreparationOperation(ctx, db.GetCockpitPreparationOperationParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, ID: id})
	if errors.Is(e, pgx.ErrNoRows) {
		return CockpitPreparationCommandResult{}, ErrCockpitLifecycleGone
	}
	if e != nil {
		return CockpitPreparationCommandResult{}, e
	}
	h, e := preparationHeader(ctx, q, p, o)
	if e != nil {
		return CockpitPreparationCommandResult{}, e
	}
	return CockpitPreparationCommandResult{WorkspaceID: h.WorkspaceID, MeetingID: h.MeetingID, CommandKey: util.UUIDToString(c.key), Action: c.action, Replayed: true, Receipt: *old.Receipt.Preparation, Current: h}, nil
}

func (s *IssueService) ListCockpitMeetingLifecycleCommands(ctx context.Context, p CockpitLifecycleList) (CockpitLifecycleCommandPage, error) {
	var out CockpitLifecycleCommandPage
	size, e := planningPageSize(p.PageSize)
	if e != nil {
		return out, e
	}
	p.PageSize = size
	tx, q, _, e := s.beginLifecycleRead(ctx, p.CockpitLifecycleRead)
	if e != nil {
		return out, e
	}
	defer tx.Rollback(ctx)
	scope := lifecycleCursorScope(p, "commands-newest")
	c, id, e := decodeLifecycleCursor(p.Cursor, scope, 0)
	if e != nil {
		return out, e
	}
	var after pgtype.Timestamptz
	if id.Valid {
		t, e := time.Parse(time.RFC3339Nano, c.Time)
		if e != nil {
			return out, ErrCockpitWorkflowInput
		}
		after = pgtype.Timestamptz{Time: t, Valid: true}
	}
	rows, e := q.ListCockpitLifecycleCommands(ctx, db.ListCockpitLifecycleCommandsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, AfterKey: id, AfterTime: after, PageLimit: size + 1})
	if e != nil {
		return out, e
	}
	count, e := q.CountCockpitLifecycleCommands(ctx, db.CountCockpitLifecycleCommandsParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID})
	if e != nil {
		return out, e
	}
	out = CockpitLifecycleCommandPage{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), PageSize: size, Total: count, Items: []CockpitLifecycleCommandMetadata{}}
	if len(rows) > int(size) {
		rows = rows[:size]
		r := rows[len(rows)-1]
		out.NextCursor = encodeLifecycleCursor(lifecycleCursor{Scope: scope, ID: util.UUIDToString(r.CommandKey), Time: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano)})
	}
	for _, r := range rows {
		out.Items = append(out.Items, CockpitLifecycleCommandMetadata{CommandKey: util.UUIDToString(r.CommandKey), Action: r.Kind, ActorType: r.ActorType, DirectoryOperationID: planningUUID(r.DirectoryOperationID), DirectoryStepID: planningUUID(r.DirectoryStepID), ActorID: util.UUIDToString(r.ActorID), ActorName: r.ActorName, CreatedAt: r.CreatedAt.Time.UTC().Format(time.RFC3339Nano), Revision: r.Revision, IssueID: planningUUID(r.IssueID), OperationID: planningUUID(r.OperationID), EffectID: planningUUID(r.EffectID)})
	}
	return out, nil
}
func (s *IssueService) GetCockpitMeetingLifecycleCommand(ctx context.Context, p CockpitLifecycleRead, key pgtype.UUID) (CockpitLifecycleCommandDetail, error) {
	tx, q, _, e := s.beginLifecycleRead(ctx, p)
	if e != nil {
		return CockpitLifecycleCommandDetail{}, e
	}
	defer tx.Rollback(ctx)
	c, e := q.GetCockpitLifecycleCommand(ctx, db.GetCockpitLifecycleCommandParams{WorkspaceID: p.WorkspaceID, MeetingID: p.MeetingID, CommandKey: key})
	if e != nil {
		return CockpitLifecycleCommandDetail{}, cockpitWorkflowError(e)
	}
	out := CockpitLifecycleCommandDetail{WorkspaceID: util.UUIDToString(p.WorkspaceID), MeetingID: util.UUIDToString(p.MeetingID), CockpitLifecycleCommandMetadata: CockpitLifecycleCommandMetadata{CommandKey: util.UUIDToString(c.CommandKey), Action: c.Kind, ActorType: c.ActorType, DirectoryOperationID: planningUUID(c.DirectoryOperationID), DirectoryStepID: planningUUID(c.DirectoryStepID), ActorID: util.UUIDToString(c.ActorID), CreatedAt: c.CreatedAt.Time.UTC().Format(time.RFC3339Nano), Revision: c.Revision, IssueID: planningUUID(c.IssueID), OperationID: planningUUID(c.OperationID), EffectID: planningUUID(c.EffectID)}}
	if c.ActorType == "agent" {
		agent, err := q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: c.ActorID})
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return out, err
		}
		if err == nil {
			out.ActorName = agent.Name
		}
	} else {
		users, err := q.GetUsersByIDs(ctx, []pgtype.UUID{c.ActorID})
		if err != nil {
			return out, err
		}
		if len(users) > 0 {
			out.ActorName = users[0].Name
		}
	}
	e = json.Unmarshal(c.Receipt, &out.Receipt)
	return out, e
}
