package service

import (
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
)

func IsCockpitArtifactIntegrityError(err error) bool {
	var pgerr *pgconn.PgError
	return errors.As(err, &pgerr) && pgerr.ConstraintName == "cockpit_artifact_integrity"
}
