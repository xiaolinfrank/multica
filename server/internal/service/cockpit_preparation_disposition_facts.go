package service

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

func (e *cockpitPreparationExecution) currentDispositionFacts(ctx context.Context, q *db.Queries) (dispositionIssueFacts, error) {
	var empty dispositionIssueFacts
	ids := []pgtype.UUID{}
	for _, raw := range e.intent.SelectedRunIDs {
		id, err := util.ParseUUID(raw)
		if err != nil {
			return empty, err
		}
		ids = append(ids, id)
	}
	facts, err := readDispositionIssues(ctx, q, e.query.CockpitLifecycleRead, []pgtype.UUID{e.effect.IssueID}, ids)
	if err != nil {
		return empty, err
	}
	f, ok := facts[e.effect.IssueID]
	if !ok {
		return empty, ErrCockpitLifecycleGone
	}
	return f, nil
}
