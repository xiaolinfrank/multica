package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestSendCode_CooldownSkippedInDevCodeMode guards the fixed-verification-
// code deployment contract: when MULTICA_DEV_VERIFICATION_CODE is active
// (non-production), SendCode delivers no email, so the per-email 60s resend
// cooldown must not fire — otherwise users who log out cannot log back in
// for a minute (logout consumes the previous code, forcing a fresh send).
// Without the dev code, the cooldown must keep protecting real email sends.
func TestSendCode_CooldownSkippedInDevCodeMode(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	const email = "cooldown-probe@test.local"
	cleanup := func() {
		_, _ = testPool.Exec(context.Background(), `DELETE FROM verification_code WHERE email = $1`, email)
		_, _ = testPool.Exec(context.Background(), `DELETE FROM "user" WHERE email = $1`, email)
	}
	cleanup()
	t.Cleanup(cleanup)

	sendCode := func() int {
		w := httptest.NewRecorder()
		req := newRequest("POST", "/auth/send-code", map[string]any{"email": email})
		testHandler.SendCode(w, req)
		return w.Code
	}

	t.Run("dev code active: back-to-back sends both succeed", func(t *testing.T) {
		t.Setenv("APP_ENV", "")
		t.Setenv(devVerificationCodeEnv, "831204")
		if code := sendCode(); code != http.StatusOK {
			t.Fatalf("first send: expected 200, got %d", code)
		}
		if code := sendCode(); code != http.StatusOK {
			t.Fatalf("second immediate send: expected 200 in dev-code mode, got %d", code)
		}
	})

	t.Run("dev code absent: second send within 60s is rejected", func(t *testing.T) {
		t.Setenv("APP_ENV", "")
		t.Setenv(devVerificationCodeEnv, "")
		// A code row already exists from the previous subtest (created just
		// now), so the very next send must hit the cooldown.
		if code := sendCode(); code != http.StatusTooManyRequests {
			t.Fatalf("expected 429 within cooldown window, got %d", code)
		}
	})

	t.Run("production ignores the dev code entirely", func(t *testing.T) {
		t.Setenv("APP_ENV", "production")
		t.Setenv(devVerificationCodeEnv, "831204")
		if code := sendCode(); code != http.StatusTooManyRequests {
			t.Fatalf("expected 429 in production despite dev code env, got %d", code)
		}
	})
}
