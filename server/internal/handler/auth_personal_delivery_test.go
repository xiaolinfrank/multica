package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSendCodePersonalDeliveryNeverCallsMailer(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	const email = "personal-code-delivery@test.local"
	t.Setenv("APP_ENV", "local")
	t.Setenv(devVerificationCodeEnv, "")
	t.Setenv(personalVerificationCodesEnv, email+":583719")
	h := *testHandler
	h.cfg.AllowedEmails = []string{email}
	h.EmailService = nil // Reaching any mail delivery path must fail this test.
	_, err := testPool.Exec(context.Background(), "DELETE FROM verification_code WHERE email=$1", email)
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	h.SendCode(w, newRequest(http.MethodPost, "/auth/send-code", map[string]any{"email": email}))
	var body map[string]string
	if json.Unmarshal(w.Body.Bytes(), &body) != nil || w.Code != http.StatusOK || body["delivery"] != "personal" {
		t.Fatalf("unexpected personal code delivery response: %d", w.Code)
	}
	var count int
	if err := testPool.QueryRow(context.Background(), "SELECT COUNT(*) FROM verification_code WHERE email=$1", email).Scan(&count); err != nil || count != 0 {
		t.Fatal("personal login created an email OTP", err)
	}
}
