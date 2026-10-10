// Package artifactdownload grants a short, fixed-version download capability.
// It does not replace the handler's current workspace membership check.
package artifactdownload

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

const TTL = time.Minute
const keyDomain = "cockpit-artifact-file-capability:v1:"
const maxTokenBytes = 2048

var ErrInvalidCapability = errors.New("invalid or expired artifact download link")

type Claims struct {
	WorkspaceID string
	ArtifactID  string
	VersionID   string
	ContentHash string
	UserID      string
	ExpiresAt   int64
}

type Signer struct{ key [sha256.Size]byte }

func New(secret []byte) (*Signer, error) {
	if len(secret) == 0 {
		return nil, ErrInvalidCapability
	}
	return &Signer{key: sha256.Sum256(append([]byte(keyDomain), secret...))}, nil
}

func validClaims(claims Claims) bool {
	for _, value := range []string{claims.WorkspaceID, claims.ArtifactID, claims.VersionID, claims.UserID} {
		id, err := uuid.Parse(value)
		if err != nil || id == uuid.Nil || id.String() != value {
			return false
		}
	}
	hash, err := hex.DecodeString(claims.ContentHash)
	return err == nil && len(hash) == sha256.Size && strings.ToLower(claims.ContentHash) == claims.ContentHash
}

func (s *Signer) signature(payload []byte) []byte {
	mac := hmac.New(sha256.New, s.key[:])
	_, _ = mac.Write(payload)
	return mac.Sum(nil)
}

// Mint always chooses its own expiry; callers cannot request a longer grant.
func (s *Signer) Mint(claims Claims, now time.Time) (string, time.Time, error) {
	if s == nil || !validClaims(claims) {
		return "", time.Time{}, ErrInvalidCapability
	}
	expires := now.Add(TTL).Truncate(time.Second)
	payload := []byte(strings.Join([]string{"v1", claims.WorkspaceID, claims.ArtifactID, claims.VersionID, claims.ContentHash, claims.UserID, strconv.FormatInt(expires.Unix(), 10)}, "|"))
	return base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(s.signature(payload)), expires, nil
}

func (s *Signer) Verify(token string, now time.Time) (Claims, error) {
	var claims Claims
	if s == nil || token == "" || len(token) > maxTokenBytes {
		return claims, ErrInvalidCapability
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return claims, ErrInvalidCapability
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return claims, ErrInvalidCapability
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(signature, s.signature(payload)) {
		return claims, ErrInvalidCapability
	}
	fields := strings.Split(string(payload), "|")
	if len(fields) != 7 || fields[0] != "v1" {
		return claims, ErrInvalidCapability
	}
	expires, err := strconv.ParseInt(fields[6], 10, 64)
	if err != nil || expires <= now.Unix() || expires > now.Add(TTL).Unix() {
		return claims, ErrInvalidCapability
	}
	claims = Claims{WorkspaceID: fields[1], ArtifactID: fields[2], VersionID: fields[3], ContentHash: fields[4], UserID: fields[5], ExpiresAt: expires}
	if !validClaims(claims) {
		return Claims{}, ErrInvalidCapability
	}
	return claims, nil
}
