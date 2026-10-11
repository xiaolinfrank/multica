package service

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (s *IssueService) beginInputRead(ctx context.Context, p CockpitInputRead) (pgx.Tx, *db.Queries, cockpitInputAuthority, error) {
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return nil, nil, cockpitInputAuthority{}, err
	}
	a, err := inputReadPrincipal(ctx, q, p)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, a, err
	}
	return tx, q, a, nil
}

func inputReadScope(p CockpitInputQuery, kind string) string {
	return planningHash(struct {
		Workspace, CredentialOwner, Agent, Run, Runtime  pgtype.UUID
		Kind, ActorSource, Purpose                       string
		Input, Version, Meeting, Agenda, Issue, Manifest pgtype.UUID
		Scope                                            CockpitInputScope
		Removed                                          bool
		Size                                             int32
	}{p.WorkspaceID, p.CredentialOwnerID, p.AgentID, p.RunID, p.RuntimeID, kind, p.ActorSource, p.Purpose,
		p.InputID, p.VersionID, p.MeetingID, p.AgendaID, p.IssueID, p.ManifestVersionID, p.Scope, p.IncludeRemoved, p.PageSize})
}

func inputReadCursor(p CockpitInputQuery, kind string) (lifecycleCursor, pgtype.UUID, pgtype.Timestamptz, error) {
	c, id, err := decodeLifecycleCursor(p.Cursor, inputReadScope(p, kind), 0)
	if err != nil {
		return c, id, pgtype.Timestamptz{}, inputError("invalid_input", "The cursor does not belong to this input scope and filter.")
	}
	var stamp pgtype.Timestamptz
	if p.Cursor != "" && c.Time != "" {
		value, e := time.Parse(time.RFC3339Nano, c.Time)
		if e != nil {
			return c, id, stamp, inputError("invalid_input", "The input cursor has an invalid observation time.")
		}
		stamp = pgtype.Timestamptz{Time: value, Valid: true}
	}
	return c, id, stamp, nil
}

func inputTimeCursor(p CockpitInputQuery, kind string, id pgtype.UUID, stamp pgtype.Timestamptz) *string {
	return encodeLifecycleCursor(lifecycleCursor{Scope: inputReadScope(p, kind), ID: util.UUIDToString(id), Time: stamp.Time.UTC().Format(time.RFC3339Nano)})
}
func inputNumberCursor(p CockpitInputQuery, kind string, id pgtype.UUID, number int64) *string {
	return encodeLifecycleCursor(lifecycleCursor{Scope: inputReadScope(p, kind), ID: util.UUIDToString(id), Order: number})
}

func inputPrefix(value string) string {
	return strings.NewReplacer("\\", "\\\\", "%", "\\%", "_", "\\_").Replace(strings.ToLower(value)) + "%"
}
func inputUUIDs(values []string, maximum int) ([]pgtype.UUID, error) {
	if len(values) > maximum {
		return nil, inputError("invalid_input", "The selected identifier set exceeds the input read limit.")
	}
	out := make([]pgtype.UUID, 0, len(values))
	seen := map[pgtype.UUID]bool{}
	for _, value := range values {
		id, err := util.ParseUUID(value)
		if err != nil || !id.Valid || seen[id] {
			return nil, inputError("invalid_input", "Input selections require unique valid identifiers.")
		}
		seen[id] = true
		out = append(out, id)
	}
	return out, nil
}
func inputOptionalID(value *string) (pgtype.UUID, error) {
	if value == nil {
		return pgtype.UUID{}, nil
	}
	ids, err := inputUUIDs([]string{*value}, 1)
	if err != nil {
		return pgtype.UUID{}, err
	}
	return ids[0], nil
}
func inputUniqueIDs(values []pgtype.UUID) []pgtype.UUID {
	out := make([]pgtype.UUID, 0, len(values))
	seen := map[pgtype.UUID]bool{}
	for _, id := range values {
		if id.Valid && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}
func inputTime(value pgtype.Timestamptz) string { return value.Time.UTC().Format(time.RFC3339Nano) }
func inputText(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}
func inputInt(value pgtype.Int8) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func inputCatalogAllowed(p CockpitInputRead) bool {
	return p.ActorSource == "human" || p.ActorSource == "task_token"
}
func inputLiveAuthority(p CockpitInputRead, a cockpitInputAuthority) bool {
	return p.ActorSource == "human" || p.ActorSource == "task_token" && (a.Run.Status == "running" || a.Run.Status == "dispatched")
}

func inputReadableVersions(ctx context.Context, q *db.Queries, p CockpitInputRead, a cockpitInputAuthority, rows []db.CockpitInputVersion) (map[pgtype.UUID]bool, error) {
	allowed := map[pgtype.UUID]bool{}
	if len(rows) == 0 {
		return allowed, nil
	}
	if len(rows) > CockpitInputMaxSelectedIDs {
		return nil, inputError("invalid_input", "The fixed version read exceeds its bounded batch.")
	}
	heads, ids := []pgtype.UUID{}, []pgtype.UUID{}
	for _, v := range rows {
		if v.WorkspaceID != p.WorkspaceID {
			return nil, inputError("permission_revoked", "The input version belongs to another workspace.")
		}
		heads = append(heads, v.InputID)
		ids = append(ids, v.ID)
	}
	headerRows, err := q.ReadCockpitInputHeaders(ctx, db.ReadCockpitInputHeadersParams{WorkspaceID: p.WorkspaceID, Ids: inputUniqueIDs(heads)})
	if err != nil {
		return nil, err
	}
	headAllowed := map[pgtype.UUID]bool{}
	for _, h := range headerRows {
		headAllowed[h.ID] = p.ActorSource == "human" || p.ActorSource == "task_token" && inputSameSource(h.SourceAgentID, h.SourceIssueID, h.AuthorizingUserID, a)
	}
	for _, v := range rows {
		if headAllowed[v.InputID] {
			allowed[v.ID] = true
		}
	}
	if p.ActorSource != "human" && a.Run.InputManifestVersionID.Valid {
		pinned, e := q.ReadCockpitInputPinnedVersions(ctx, db.ReadCockpitInputPinnedVersionsParams{WorkspaceID: p.WorkspaceID, ManifestVersionID: a.Run.InputManifestVersionID, Ids: ids})
		if e != nil {
			return nil, e
		}
		for _, id := range pinned {
			for _, v := range rows {
				if v.ID == id {
					if _, exists := headAllowed[v.InputID]; exists {
						allowed[id] = true
					}
					break
				}
			}
		}
	}
	return allowed, nil
}

func inputReadNotFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return inputError("not_found", "The selected input record is unavailable in this workspace.")
	}
	return err
}
