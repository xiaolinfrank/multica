package service

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/events"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

const CockpitFixedInputManifestCapability = protocol.DaemonCapabilityFixedInputManifestV1

type inputClaimCapabilityKey struct{}
type inputClaimDaemonIdentityKey struct{}
type inputClaimCredentialOwnerKey struct{}

// WithInputClaimCredentialOwner carries the transport-authenticated owner into
// Start. It is never populated from a request body or inferred by the service.
func WithInputClaimCredentialOwner(ctx context.Context, owner pgtype.UUID) context.Context {
	return context.WithValue(ctx, inputClaimCredentialOwnerKey{}, owner)
}

// WithInputClaimDaemonIdentity retains the verified MDT identity across the
// canonical Start transaction. Empty denotes the existing cloud credential path.
func WithInputClaimDaemonIdentity(ctx context.Context, daemonID string) context.Context {
	return context.WithValue(ctx, inputClaimDaemonIdentityKey{}, daemonID)
}

// WithFixedInputManifestClaimCapability is set only from the authenticated
// daemon transport's advertised protocol capabilities, never from task data.
func WithFixedInputManifestClaimCapability(ctx context.Context, supported bool) context.Context {
	return context.WithValue(ctx, inputClaimCapabilityKey{}, supported)
}

func inputClaimSupportsManifest(ctx context.Context) bool {
	supported, _ := ctx.Value(inputClaimCapabilityKey{}).(bool)
	return supported
}

func inputRuntimeSupportsManifest(metadata []byte) bool {
	var value struct {
		Capabilities []string `json:"capabilities"`
	}
	if json.Unmarshal(metadata, &value) != nil {
		return false
	}
	for _, capability := range value.Capabilities {
		if capability == CockpitFixedInputManifestCapability {
			return true
		}
	}
	return false
}

func inputTaskReadable(ctx context.Context, q *db.Queries, p CockpitInputQuery, a cockpitInputAuthority) (db.AgentTaskQueue, error) {
	task, err := q.GetAgentTaskInWorkspace(ctx, db.GetAgentTaskInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: p.TaskID})
	if err != nil {
		return task, inputConvertError(err)
	}
	if p.ActorSource != "human" {
		if p.TaskID != a.Run.ID {
			return task, inputError("permission_revoked", "A delegated principal can read only its exact Run inputs.")
		}
		return task, nil
	}
	if task.ChatSessionID.Valid {
		chat, e := q.GetChatSession(ctx, task.ChatSessionID)
		if e != nil {
			return task, inputConvertError(e)
		}
		if chat.WorkspaceID != p.WorkspaceID || chat.CreatorID != p.CredentialOwnerID {
			return task, inputError("permission_revoked", "This chat Run belongs to another member.")
		}
		return task, nil
	}
	agent, err := q.GetAgentInWorkspace(ctx, db.GetAgentInWorkspaceParams{WorkspaceID: p.WorkspaceID, ID: task.AgentID})
	if err != nil {
		return task, inputConvertError(err)
	}
	allowed, err := MemberMayViewAgent(ctx, q, agent, p.CredentialOwnerID, p.WorkspaceID)
	if err != nil {
		return task, err
	}
	if !allowed {
		return task, inputError("permission_revoked", "This member cannot view the selected Agent Run.")
	}
	return task, nil
}

