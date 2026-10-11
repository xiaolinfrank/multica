package middleware

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

type taskTokenIdentityKey struct{}

// TaskTokenIdentity contains only the binding verified by Auth, never a token
// value or hash. It cannot be supplied by HTTP headers or a request body.
type TaskTokenIdentity struct {
	ID, WorkspaceID, UserID, AgentID, TaskID pgtype.UUID
}

func TaskTokenIdentityFromContext(ctx context.Context) (TaskTokenIdentity, bool) {
	identity, ok := ctx.Value(taskTokenIdentityKey{}).(TaskTokenIdentity)
	return identity, ok && identity.ID.Valid
}
