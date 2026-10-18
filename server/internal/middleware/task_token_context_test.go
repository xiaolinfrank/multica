package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type taskIdentityDB struct {
	db.DBTX
	token db.TaskToken
	t     *testing.T
}

func (d taskIdentityDB) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	if len(args) != 1 || args[0] != d.token.TokenHash {
		d.t.Fatal("authentication did not look up the presented token hash")
	}
	return taskIdentityRow{d.token}
}

type taskIdentityRow struct{ token db.TaskToken }

func (r taskIdentityRow) Scan(dest ...any) error {
	*dest[0].(*pgtype.UUID) = r.token.ID
	*dest[1].(*string) = r.token.TokenHash
	*dest[2].(*pgtype.UUID) = r.token.TaskID
	*dest[3].(*pgtype.UUID) = r.token.AgentID
	*dest[4].(*pgtype.UUID) = r.token.WorkspaceID
	*dest[5].(*pgtype.UUID) = r.token.UserID
	*dest[6].(*pgtype.Timestamptz) = r.token.ExpiresAt
	*dest[7].(*pgtype.Timestamptz) = r.token.CreatedAt
	return nil
}
func TestAuthTaskTokenContextCarriesOnlyVerifiedBinding(t *testing.T) {
	id := func(n byte) pgtype.UUID { return pgtype.UUID{Bytes: [16]byte{n}, Valid: true} }
	token := db.TaskToken{ID: id(1), TaskID: id(2), AgentID: id(3), WorkspaceID: id(4), UserID: id(5), TokenHash: auth.HashToken("mat_directory-test"), ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}}
	var observed TaskTokenIdentity
	h := Auth(db.New(taskIdentityDB{token: token, t: t}), nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var ok bool
		observed, ok = TaskTokenIdentityFromContext(r.Context())
		if !ok {
			t.Fatal("authenticated task identity missing")
		}
		w.WriteHeader(200)
	}))
	req := httptest.NewRequest("GET", "/api/cockpit/directory-roots", nil)
	req.Header.Set("Authorization", "Bearer mat_directory-test")
	req.Header.Set("X-Task-Token-ID", uuidToString(id(9)))
	req.Header.Set("X-Task-ID", uuidToString(id(8)))
	req.Header.Set("X-Workspace-ID", uuidToString(id(7)))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status=%d", rec.Code)
	}
	want := TaskTokenIdentity{ID: token.ID, WorkspaceID: token.WorkspaceID, UserID: token.UserID, AgentID: token.AgentID, TaskID: token.TaskID}
	if observed != want {
		t.Fatalf("untrusted binding: %+v", observed)
	}
}
func TestAuthTaskTokenContextDoesNotSurviveHumanReauthentication(t *testing.T) {
	stale := TaskTokenIdentity{ID: pgtype.UUID{Bytes: [16]byte{1}, Valid: true}}
	h := Auth(nil, nil, nil, nil)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := TaskTokenIdentityFromContext(r.Context()); ok {
			t.Fatal("task identity survived human authentication")
		}
		w.WriteHeader(200)
	}))
	req := httptest.NewRequest("GET", "/api/cockpit/directory-roots", nil)
	req = req.WithContext(context.WithValue(req.Context(), taskTokenIdentityKey{}, stale))
	req.Header.Set("Authorization", "Bearer "+generateToken(validClaims(), auth.JWTSecret()))
	req.Header.Set("X-Task-Token-ID", uuidToString(stale.ID))
	req.Header.Set("X-Actor-Source", "task_token")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status=%d", rec.Code)
	}
}