func inputRunProjection(ctx context.Context, q *db.Queries, p CockpitInputRead, task db.AgentTaskQueue) (CockpitRunInputManifest, error) {
	out := CockpitRunInputManifest{WorkspaceID: util.UUIDToString(p.WorkspaceID), TaskID: util.UUIDToString(task.ID), IssueID: planningUUID(task.IssueID), PreparationState: task.InputPreparationState, ErrorCode: task.InputPreparationErrorCode}
	if task.InputPreparationHash.Valid {
		v := task.InputPreparationHash.String
		out.PreparationHash = &v
	}
	if task.InputPreparedAt.Valid {
		v := inputTime(task.InputPreparedAt)
		out.PreparedAt = &v
	}
	if task.RuntimeID.Valid {
		runtime, err := q.GetAgentRuntime(ctx, task.RuntimeID)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return out, err
		}
		if err == nil && runtime.WorkspaceID == p.WorkspaceID {
			out.RuntimeSupported = inputRuntimeSupportsManifest(runtime.Metadata)
		}
	}
	if !task.InputManifestVersionID.Valid {
		if task.InputPreparationState != "not_recorded" || task.InputPreparationHash.Valid || task.InputPreparedAt.Valid {
			return out, inputError("input_integrity_error", "A Run without an input manifest cannot report prepared inputs.")
		}
		return out, nil
	}
	versions, err := inputManifestVersions(ctx, q, p, []db.CockpitIssueInputManifestVersion{{WorkspaceID: p.WorkspaceID, ID: task.InputManifestVersionID}})
	if err != nil {
		return out, err
	}
	if len(versions) != 1 || versions[0].IssueID != util.UUIDToString(task.IssueID) {
		return out, inputError("input_integrity_error", "The Run input manifest does not belong to its exact Issue.")
	}
	out.ManifestVersion = &versions[0]
	out.Counts, err = inputManifestCounts(ctx, q, p.WorkspaceID, task.InputManifestVersionID)
	if err != nil {
		return out, err
	}
	if out.Counts.Total != out.ManifestVersion.ItemTotal || out.Counts.Required != out.ManifestVersion.RequiredTotal {
		return out, inputError("input_integrity_error", "The fixed Run manifest item set is incomplete.")
	}
	return out, nil
}

func (s *IssueService) GetCockpitRunInputManifest(ctx context.Context, p CockpitInputQuery) (CockpitRunInputManifest, error) {
	var out CockpitRunInputManifest
	tx, q, a, err := s.beginInputRead(ctx, p.CockpitInputRead)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	task, err := inputTaskReadable(ctx, q, p, a)
	if err != nil {
		return out, err
	}
	out, err = inputRunProjection(ctx, q, p.CockpitInputRead, task)
	if err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}

