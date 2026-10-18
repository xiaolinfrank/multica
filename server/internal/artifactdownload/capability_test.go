package artifactdownload

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func fileClaims() Claims {
	return Claims{WorkspaceID: "10000000-0000-4000-8000-000000000001", ArtifactID: "20000000-0000-4000-8000-000000000001",
		VersionID: "30000000-0000-4000-8000-000000000001", UserID: "40000000-0000-4000-8000-000000000001", ContentHash: strings.Repeat("a", 64)}
}

func TestCapabilityConfirmsEveryIdentityAndExpiresAtSixtySeconds(t *testing.T) {
	signer, err := New([]byte("fixture-only signing secret"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1800000000, 0)
	want := fileClaims()
	token, expires, err := signer.Mint(want, now)
	if err != nil || !expires.Equal(now.Add(TTL)) {
		t.Fatalf("mint: %v, expires %v", err, expires)
	}
	want.ExpiresAt = expires.Unix()
	for _, delta := range []time.Duration{0, 59 * time.Second} {
		got, err := signer.Verify(token, now.Add(delta))
		if err != nil || got != want {
			t.Fatalf("claims at %v = %+v, %v", delta, got, err)
		}
	}
	if _, err := signer.Verify(token, expires); err == nil {
		t.Fatal("expired capability remained usable")
	}
}

func TestCapabilityRejectsTamperingAndAnotherSigningDomain(t *testing.T) {
	signer, _ := New([]byte("fixture-only signing secret"))
	now := time.Unix(1800000000, 0)
	token, _, _ := signer.Mint(fileClaims(), now)
	parts := strings.Split(token, ".")
	payload, _ := base64.RawURLEncoding.DecodeString(parts[0])
	for index, name := range []string{"format", "workspace", "artifact", "version", "hash", "user", "expiry"} {
		t.Run(name, func(t *testing.T) {
			fields := strings.Split(string(payload), "|")
			fields[index] += "x"
			forged := base64.RawURLEncoding.EncodeToString([]byte(strings.Join(fields, "|"))) + "." + parts[1]
			if _, err := signer.Verify(forged, now); err == nil {
				t.Fatal("changed download scope was accepted")
			}
		})
	}
	other, _ := New([]byte("another fixture secret"))
	if _, err := other.Verify(token, now); err == nil {
		t.Fatal("another deployment accepted the capability")
	}
	if _, err := New(nil); err == nil {
		t.Fatal("an empty signing secret was accepted")
	}
}

func TestCapabilityRejectsMalformedAndOverlongLifetimes(t *testing.T) {
	signer, _ := New([]byte("fixture-only signing secret"))
	now := time.Unix(1800000000, 0)
	for _, token := range []string{"", "not-a-token", "a.b.c", "%%%.___", strings.Repeat("x", maxTokenBytes+1)} {
		if _, err := signer.Verify(token, now); err == nil {
			t.Fatalf("malformed token accepted: %q", token)
		}
	}
	future, _, _ := signer.Mint(fileClaims(), now.Add(time.Hour))
	if _, err := signer.Verify(future, now); err == nil {
		t.Fatal("a capability outside its permitted lifetime was accepted")
	}
	invalid := fileClaims()
	invalid.VersionID = "not-an-id"
	if _, _, err := signer.Mint(invalid, now); err == nil {
		t.Fatal("an invalid version identity was signed")
	}
}
