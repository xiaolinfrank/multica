package handler

import (
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/multica-ai/multica/server/internal/service"
	"net/http"
)

func writeCockpitPrimaryIntegrityError(w http.ResponseWriter, err error) bool {
	if !service.IsCockpitPrimaryIntegrityError(err) && !service.IsCockpitArtifactIntegrityError(err) {
		return false
	}
	var pgerr *pgconn.PgError
	if errors.As(err, &pgerr) {
		writeError(w, http.StatusConflict, pgerr.Message)
	} else {
		writeError(w, http.StatusConflict, "a confirmed meeting action still retains this plan row; reload before changing its structure")
	}
	return true
}