func (s *IssueService) RecordCockpitRunInputPreparation(ctx context.Context, p CockpitInputQuery, in CockpitRunInputPreparationInput) (CockpitRunInputManifest, error) {
	var out CockpitRunInputManifest
	if p.ActorSource != "daemon_claim" || p.TaskID != p.RunID || !p.RuntimeID.Valid || !p.ClaimDispatchedAt.Valid {
		return out, inputError("permission_revoked", "Input preparation requires the exact authenticated runtime claim.")
	}
	manifest, err := inputKey(in.ManifestVersionID)
	if err != nil {
		return out, err
	}
	stamp, err := time.Parse(time.RFC3339Nano, in.DispatchedAt)
	if err != nil || !stamp.Equal(p.ClaimDispatchedAt.Time) {
		return out, inputError("invalid_input", "The acknowledgement must name its exact dispatched claim.")
	}
	if (in.State != "preparing" && in.State != "required_ready" && in.State != "failed") || len(in.ErrorCode) > 160 {
		return out, inputError("invalid_input", "The input preparation state is unsupported.")
	}
	prepared, err := inputUUIDs(in.PreparedInputVersionIDs, CockpitInputManifestMaxItems)
	if err != nil {
		return out, err
	}
	if in.State != "failed" && in.ErrorCode != "" {
		return out, inputError("invalid_input", "A successful input acknowledgement cannot carry an error.")
	}
	tx, err := s.TxStarter.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	q := s.Queries.WithTx(tx)
	if _, err = q.LockWorkspaceForChatSessionCreate(ctx, p.WorkspaceID); err != nil {
		return out, inputConvertError(err)
	}
	if _, err = q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: p.WorkspaceID, UserID: p.CredentialOwnerID}); err != nil {
		return out, inputError("permission_revoked", "The runtime credential owner is no longer a member.")
	}
	// This locks originator, runtime, Agent and finally Run in canonical order,
	// then verifies the exact live claim. No filesystem I/O occurs under locks.
	a, err := inputPrincipal(ctx, q, p.CockpitInputRead, true, false)
	if err != nil {
		return out, err
	}
	task := a.Run

	if task.RuntimeID != p.RuntimeID || !task.DispatchedAt.Valid || !task.DispatchedAt.Time.Equal(stamp) || task.InputManifestVersionID != manifest {
		return out, inputError("claim_changed", "The Run claim or fixed manifest no longer matches this preparation.")
	}
	version, err := q.GetCockpitInputManifestVersion(ctx, db.GetCockpitInputManifestVersionParams{WorkspaceID: p.WorkspaceID, IssueID: task.IssueID, ID: manifest})
	if err != nil {
		return out, inputConvertError(err)
	}
	if version.ManifestHash != in.ManifestHash {
		return out, inputError("input_manifest_changed", "The preparation hash does not match the fixed Run manifest.")
	}
	items, err := q.ReadCockpitRunInputRequiredItems(ctx, db.ReadCockpitRunInputRequiredItemsParams{WorkspaceID: p.WorkspaceID, ManifestVersionID: manifest})
	if err != nil {
		return out, err
	}
	if len(items) != int(version.ItemTotal) || len(items) > CockpitInputManifestMaxItems {
		return out, inputError("input_integrity_error", "The fixed manifest item set is incomplete.")
	}
	seen := map[pgtype.UUID]bool{}
	allowed := map[pgtype.UUID]bool{}
	var required int32
	for i, item := range items {
		if item.Position != int32(i) {
			return out, inputError("input_integrity_error", "The fixed input order is incomplete.")
		}
		allowed[item.InputVersionID] = true
		if item.Required {
			required++
		}
	}
	if required != version.RequiredTotal {
		return out, inputError("input_integrity_error", "The fixed required input set is incomplete.")
	}
	for _, id := range prepared {
		if !allowed[id] {
			return out, inputError("input_manifest_changed", "The acknowledgement includes a version outside this fixed manifest.")
		}
		seen[id] = true
	}
	if in.State == "required_ready" {
		for _, item := range items {
			if item.Required && !seen[item.InputVersionID] {
				return out, inputError("input_preparation_incomplete", "Every required fixed input must be prepared before starting.")
			}
		}
	}
	changed := task.InputPreparationState != in.State || task.InputPreparationErrorCode != in.ErrorCode
	if task.Status == "running" || task.InputPreparationState == "required_ready" {
		if in.State != "required_ready" || task.InputPreparationState != "required_ready" || !task.InputPreparationHash.Valid || task.InputPreparationHash.String != in.ManifestHash {
			return out, inputError("claim_changed", "A running task cannot replace its accepted preparation.")
		}
	} else {
		if task.Status != "dispatched" && task.Status != "waiting_local_directory" {
			return out, inputError("claim_changed", "The task is no longer awaiting preparation.")
		}
		task, err = q.RecordCockpitRunInputPreparation(ctx, db.RecordCockpitRunInputPreparationParams{TaskID: p.TaskID, RuntimeID: p.RuntimeID, DispatchedAt: p.ClaimDispatchedAt, ManifestVersionID: manifest, WorkspaceID: p.WorkspaceID, PreparationState: in.State, ManifestHash: in.ManifestHash, ErrorCode: in.ErrorCode})
		if err != nil {
			return out, inputConvertError(err)
		}
	}
	out, err = inputRunProjection(ctx, q, p.CockpitInputRead, task)
	if err != nil {
		return out, err
	}
	if err = tx.Commit(ctx); err != nil {
		return out, err
	}
	if changed && s.Bus != nil {
		s.Bus.Publish(events.Event{Type: protocol.EventCockpitChanged, WorkspaceID: util.UUIDToString(p.WorkspaceID), ActorType: a.Principal.ActorType, ActorID: a.Principal.ActorID,
			Payload: map[string]any{"scope": "input_manifests", "action": "preparation_updated", "entity": map[string]any{"issue_id": util.UUIDToString(task.IssueID), "task_id": util.UUIDToString(task.ID)}}})
	}
	return out, nil
}

