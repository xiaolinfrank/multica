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

	"github.com/multica-ai/multica/server/internal/cockpitnas"
	"github.com/multica-ai/multica/server/internal/testutil"
	"github.com/multica-ai/multica/server/internal/util"
	"github.com/multica-ai/multica/server/pkg/dbid"
)

func TestCockpitDirectoryReadPagesRetainScopeAndSeparateAttemptBodies(t *testing.T) {
	f, foreign := lifecycleFixture(t), lifecycleFixture(t)
	ctx, stop := context.WithTimeout(context.Background(), 45*time.Second)
	defer stop()
	f.issues.CockpitMeetingDirectoryBackendReady = true
	provider, err := cockpitnas.New("")
	if err != nil {
		t.Fatal(err)
	}
	f.issues.CockpitDirectoryPreparer = provider
	owner := util.UUIDToString(f.owner)
	rootID := util.UUIDToString(dbid.NewV7())
	p := CockpitDirectoryRead{WorkspaceID: f.ws, MeetingID: f.meeting, CredentialOwnerID: f.owner, ActorSource: "human"}
	principal := CockpitDirectoryPrincipal{Source: "human", ActorType: "member", ActorID: owner, ActorName: "Directory coordinator", CredentialOwnerUserID: owner,
		AuthorizingUserID: owner, AuthorizingUserName: "Directory coordinator", ConfirmedByUserID: &owner, RelationKind: "none"}
	created := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	var operationIDs, stepIDs, commandIDs []string
	for index := range 33 {
		op, step, key := util.UUIDToString(dbid.NewV7()), util.UUIDToString(dbid.NewV7()), util.UUIDToString(dbid.NewV7())
		relative := fmt.Sprintf("meetings/read-%02d", index)
		hash := planningHash(relative)
		target := CockpitDirectoryTarget{RootID: rootID, RootPath: "/approved", PrepareSubpath: "meetings", RelativeDirectory: relative,
			Directory: "/approved/" + relative, TargetHash: hash, RootConfigHash: hash}
		binding := CockpitDirectoryBinding{NASDir: "", Revision: 1}
		grant := CockpitDirectoryGrant{Kind: "human", CommandKey: key, Revision: 1, ResponsibleUserID: owner, Principal: principal,
			TargetHash: hash, RootConfigHash: hash, AcceptedAt: created.Format(time.RFC3339Nano), ObservedBinding: binding}
		receipt := CockpitDirectoryCommandReceipt{DirectoryOperationID: op, DirectoryStepIDs: []string{step}, RequestHash: hash, ContextToken: &hash, PlanHash: hash,
			Target: target, ObservedBinding: binding, BindAfterBase: true, OperationRevision: 1, State: "active", ResponsibleUserID: owner,
			AuthorizedAt: created.Format(time.RFC3339Nano), Principal: principal, Grant: grant}
		f.Insert(t, "cockpit_meeting_directory_operation", testutil.Cols{"id": op, "workspace_id": f.ws, "meeting_id": f.meeting,
			"creation_command_key": key, "request_hash": hash, "plan_hash": hash, "state": "needs_attention", "root_id": rootID,
			"root_path": target.RootPath, "prepare_subpath": target.PrepareSubpath, "relative_directory": relative, "directory": target.Directory,
			"target_hash": hash, "root_config_hash": hash, "observed_nas_dir": "", "observed_binding_revision": 1, "bind_after_base": true,
			"created_by_type": "member", "created_by": owner, "credential_owner_user_id": owner, "authorizing_user_id": owner,
			"source_relation_kind": "none", "source_principal": directoryRaw(principal), "last_grant_command_key": key,
			"responsible_user_id": owner, "input": directoryRaw(CockpitDirectoryPreviewInput{Mode: "prepare", RootID: rootID, RelativeDirectory: relative, Partitions: []string{}, ObservedBindingRevision: 1, BindAfterBase: true}),
			"receipt": directoryRaw(receipt), "created_at": created.Add(time.Duration(index) * time.Second)})
		f.InsertNoID(t, "cockpit_meeting_lifecycle_command", testutil.Cols{"workspace_id": f.ws, "meeting_id": f.meeting, "command_key": key,
			"kind": "directory_prepare", "actor_id": owner, "request_hash": hash, "revision": 1, "agenda_revision": 1, "directory_operation_id": op,
			"receipt": directoryRaw(CockpitLifecycleReceipt{Revision: 1, AgendaRevision: 1, RequestHash: hash, Directory: &receipt})},
			"workspace_id=$1 AND meeting_id=$2 AND command_key=$3", f.ws, f.meeting, key)
		f.Insert(t, "cockpit_meeting_directory_step", testutil.Cols{"id": step, "workspace_id": f.ws, "meeting_id": f.meeting, "operation_id": op,
			"position": 0, "kind": "base", "label": fmt.Sprintf("Directory %02d", index), "relative_path": relative, "path_hash": hash,
			"state": "needs_attention", "grant_command_key": key, "grant_revision": 1, "last_error_code": "io_timeout"})
		operationIDs, stepIDs, commandIDs = append(operationIDs, op), append(stepIDs, step), append(commandIDs, key)
	}
	query := CockpitDirectoryQuery{CockpitDirectoryRead: p, PageSize: 25}
	first, err := f.issues.ListCockpitDirectoryOperations(ctx, query)
	if err != nil || len(first.Items) != 25 || first.Total != 33 || first.NextCursor == nil {
		t.Fatalf("operation page is not bounded: items=%d total=%d next=%v err=%v", len(first.Items), first.Total, first.NextCursor, err)
	}
	query.Cursor = *first.NextCursor
	second, err := f.issues.ListCockpitDirectoryOperations(ctx, query)
	if err != nil || len(second.Items) != 8 || second.NextCursor != nil {
		t.Fatalf("operation continuation: items=%d next=%v err=%v", len(second.Items), second.NextCursor, err)
	}
	for index, item := range append(first.Items, second.Items...) {
		if item.ID != operationIDs[32-index] || item.Counts.Total != 1 || item.Counts.NeedsAttention != 1 || item.SourcePrincipal.ActorID != owner || item.LastGrant.CommandKey != commandIDs[32-index] {
			t.Fatalf("operation %d lost its exact source, grant or order: %+v", index, item)
		}
	}
	wrongSize := query
	wrongSize.PageSize = 10
	if _, err := f.issues.ListCockpitDirectoryOperations(ctx, wrongSize); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("operation cursor crossed page size: %v", err)
	}
	query.Cursor, query.OperationID, query.StepID = "", parseTestUUID(t, operationIDs[0]), parseTestUUID(t, stepIDs[0])
	diagnostic := "ATTEMPT_BODY_ONLY_" + strings.Repeat("x", 15000)
	var attemptIDs []string
	insertAttempt := func(number int) string {
		attempt := f.Insert(t, "cockpit_meeting_directory_attempt", testutil.Cols{"id": dbid.NewV7(), "workspace_id": f.ws, "meeting_id": f.meeting,
			"operation_id": query.OperationID, "step_id": query.StepID, "attempt_number": number, "grant_command_key": commandIDs[0], "grant_revision": 1,
			"lease_token": dbid.NewV7(), "state": "failed", "started_at": created.Add(time.Duration(number) * time.Second), "finished_at": created.Add(time.Duration(number)*time.Second + time.Millisecond), "error_code": "io_timeout", "error_message": diagnostic})
		if _, err := f.Pool.Exec(ctx, "UPDATE cockpit_meeting_directory_step SET attempt_count=$1,last_attempt_id=$2,revision=revision+1 WHERE workspace_id=$3 AND id=$4", number, attempt, f.ws, query.StepID); err != nil {
			t.Fatal(err)
		}
		return attempt
	}
	for number := 1; number <= 33; number++ {
		attemptIDs = append(attemptIDs, insertAttempt(number))
	}
	attemptPage, err := f.issues.ListCockpitDirectoryAttempts(ctx, query)
	body, marshalErr := json.Marshal(attemptPage)
	if err != nil || marshalErr != nil || len(attemptPage.Items) != 25 || attemptPage.Total != 33 || attemptPage.NextCursor == nil || bytes.Contains(body, []byte("ATTEMPT_BODY_ONLY_")) || len(body) >= len(diagnostic) {
		t.Fatalf("attempt metadata leaked bodies or bounds: items=%d bytes=%d err=%v encode=%v", len(attemptPage.Items), len(body), err, marshalErr)
	}
	insertAttempt(34)
	query.Cursor = *attemptPage.NextCursor
	tail, err := f.issues.ListCockpitDirectoryAttempts(ctx, query)
	if err != nil || len(tail.Items) != 8 || tail.NextCursor != nil || tail.Total != 34 {
		t.Fatalf("new attempt disrupted the older continuation: %+v %v", tail, err)
	}
	for index, item := range append(attemptPage.Items, tail.Items...) {
		if item.ID != attemptIDs[32-index] || item.AttemptNumber != int32(33-index) {
			t.Fatal("attempt continuation repeated or skipped an original attempt")
		}
	}
	wrongStep := query
	wrongStep.StepID = parseTestUUID(t, stepIDs[1])
	if _, err := f.issues.ListCockpitDirectoryAttempts(ctx, wrongStep); !errors.Is(err, ErrCockpitWorkflowInput) {
		t.Fatalf("attempt cursor crossed step identity: %v", err)
	}
	query.Cursor, query.AttemptID = "", parseTestUUID(t, attemptIDs[0])
	late := CockpitDirectoryObservation{Directory: "/approved/meetings/read-00", DirectoryIdentity: "late-directory-identity", RootIdentity: "root-identity", Outcome: "observed_existing", ObservedAt: created.Add(time.Minute).Format(time.RFC3339Nano)}
	if _, err := f.Pool.Exec(ctx, "UPDATE cockpit_meeting_directory_attempt SET late_receipt=$1,late_observed_at=$2 WHERE workspace_id=$3 AND id=$4", directoryRaw(late), created.Add(time.Minute), f.ws, query.AttemptID); err != nil {
		t.Fatal(err)
	}
	exact, err := f.issues.GetCockpitDirectoryAttempt(ctx, query)
	if err != nil || exact.ErrorMessage != diagnostic || exact.Receipt != nil || exact.LateReceipt == nil || *exact.LateReceipt != late || exact.State != "failed" {
		t.Fatalf("exact attempt did not retain the original failure and separate late observation: %+v %v", exact, err)
	}
	foreignQuery := query
	foreignQuery.CockpitDirectoryRead = CockpitDirectoryRead{WorkspaceID: foreign.ws, MeetingID: foreign.meeting, CredentialOwnerID: foreign.owner, ActorSource: "human"}
	if _, err := foreign.issues.GetCockpitDirectoryAttempt(ctx, foreignQuery); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("foreign workspace read an attempt: %v", err)
	}
	wrongParent := query
	wrongParent.OperationID = parseTestUUID(t, operationIDs[1])
	if _, err := f.issues.GetCockpitDirectoryAttempt(ctx, wrongParent); !errors.Is(err, ErrCockpitWorkflowNotFound) {
		t.Fatalf("attempt crossed operation identity: %v", err)
	}
	header, err := f.issues.GetCockpitSurfaceContext(ctx, CockpitSurfaceQuery{WorkspaceID: f.ws, ActorID: f.owner, Human: true, MeetingDirectoryAvailable: true})
	if err != nil || !header.HasDirectoryHistory || !header.Capabilities.MeetingDirectoryPreparation {
		t.Fatalf("directory history was hidden from restore protection: %+v %v", header, err)
	}
}

