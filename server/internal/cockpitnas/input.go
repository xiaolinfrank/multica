package cockpitnas

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

const inputSessionTTL = 2 * time.Minute
const inputObservationTTL = 5 * time.Minute
const inputSessionLimit = 32
const inputPageScanBudget = 256

type InputRootInfo struct {
	RootID, Path, RootConfigHash string
	Subpaths                     []string
}
type InputBrowseRequest struct {
	WorkspaceID, ActorScope, RootID, RelativeDirectory, Query, Cursor string
	PageSize                                                          int32
}
type InputBrowseEntry struct {
	Name, RelativePath, Kind, ObservationToken string
	SizeBytes                                  *int64
	ModifiedAt                                 *string
	CanSelect, CanOpenDirectory                bool
	UnavailableReason                          string
}
type InputBrowsePage struct {
	WorkspaceID, RootID, RelativeDirectory, Query, RootConfigHash, ObservationToken string
	PageSize                                                                        int32
	Items                                                                           []InputBrowseEntry
	Total                                                                           *int64
	HasMore                                                                         bool
	NextCursor                                                                      *string
}

// InputObservation is persisted only after domain authorization. The worker
// can reopen these exact facts after a restart without trusting a stale token.
type InputObservation struct {
	WorkspaceID, RootID, RootPath, RootConfigHash, RootIdentity, RelativePath, FileIdentity string
	SizeBytes, MtimeNS                                                                      int64
}

type inputToken struct {
	Kind        string            `json:"k"`
	Scope       string            `json:"s"`
	Session     string            `json:"n,omitempty"`
	Sequence    uint64            `json:"q,omitempty"`
	Expires     int64             `json:"e"`
	Observation *InputObservation `json:"o,omitempty"`
}
type inputSession struct {
	pendingName                     string
	request                         InputBrowseRequest
	scope, configHash, rootIdentity string
	directory                       *os.File
	verify                          func(context.Context) error
	close                           func()
	expires                         time.Time
	busy                            bool
	sequence                        uint64
	lastCursor                      string
	lastPage                        *InputBrowsePage
}
type inputState struct {
	mu        sync.Mutex
	key       [32]byte
	sessions  map[string]*inputSession
	fileSlots chan struct{}
}

func (f *Files) inputStateReady() (*inputState, error) {
	if f == nil {
		return nil, fail("input_scope_not_configured", "NAS input access is not configured.", false)
	}
	f.inputInit.Do(func() {
		s := &inputState{sessions: map[string]*inputSession{}, fileSlots: make(chan struct{}, 2)}
		if _, err := rand.Read(s.key[:]); err != nil {
			f.inputInitError = err
			return
		}
		f.inputReader = s
	})
	if f.inputInitError != nil {
		return nil, fail("storage_unavailable", "Input observation signing is unavailable.", true)
	}
	return f.inputReader, nil
}
func (f *Files) InputRoot(workspace string) (*InputRootInfo, error) {
	if f == nil {
		return nil, fail("input_scope_not_configured", "NAS input access is not configured.", false)
	}
	if !platformSupported {
		return nil, fail("unsupported_platform", "NAS input access is unsupported on this server platform.", false)
	}
	root, ok := f.roots[workspace]
	if !ok || len(root.InputSubpaths) == 0 {
		return nil, fail("input_scope_not_configured", "NAS input access is not configured for this workspace.", false)
	}
	_, hash, err := f.inputRoot(workspace, root.RootID, root.InputSubpaths[0])
	if err != nil {
		return nil, err
	}
	return &InputRootInfo{RootID: root.RootID, Path: root.Path, Subpaths: append([]string{}, root.InputSubpaths...), RootConfigHash: hash}, nil
}
func (s *inputState) seal(t inputToken) (string, error) {
	raw, err := json.Marshal(t)
	if err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, s.key[:])
	mac.Write([]byte(payload))
	token := payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if len(token) > 16000 {
		return "", fail("observation_too_large", "The exact input observation exceeds its supported size; it was not truncated.", false)
	}
	return token, nil
}
func (s *inputState) decode(raw, kind, scope string, now time.Time) (inputToken, error) {
	var t inputToken
	if len(raw) > 16000 {
		return t, fail("observation_invalid", "The input observation is invalid.", false)
	}
	parts := strings.Split(raw, ".")
	if len(parts) != 2 {
		return t, fail("observation_invalid", "The input observation is invalid.", false)
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	mac := hmac.New(sha256.New, s.key[:])
	mac.Write([]byte(parts[0]))
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return t, fail("observation_invalid", "The input observation is invalid.", false)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(payload, &t) != nil || t.Kind != kind || t.Scope != scope {
		return t, fail("observation_invalid", "The input observation belongs to another scope.", false)
	}
	if t.Expires <= now.Unix() {
		return t, fail("observation_expired", "The input observation expired. Browse the directory again.", false)
	}
	return t, nil
}
func inputActorScope(workspace, actor string) string {
	return preparationHash([]string{workspace, actor})
}
func inputBrowseScope(r InputBrowseRequest, root Root, config string) string {
	return preparationHash([]any{r.WorkspaceID, r.ActorScope, r.RootID, root.Path, r.RelativeDirectory, r.Query, r.PageSize, config})
}
func inputProtectedPath(path string, relative bool) bool {
	for _, part := range strings.Split(strings.ReplaceAll(path, "\\", "/"), "/") {
		lower := strings.ToLower(part)
		if lower == "artifact-versions" || lower == "input-versions" || (relative && (lower == ".multica" || strings.HasPrefix(lower, ".multica-"))) {
			return true
		}
	}
	return false
}

// Keep reservations until descriptors have actually closed. Expired idle
// sessions are reaped by the next request; blocked I/O never creates unbounded
// detached goroutines or frees a still-active reservation.
func (s *inputState) discard(id string, session *inputSession) {
	if session.close != nil {
		session.close()
	}
	s.mu.Lock()
	if s.sessions[id] == session {
		delete(s.sessions, id)
	}
	s.mu.Unlock()
}
func (s *inputState) reap(now time.Time) {
	expired := map[string]*inputSession{}
	s.mu.Lock()
	for id, session := range s.sessions {
		if !session.busy && !now.Before(session.expires) {
			session.busy = true
			expired[id] = session
		}
	}
	s.mu.Unlock()
	for id, session := range expired {
		s.discard(id, session)
	}
}
func (s *inputState) acquireFile(ctx context.Context) (func(), error) {
	if ctx.Err() != nil {
		return nil, fail("io_timeout", "The input read was cancelled before filesystem access.", true)
	}
	select {
	case s.fileSlots <- struct{}{}:
		var once sync.Once
		return func() { once.Do(func() { <-s.fileSlots }) }, nil
	default:
		return nil, fail("input_io_busy", "NAS input reads are busy. Retry after the current reads finish.", true)
	}
}

type inputReleasedReader struct {
	io.ReadCloser
	release func()
	once    sync.Once
	err     error
}

func (r *inputReleasedReader) Close() error {
	r.once.Do(func() { r.err = r.ReadCloser.Close(); r.release() })
	return r.err
}