func guardTaskInputPreparation(ctx context.Context, q *db.Queries, task db.AgentTaskQueue) error {
	if !task.InputManifestVersionID.Valid {
		return nil
	}
	if task.InputPreparationState != "required_ready" || !task.InputPreparedAt.Valid || !task.InputPreparationHash.Valid || !task.InputPreparedDispatchedAt.Valid || !task.DispatchedAt.Valid || !task.InputPreparedDispatchedAt.Time.Equal(task.DispatchedAt.Time) {
		return inputError("input_preparation_required", "The exact required input bytes must be prepared for this dispatch before starting the Agent.")
	}
	agent, err := q.GetAgent(ctx, task.AgentID)
	if err != nil {
		return err
	}
	credentialOwner, _ := ctx.Value(inputClaimCredentialOwnerKey{}).(pgtype.UUID)
	daemonID, _ := ctx.Value(inputClaimDaemonIdentityKey{}).(string)
	_, err = inputReadPrincipal(ctx, q, CockpitInputRead{WorkspaceID: agent.WorkspaceID, CredentialOwnerID: credentialOwner, AgentID: task.AgentID, RunID: task.ID, RuntimeID: task.RuntimeID, ClaimDispatchedAt: task.DispatchedAt, ActorSource: "daemon_claim", TrustedDaemonID: daemonID})
	if err != nil {
		return err
	}
	version, err := q.GetCockpitInputManifestVersion(ctx, db.GetCockpitInputManifestVersionParams{WorkspaceID: agent.WorkspaceID, IssueID: task.IssueID, ID: task.InputManifestVersionID})
	if err != nil {
		return inputConvertError(err)
	}
	if version.ManifestHash != task.InputPreparationHash.String {
		return inputError("input_preparation_required", "The accepted preparation does not match this fixed manifest.")
	}
	return nil
}

// lockTaskInputStartPrincipal is called before any task row lock. It follows the
// same authorization lock order as preparation ACK and serializes revocation.
func lockTaskInputStartPrincipal(ctx context.Context, q *db.Queries, claim db.LockAgentTaskStartClaimParams) (db.AgentTaskQueue, error) {
	prior, err := q.GetAgentTask(ctx, claim.ID)
	if err != nil {
		return prior, err
	}
	if !prior.InputManifestVersionID.Valid {
		return q.LockAgentTaskStartClaim(ctx, claim)
	}
	if prior.RuntimeID != claim.RuntimeID || !prior.DispatchedAt.Valid || !claim.DispatchedAt.Valid || !prior.DispatchedAt.Time.Equal(claim.DispatchedAt.Time) {
		return prior, pgx.ErrNoRows
	}
	credentialOwner, _ := ctx.Value(inputClaimCredentialOwnerKey{}).(pgtype.UUID)
	if !credentialOwner.Valid {
		return prior, inputError("permission_revoked", "The authenticated runtime credential owner is required.")
	}
	runtime, err := q.GetAgentRuntime(ctx, claim.RuntimeID)
	if err != nil {
		return prior, err
	}
	if _, err = q.LockWorkspaceForChatSessionCreate(ctx, runtime.WorkspaceID); err != nil {
		return prior, inputConvertError(err)
	}
	if _, err = q.LockCockpitCreationMember(ctx, db.LockCockpitCreationMemberParams{WorkspaceID: runtime.WorkspaceID, UserID: credentialOwner}); err != nil {
		return prior, inputError("permission_revoked", "The runtime credential owner is no longer a workspace member.")
	}
	daemonID, _ := ctx.Value(inputClaimDaemonIdentityKey{}).(string)
	a, err := inputPrincipal(ctx, q, CockpitInputRead{WorkspaceID: runtime.WorkspaceID, CredentialOwnerID: credentialOwner, AgentID: prior.AgentID, RunID: prior.ID, RuntimeID: claim.RuntimeID, ClaimDispatchedAt: claim.DispatchedAt, ActorSource: "daemon_claim", TrustedDaemonID: daemonID}, true, false)
	if err != nil {
		return prior, err
	}
	return a.Run, nil
}