func TestCockpitDirectoryReadDistinguishesMissingAndInvalidConfiguration(t *testing.T) {
	f := lifecycleFixture(t)
	p := CockpitDirectoryRead{WorkspaceID: f.ws, MeetingID: f.meeting, CredentialOwnerID: f.owner, ActorSource: "human"}
	f.issues.CockpitMeetingDirectoryBackendReady = true
	provider, err := cockpitnas.New("")
	if err != nil {
		t.Fatal(err)
	}
	f.issues.CockpitDirectoryPreparer = provider
	ctx := context.Background()
	empty, err := f.issues.ListCockpitDirectoryRoots(ctx, CockpitDirectoryQuery{CockpitDirectoryRead: p})
	if err != nil || empty.Total != 0 || len(empty.Items) != 0 {
		t.Fatalf("unconfigured root list: %+v %v", empty, err)
	}
	f.issues.CockpitDirectoryPreparer = nil
	f.issues.CockpitDirectoryConfigurationError = "prepare_configuration_invalid"
	if _, err := f.issues.ListCockpitDirectoryRoots(ctx, CockpitDirectoryQuery{CockpitDirectoryRead: p}); directoryCode(err) != "prepare_configuration_invalid" {
		t.Fatalf("invalid config pretended to be an empty root list: %v", err)
	}
	summary, err := f.issues.GetCockpitMeetingDirectory(ctx, p)
	if err != nil || !summary.Capabilities.Available || summary.Capabilities.CanCreate || summary.Capabilities.CanPreview || len(summary.BlockedReasons) != 1 || summary.BlockedReasons[0] != "prepare_configuration_invalid" {
		t.Fatalf("invalid config hid history or allowed preparation: %+v %v", summary, err)
	}
	if n := f.Count(t, "SELECT count(*) FROM cockpit_meeting_directory_operation WHERE workspace_id=$1", f.ws); n != 0 {
		t.Fatal("reading configuration created a directory operation")
	}
}
