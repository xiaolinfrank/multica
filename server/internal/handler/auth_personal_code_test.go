package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// These tests cover MULTICA_PERSONAL_CODES — per-email fixed login codes that,
// like MULTICA_DEV_VERIFICATION_CODE, bypass the single-use verification_code
// lifecycle so a user can log in repeatedly. They are a private-deployment
// convenience and must be disabled in production.

const personalTestCode = "112238"

func verifyCodeRequest(t *testing.T, email, code string) (*httptest.ResponseRecorder, *http.Request) {
	t.Helper()
	var buf bytes.Buffer
	if err := json.NewEncoder(&buf).Encode(map[string]string{"email": email, "code": code}); err != nil {
		t.Fatalf("encode verify-code body: %v", err)
	}
	req := httptest.NewRequest("POST", "/auth/verify-code", &buf)
	req.Header.Set("Content-Type", "application/json")
	return httptest.NewRecorder(), req
}

// No DB code row is seeded in these cases: a passing login proves the personal
// code authenticates on its own, independent of the verification_code table.
func TestVerifyCodeAcceptsPersonalCodeOutsideProduction(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	t.Setenv("APP_ENV", "")
	t.Setenv(devVerificationCodeEnv, "") // isolate from the global dev code
	t.Setenv(personalVerificationCodesEnv, "alice@personal.test:"+personalTestCode)

	const email = "alice@personal.test"
	ctx := context.Background()
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM verification_code WHERE email = $1`, email)
		_, _ = testPool.Exec(ctx, `DELETE FROM "user" WHERE email = $1`, email)
	})

	w, req := verifyCodeRequest(t, email, personalTestCode)
	testHandler.VerifyCode(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("personal code: expected 200, got %d: %s", w.Code, w.Body.String())
	}
}

func TestVerifyCodeRejectsPersonalCodeInProduction(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	t.Setenv("APP_ENV", "production")
	t.Setenv(devVerificationCodeEnv, "")
	t.Setenv(personalVerificationCodesEnv, "alice-prod@personal.test:"+personalTestCode)

	const email = "alice-prod@personal.test"
	ctx := context.Background()
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM verification_code WHERE email = $1`, email)
	})

	w, req := verifyCodeRequest(t, email, personalTestCode)
	testHandler.VerifyCode(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("personal code in production: expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// An email not listed in MULTICA_PERSONAL_CODES must not authenticate with a
// code that belongs to a different email, even when that code is configured.
func TestVerifyCodeRejectsPersonalCodeForUnlistedEmail(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	t.Setenv("APP_ENV", "")
	t.Setenv(devVerificationCodeEnv, "")
	t.Setenv(personalVerificationCodesEnv, "alice@personal.test:"+personalTestCode)

	const email = "bob@personal.test"
	ctx := context.Background()
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM verification_code WHERE email = $1`, email)
	})

	w, req := verifyCodeRequest(t, email, personalTestCode)
	testHandler.VerifyCode(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unlisted email using another email's personal code: expected 400, got %d: %s", w.Code, w.Body.String())
	}
}

// A listed email with the wrong code must fall through to the DB path and fail.
func TestVerifyCodeRejectsWrongPersonalCode(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	t.Setenv("APP_ENV", "")
	t.Setenv(devVerificationCodeEnv, "")
	t.Setenv(personalVerificationCodesEnv, "carol@personal.test:"+personalTestCode)

	const email = "carol@personal.test"
	ctx := context.Background()
	t.Cleanup(func() {
		_, _ = testPool.Exec(ctx, `DELETE FROM verification_code WHERE email = $1`, email)
	})

	w, req := verifyCodeRequest(t, email, "999999")
	testHandler.VerifyCode(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("listed email with wrong personal code: expected 400, got %d: %s", w.Code, w.Body.String())
	}
}
