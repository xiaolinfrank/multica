package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type CockpitNodeCodePreview struct {
	WorkspaceID string  `json:"workspace_id"`
	ParentID    *string `json:"parent_id"`
	Code        string  `json:"code"`
}

func (s *IssueService) GetCockpitNodeCodePreview(ctx context.Context, p CockpitSurfaceQuery, parent pgtype.UUID) (CockpitNodeCodePreview, error) {
	var out CockpitNodeCodePreview
	tx, q, err := s.beginPlanningRead(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	header, err := readCockpitSurfaceContext(ctx, q, p)
	if err != nil {
		return out, err
	}
	code, err := ReadCockpitNextNodeCode(ctx, q, p.WorkspaceID, parent)
	if err != nil {
		return out, err
	}
	out = CockpitNodeCodePreview{WorkspaceID: header.WorkspaceID, ParentID: planningUUID(parent), Code: code}
	return out, tx.Commit(ctx)
}

// Writers hold the workspace board lock; readers use it only as a preview.
func ReadCockpitNextNodeCode(ctx context.Context, q *db.Queries, workspace, parent pgtype.UUID) (string, error) {
	prefix := "L1-"
	if parent.Valid {
		node, e := q.GetCockpitNode(ctx, db.GetCockpitNodeParams{WorkspaceID: workspace, ID: parent})
		if errors.Is(e, pgx.ErrNoRows) {
			return "", fmt.Errorf("%w: parent node not found", ErrCockpitWorkflowInput)
		}
		if e != nil {
			return "", e
		}
		prefix = node.Code + "-"
	}
	seq, err := q.GetCockpitNodeCodeSequence(ctx, db.GetCockpitNodeCodeSequenceParams{WorkspaceID: workspace, Prefix: prefix})
	if err != nil {
		return "", err
	}
	if seq.Unsupported {
		return "", fmt.Errorf("%w: node code sequence exceeds the supported length", ErrCockpitWorkflowInput)
	}
	code := fmt.Sprintf("%s%02d", prefix, seq.Maximum+1)
	if len([]rune(code)) > 64 {
		return "", fmt.Errorf("%w: parent code leaves no space for a child code", ErrCockpitWorkflowInput)
	}
	return code, nil
}
