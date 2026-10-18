package service

import (
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/util"
)

// Test-only shorthand for IDs returned by the fixture or a successful command.
func inputTrustedID(value string) pgtype.UUID {
	id, err := util.ParseUUID(value)
	if err != nil || !id.Valid {
		panic("invalid input fixture UUID")
	}
	return id
}
func inputTrustedOptionalID(value *string) pgtype.UUID {
	if value == nil {
		return pgtype.UUID{}
	}
	return inputTrustedID(*value)
}
