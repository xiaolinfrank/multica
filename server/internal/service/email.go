package service

import (
	"bytes"
	"crypto/tls"
	"embed"
	"encoding/base64"
	"fmt"
	"html"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/smtp"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/resend/resend-go/v2"
	"golang.org/x/net/proxy"
	// Embed the timezone database so Asia/Shanghai (used for email display
	// times and the digest schedule) loads even on hosts without system
	// tzdata (bare containers, stripped macOS).
	_ "time/tzdata"
)

//go:embed assets/bayclaw_mascot_email.png
var bayclawMascotEmailFS embed.FS

//go:embed assets/fosun_pharma_gba_hq_email.png
var fosunLogoEmailFS embed.FS

// maxSubjectFieldRunes bounds how much user-controlled text (workspace name,
// inviter name) can land in an email Subject. Prevents attackers from stuffing
// a full phishing pitch into a workspace name that gets sent from our domain.
const maxSubjectFieldRunes = 60

type EmailService struct {
	client          *resend.Client
	fromEmail       string
	smtpHost        string
	smtpPort        string
	smtpUsername    string
	smtpPassword    string
	smtpTLSInsecure bool
	smtpTLSImplicit bool
	smtpEHLOName    string
}

type smtpAuthClient interface {
	Auth(smtp.Auth) error
	Extension(string) (bool, string)
}

type smtpClientAdapter struct {
	client *smtp.Client
}

func (a smtpClientAdapter) Auth(auth smtp.Auth) error {
	return a.client.Auth(auth)
}

func (a smtpClientAdapter) Extension(name string) (bool, string) {
	return a.client.Extension(name)
}

func isLocalhost(name string) bool {
	return name == "localhost" || name == "127.0.0.1" || name == "::1"
}

type loginAuth struct {
	username string
	password string
	host     string
}

func (a *loginAuth) Start(server *smtp.ServerInfo) (string, []byte, error) {
	if !server.TLS && !isLocalhost(server.Name) {
		return "", nil, fmt.Errorf("unencrypted connection")
	}
	if server.Name != a.host {
		return "", nil, fmt.Errorf("wrong host name: %q does not match expected %q", server.Name, a.host)
	}
	return "LOGIN", nil, nil
}

func (a *loginAuth) Next(fromServer []byte, more bool) ([]byte, error) {
	if !more {
		return nil, nil
	}

	raw := strings.TrimSpace(string(fromServer))
	challenge := strings.ToLower(raw)
	if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil {
		challenge = strings.ToLower(strings.TrimSpace(string(decoded)))
	}

	switch {
	case strings.Contains(challenge, "username") || strings.Contains(challenge, "user name"):
		return []byte(a.username), nil
	case strings.Contains(challenge, "password"):
		return []byte(a.password), nil
	default:
		return nil, fmt.Errorf("unexpected LOGIN challenge %q", raw)
	}
}

func smtpAuthWithFallback(c smtpAuthClient, host, username, password string) (bool, error) {
	plainErr := c.Auth(smtp.PlainAuth("", username, password, host))
	if plainErr == nil {
		return false, nil
	}

	msg := strings.ToLower(plainErr.Error())
	if !strings.Contains(msg, "unrecognized authentication type") && !strings.Contains(msg, "504 5.7.4") {
		return false, plainErr
	}

	ok, authLine := c.Extension("AUTH")
	if !ok || !strings.Contains(strings.ToUpper(authLine), "LOGIN") {
		return false, plainErr
	}
	return true, plainErr
}

func resolveFromEmail(smtpHost string) string {
	resendFrom := strings.TrimSpace(os.Getenv("RESEND_FROM_EMAIL"))
	if smtpHost == "" {
		if resendFrom != "" {
			return resendFrom
		}
		return "noreply@multica.ai"
	}
	if smtpFrom := strings.TrimSpace(os.Getenv("SMTP_FROM_EMAIL")); smtpFrom != "" {
		return smtpFrom
	}
	return resendFrom
}

func (s *EmailService) openSMTPClient() (*smtp.Client, error) {
	addr := net.JoinHostPort(s.smtpHost, s.smtpPort)

	tlsCfg := &tls.Config{
		ServerName:         s.smtpHost,
		InsecureSkipVerify: s.smtpTLSInsecure, //nolint:gosec // opt-in via SMTP_TLS_INSECURE=true
	}

	// Route the SMTP connection through an egress proxy when one is configured
	// via the standard proxy env vars (ALL_PROXY/HTTPS_PROXY/HTTP_PROXY, any
	// case; socks5:// is supported). This lets the relay be reached from a host
	// that has no direct internet egress. When no proxy is set we keep the
	// original direct dial with a 10s connect timeout (proxy.FromEnvironment has
	// no connect timeout of its own, so we don't use it unconditionally).
	var conn net.Conn
	var err error
	if smtpProxyConfigured() {
		conn, err = proxy.FromEnvironment().Dial("tcp", addr)
	} else {
		conn, err = net.DialTimeout("tcp", addr, 10*time.Second)
	}
	if err != nil {
		return nil, fmt.Errorf("smtp dial %s: %w", addr, err)
	}
	if err = conn.SetDeadline(time.Now().Add(30 * time.Second)); err != nil {
		conn.Close()
		return nil, fmt.Errorf("smtp set deadline: %w", err)
	}

	var c *smtp.Client
	if s.smtpTLSImplicit {
		// Implicit TLS: wrap the (possibly proxied) connection in TLS immediately.
		tlsConn := tls.Client(conn, tlsCfg)
		if err = tlsConn.Handshake(); err != nil {
			conn.Close()
			return nil, fmt.Errorf("smtp implicit tls handshake: %w", err)
		}
		c, err = smtp.NewClient(tlsConn, s.smtpHost)
	} else {
		c, err = smtp.NewClient(conn, s.smtpHost)
	}
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("smtp client: %w", err)
	}

	if s.smtpEHLOName != "" {
		if err = c.Hello(s.smtpEHLOName); err != nil {
			c.Close()
			return nil, fmt.Errorf("smtp EHLO %s: %w", s.smtpEHLOName, err)
		}
	}

	if !s.smtpTLSImplicit {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err = c.StartTLS(tlsCfg); err != nil {
				c.Close()
				return nil, fmt.Errorf("smtp starttls: %w", err)
			}
		}
	}

	return c, nil
}

// smtpProxyConfigured reports whether an egress proxy is set via the standard
// proxy environment variables. We only route the SMTP dial through
// proxy.FromEnvironment when one is actually present, so deployments without a
// proxy keep the direct 10s connect timeout.
func smtpProxyConfigured() bool {
	for _, k := range []string{"ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
		if strings.TrimSpace(os.Getenv(k)) != "" {
			return true
		}
	}
	return false
}

func NewEmailService() *EmailService {
	apiKey := os.Getenv("RESEND_API_KEY")
	smtpHost := strings.TrimSpace(os.Getenv("SMTP_HOST"))
	smtpPort := strings.TrimSpace(os.Getenv("SMTP_PORT"))
	if smtpPort == "" {
		smtpPort = "25"
	}
	smtpUsername := os.Getenv("SMTP_USERNAME")
	smtpPassword := os.Getenv("SMTP_PASSWORD")
	smtpTLSInsecure := os.Getenv("SMTP_TLS_INSECURE") == "true"
	from := resolveFromEmail(smtpHost)

	// EHLO/HELO name, only relevant on the SMTP relay send path. net/smtp defaults
	// to "localhost", which strict relays (e.g. smtp-relay.gmail.com) reject from a
	// public source. Fall back to the machine hostname when SMTP_EHLO_NAME is unset.
	// Resolved only in SMTP mode so the Resend/DEV paths never touch os.Hostname()
	// or emit its failure log.
	var smtpEHLOName string
	if smtpHost != "" {
		smtpEHLOName = strings.TrimSpace(os.Getenv("SMTP_EHLO_NAME"))
		if smtpEHLOName == "" {
			hostname, hostErr := os.Hostname()
			if hostErr != nil {
				// Empty name makes sendSMTP skip Hello() and fall back to net/smtp's
				// lazy "localhost" — which strict relays reject. Surface it so operators
				// know to set SMTP_EHLO_NAME explicitly.
				fmt.Printf("EmailService: os.Hostname() failed (%v); SMTP EHLO falls back to \"localhost\" — set SMTP_EHLO_NAME for strict relays\n", hostErr)
			}
			smtpEHLOName = hostname
		}
	}

	// SMTP_TLS=implicit forces an immediate TLS handshake on connect (SMTPS).
	// Required by providers like Aliyun enterprise mail that only offer port 465
	// SSL and do not advertise STARTTLS. Default (empty / "starttls") preserves
	// the prior STARTTLS-upgrade behavior.
	smtpTLSMode := strings.ToLower(strings.TrimSpace(os.Getenv("SMTP_TLS")))
	smtpTLSImplicit := smtpTLSMode == "implicit" || smtpTLSMode == "smtps" || smtpTLSMode == "ssl"
	if smtpTLSMode == "" && smtpPort == "465" {
		smtpTLSImplicit = true
	}
	if smtpTLSMode != "" && !smtpTLSImplicit && smtpTLSMode != "starttls" {
		fmt.Printf("EmailService: SMTP_TLS=%q not recognized, falling back to starttls\n", smtpTLSMode)
	}

	var client *resend.Client
	if apiKey != "" {
		client = resend.NewClient(apiKey)
	}

	switch {
	case smtpHost != "":
		tlsLabel := "starttls"
		if smtpTLSImplicit {
			tlsLabel = "implicit-tls"
		}
		fmt.Printf("EmailService: SMTP relay %s:%s (%s) from=%s\n", smtpHost, smtpPort, tlsLabel, from)
	case client != nil:
		fmt.Printf("EmailService: Resend API from=%s\n", from)
	default:
		fmt.Println("EmailService: DEV mode — codes printed to stdout (set MULTICA_DEV_VERIFICATION_CODE in .env for a fixed local code)")
	}

	return &EmailService{
		client:          client,
		fromEmail:       from,
		smtpHost:        smtpHost,
		smtpPort:        smtpPort,
		smtpUsername:    smtpUsername,
		smtpPassword:    smtpPassword,
		smtpTLSInsecure: smtpTLSInsecure,
		smtpTLSImplicit: smtpTLSImplicit,
		smtpEHLOName:    smtpEHLOName,
	}
}

// sendOpt carries optional overrides for a single sendSMTP call.
type sendOpt struct {
	fromName string
	inline   []inlineImage
}

// inlineImage is an inline (CID) attachment referenced from the HTML body via
// cid:<cid>, so messages render without external image hosting — important for
// intranet-only deployments where no public image CDN is reachable.
type inlineImage struct {
	cid   string
	data  []byte
	ctype string
}

// sendSMTP delivers an HTML email via an SMTP server.
// Supports unauthenticated relay (SMTP_USERNAME empty) and authenticated SMTP.
// Upgrades to STARTTLS when advertised by the server.
// Set SMTP_TLS_INSECURE=true for self-signed or private CA certificates.
// Optional sendOpt values set a sender display name (RFC 2047 encoded) and/or
// inline CID images; both default off so existing callers are unaffected.
func (s *EmailService) sendSMTP(to, subject, htmlBody string, opts ...sendOpt) error {
	if strings.TrimSpace(s.fromEmail) == "" {
		return fmt.Errorf("SMTP_FROM_EMAIL or RESEND_FROM_EMAIL is required when SMTP_HOST is set")
	}

	c, err := s.openSMTPClient()
	if err != nil {
		return err
	}
	defer c.Close()

	if s.smtpUsername != "" {
		fallbackToLogin, authErr := smtpAuthWithFallback(smtpClientAdapter{client: c}, s.smtpHost, s.smtpUsername, s.smtpPassword)
		if authErr != nil {
			if !fallbackToLogin {
				return fmt.Errorf("smtp auth: %w", authErr)
			}

			c.Close()
			c, err = s.openSMTPClient()
			if err != nil {
				return fmt.Errorf("smtp auth: plain auth failed (%v); login reconnect failed: %w", authErr, err)
			}
			defer c.Close()

			if err = c.Auth(&loginAuth{username: s.smtpUsername, password: s.smtpPassword, host: s.smtpHost}); err != nil {
				return fmt.Errorf("smtp auth: plain auth failed (%v); login auth fallback failed: %w", authErr, err)
			}
		}
	}

	// Probe 8BITMIME after (possible) STARTTLS so the extension list is current.
	// Use quoted-printable for relays that don't advertise 8BITMIME — safer for
	// non-ASCII workspace/inviter names crossing strict or older SMTP hops.
	has8Bit, _ := c.Extension("8BITMIME")
	encodedSubject := mime.QEncoding.Encode("utf-8", subject)
	msgID := fmt.Sprintf("<%d@%s>", time.Now().UnixNano(), s.smtpHost)

	// Optional overrides: sender display name (RFC 2047 encoded) and inline CID images.
	fromName := ""
	var inline []inlineImage
	for _, o := range opts {
		if o.fromName != "" {
			fromName = o.fromName
		}
		inline = append(inline, o.inline...)
	}
	fromHeader := s.fromEmail
	if fromName != "" {
		fromHeader = mime.QEncoding.Encode("utf-8", fromName) + " <" + s.fromEmail + ">"
	}

	var msg bytes.Buffer
	fmt.Fprintf(&msg, "From: %s\r\n", fromHeader)
	fmt.Fprintf(&msg, "To: %s\r\n", to)
	fmt.Fprintf(&msg, "Subject: %s\r\n", encodedSubject)
	fmt.Fprintf(&msg, "Date: %s\r\n", time.Now().UTC().Format(time.RFC1123Z))
	fmt.Fprintf(&msg, "Message-ID: %s\r\n", msgID)
	fmt.Fprintf(&msg, "MIME-Version: 1.0\r\n")

	if len(inline) == 0 {
		cte := "8bit"
		body := []byte(htmlBody)
		if !has8Bit {
			var buf bytes.Buffer
			qpw := quotedprintable.NewWriter(&buf)
			_, _ = qpw.Write([]byte(htmlBody))
			_ = qpw.Close()
			body = buf.Bytes()
			cte = "quoted-printable"
		}
		fmt.Fprintf(&msg, "Content-Type: text/html; charset=UTF-8\r\n")
		fmt.Fprintf(&msg, "Content-Transfer-Encoding: %s\r\n", cte)
		fmt.Fprintf(&msg, "\r\n")
		msg.Write(body)
	} else {
		boundary := fmt.Sprintf("bayclaw-related-%d", time.Now().UnixNano())
		fmt.Fprintf(&msg, "Content-Type: multipart/related; boundary=%s\r\n", boundary)
		fmt.Fprintf(&msg, "\r\n")
		// HTML body part.
		fmt.Fprintf(&msg, "--%s\r\n", boundary)
		fmt.Fprintf(&msg, "Content-Type: text/html; charset=UTF-8\r\n")
		fmt.Fprintf(&msg, "Content-Transfer-Encoding: quoted-printable\r\n")
		fmt.Fprintf(&msg, "\r\n")
		var hbuf bytes.Buffer
		qpw := quotedprintable.NewWriter(&hbuf)
		_, _ = qpw.Write([]byte(htmlBody))
		_ = qpw.Close()
		msg.Write(hbuf.Bytes())
		// Inline images referenced via cid: in the HTML.
		for _, img := range inline {
			fmt.Fprintf(&msg, "\r\n--%s\r\n", boundary)
			fmt.Fprintf(&msg, "Content-Type: %s\r\n", img.ctype)
			fmt.Fprintf(&msg, "Content-Transfer-Encoding: base64\r\n")
			fmt.Fprintf(&msg, "Content-ID: <%s>\r\n", img.cid)
			fmt.Fprintf(&msg, "Content-Disposition: inline\r\n")
			fmt.Fprintf(&msg, "\r\n")
			enc := base64.StdEncoding.EncodeToString(img.data)
			for i := 0; i < len(enc); i += 76 {
				end := i + 76
				if end > len(enc) {
					end = len(enc)
				}
				msg.WriteString(enc[i:end] + "\r\n")
			}
		}
		fmt.Fprintf(&msg, "\r\n--%s--\r\n", boundary)
	}

	if err = c.Mail(s.fromEmail); err != nil {
		return fmt.Errorf("smtp MAIL FROM: %w", err)
	}
	if err = c.Rcpt(to); err != nil {
		return fmt.Errorf("smtp RCPT TO <%s>: %w", to, err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("smtp DATA: %w", err)
	}
	if _, err = w.Write(msg.Bytes()); err != nil {
		return fmt.Errorf("smtp write body: %w", err)
	}
	if err = w.Close(); err != nil {
		return fmt.Errorf("smtp end data: %w", err)
	}
	return c.Quit()
}

// SendVerificationCode sends a one-time login code. The code is server-generated
// (6-digit numeric) so no user-controlled text reaches the email body here.
// Delivery priority: SMTP relay → Resend API → DEV stdout.
func (s *EmailService) SendVerificationCode(to, code string) error {
	body := fmt.Sprintf(
		`<div style="font-family: sans-serif; max-width: 400px; margin: 0 auto;">
			<h2>Your verification code</h2>
			<p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; margin: 24px 0;">%s</p>
			<p>This code expires in 10 minutes.</p>
			<p style="color: #666; font-size: 14px;">If you didn't request this code, you can safely ignore this email.</p>
		</div>`, code)

	if s.smtpHost != "" {
		return s.sendSMTP(to, "Your Multica verification code", body)
	}
	if s.client == nil {
		fmt.Printf("[DEV] Verification code for %s: %s\n", to, code)
		return nil
	}
	params := &resend.SendEmailRequest{
		From:    s.fromEmail,
		To:      []string{to},
		Subject: "Your Multica verification code",
		Html:    body,
	}
	_, err := s.client.Emails.Send(params)
	return err
}

// SendWelcomeEmail sends a branded BayClaw onboarding email that includes the
// recipient's personal login verification code. The mascot and the 复星医药大湾区总部
// (Fosun Pharma GBA HQ) logo are embedded directly as data: URIs inside the HTML
// body — NOT as CID attachments — so the message is self-contained (the
// deployment is intranet-only, there is no public image host) and carries no
// inline-image parts that Outlook turns into "Insert 01 / Insert 02" attachment
// chips. The layout keeps the "big mascot" header the user liked: a teal→blue
// gradient band where the mascot is the full-width hero (centered, on its own
// row) with the BayClaw wordmark below it. The Fosun logo sits at the very
// bottom of the email (centered, inside the footer band below the copyright
// line). Delivery priority: SMTP relay → Resend → DEV.
func (s *EmailService) SendWelcomeEmail(to, code string, permanent bool) error {
	appURL := strings.TrimSpace(os.Getenv("FRONTEND_ORIGIN"))
	if appURL == "" {
		appURL = "http://10.35.178.181:13000"
	}
	fromName := "复星医药大湾区总部 · BayClaw"
	subject := "欢迎加入 BayClaw · 你的专属登录验证码"

	// Inline the brand images as data: URIs (see doc comment). Keeps the email
	// self-contained and avoids Outlook's CID attachment-chip behaviour.
	mascot, err := bayclawMascotEmailFS.ReadFile("assets/bayclaw_mascot_email.png")
	if err != nil {
		return fmt.Errorf("read BayClaw mascot: %w", err)
	}
	logo, err := fosunLogoEmailFS.ReadFile("assets/fosun_pharma_gba_hq_email.png")
	if err != nil {
		return fmt.Errorf("read Fosun GBA HQ logo: %w", err)
	}
	mascotURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(mascot)
	logoURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(logo)

	// Mascot rendered as a centered rounded "badge" on the gradient header.
	// The mascot PNG ships with its own light backdrop, so instead of stripping
	// the background we crop it into a large-radius rounded tile and lift it
	// with a soft layered shadow — the built-in backdrop reads as the badge's
	// canvas. The BayClaw wordmark sits below it on the gradient band; the
	// Fosun logo is in the footer. Both images are data: URIs, so the message
	// carries no inline-image parts that Outlook could turn into "Insert 01"
	// attachment chips.

	// Permanent personal codes (MULTICA_PERSONAL_CODES) are reusable and never
	// expire, so the callout copy must not claim a 10-minute window.
	codeHint := "验证码 10 分钟内有效，请尽快登录"
	if permanent {
		codeHint = "你的专属永久验证码，长期有效，可重复登录使用"
	}

	html := fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;">
  <table width="100%%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.08);">
        <tr><td style="background:linear-gradient(135deg,#0ea5a4 0%%,#0d6efd 100%%);padding:42px 40px 34px;text-align:center;">
          <img src="%s" alt="BayClaw" width="320" height="320" style="display:block;margin:0 auto 22px;width:320px;height:320px;border-radius:42px;box-shadow:0 18px 44px rgba(0,0,0,0.25),0 6px 14px rgba(0,0,0,0.14);"/>
          <div style="color:#fff;font-size:30px;font-weight:800;letter-spacing:0.5px;">BayClaw</div>
          <div style="color:rgba(255,255,255,0.88);font-size:13px;margin-top:4px;">复星医药大湾区 · 智能体工作平台</div>
        </td></tr>
        <tr><td style="padding:34px 40px 8px;">
          <h1 style="margin:0 0 8px;font-size:22px;color:#102a43;">欢迎加入 BayClaw 👋</h1>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#486581;">你好，这是你的专属工作平台登录凭证。使用下方验证码即可在 BayClaw 完成登录，开启你的智能体协作之旅。</p>
          <table width="100%%" cellpadding="0" cellspacing="0"><tr><td style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:12px;padding:22px;text-align:center;">
            <div style="font-size:12px;color:#0f766e;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">个人专属登录验证码</div>
            <div style="font-size:34px;font-weight:800;letter-spacing:10px;color:#0f172a;font-family:'SF Mono',Menlo,Consolas,monospace;">%s</div>
            <div style="font-size:12px;color:#64748b;margin-top:10px;">%s</div>
          </td></tr></table>
          <table width="100%%" cellpadding="0" cellspacing="0" style="margin-top:24px;"><tr><td align="center">
            <a href="%s" style="display:inline-block;padding:14px 36px;background:#0d6efd;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;">打开 BayClaw 工作台</a>
          </td></tr></table>
          <p style="font-size:13px;line-height:1.7;color:#64748b;margin-top:18px;">工作台地址：<a href="%s" style="color:#0d6efd;text-decoration:none;">%s</a><br/>（仅限复星医药大湾区总部办公室内网访问）</p>
        </td></tr>
        <tr><td style="padding:20px 40px 26px;border-top:1px solid #eef2f5;">
          <p style="margin:0 0 16px;font-size:12px;line-height:1.6;color:#94a3b8;">本邮件由系统自动发送，包含你的个人登录凭证，请勿转发他人。<br/>如需停用邮件通知，可在 BayClaw 通知设置中关闭。© 复星医药大湾区 BayClaw</p>
          <div align="center" style="padding-top:16px;border-top:1px solid #eef2f5;"><img src="%s" alt="复星医药大湾区总部" width="200" height="69" style="display:inline-block;width:200px;height:auto;"/></div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`, mascotURI, code, appURL, appURL, appURL, codeHint, logoURI)

	if s.smtpHost != "" {
		return s.sendSMTP(to, subject, html, sendOpt{fromName: fromName})
	}
	if s.client == nil {
		fmt.Printf("[DEV] BayClaw welcome email to %s (code=%s, url=%s)\n", to, code, appURL)
		return nil
	}
	_, err = s.client.Emails.Send(&resend.SendEmailRequest{
		From:    s.fromEmail,
		To:      []string{to},
		Subject: subject,
		Html:    html,
	})
	return err
}

// SendInvitationEmail notifies the invitee that they have been invited to a workspace.
// invitationID is included in the URL so the email deep-links to /invite/{id}.
func (s *EmailService) SendInvitationEmail(to, inviterName, workspaceName, invitationID string) error {
	appURL := strings.TrimSpace(os.Getenv("FRONTEND_ORIGIN"))
	if appURL == "" {
		appURL = "https://multica.ai"
	}
	inviteURL := fmt.Sprintf("%s/invite/%s", appURL, invitationID)

	if s.smtpHost != "" {
		params := buildInvitationParams(s.fromEmail, to, inviterName, workspaceName, inviteURL)
		return s.sendSMTP(to, params.Subject, params.Html)
	}
	if s.client == nil {
		fmt.Printf("[DEV] Invitation email to %s: %s invited you to %s — %s\n", to, inviterName, workspaceName, inviteURL)
		return nil
	}
	params := buildInvitationParams(s.fromEmail, to, inviterName, workspaceName, inviteURL)
	_, err := s.client.Emails.Send(params)
	return err
}

// buildInvitationParams assembles the email request for an invitation.
// Separated from SendInvitationEmail so the sanitization behavior is unit-testable
// without needing to mock the Resend SDK or an SMTP server.
func buildInvitationParams(from, to, inviterName, workspaceName, inviteURL string) *resend.SendEmailRequest {
	safeWorkspace := html.EscapeString(workspaceName)
	safeInviter := html.EscapeString(inviterName)
	subjectInviter := sanitizeSubjectField(inviterName)
	subjectWorkspace := sanitizeSubjectField(workspaceName)

	return &resend.SendEmailRequest{
		From:    from,
		To:      []string{to},
		Subject: fmt.Sprintf("%s invited you to %s on Multica", subjectInviter, subjectWorkspace),
		Html: fmt.Sprintf(
			`<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
				<h2>You're invited to join %s</h2>
				<p><strong>%s</strong> invited you to collaborate in the <strong>%s</strong> workspace on Multica.</p>
				<p style="margin: 24px 0;">
					<a href="%s" style="display: inline-block; padding: 12px 24px; background: #000; color: #fff; text-decoration: none; border-radius: 6px; font-weight: 500;">Accept invitation</a>
				</p>
				<p style="color: #666; font-size: 14px;">You'll need to log in to accept or decline the invitation.</p>
			</div>`, safeWorkspace, safeInviter, safeWorkspace, inviteURL),
	}
}

// sanitizeSubjectField prepares user-controlled text for the email Subject line.
// Subject is not HTML-rendered, so HTML-escaping would leak literal entities
// (e.g. &lt;script&gt;) into the recipient's inbox. Instead strip control
// characters (defense in depth against header-injection-adjacent abuse even
// though Resend also filters CR/LF) and cap length so attackers can't stuff
// a full phishing subject into a workspace name.
func sanitizeSubjectField(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
	}
	cleaned := b.String()
	if utf8.RuneCountInString(cleaned) <= maxSubjectFieldRunes {
		return cleaned
	}
	runes := []rune(cleaned)
	return string(runes[:maxSubjectFieldRunes-1]) + "…"
}

// InboxEmailInput is the minimal, already-validated data needed to render an
// inbox-forward email. All fields are treated as untrusted (workspace name and
// inbox title/body are user-controlled), so SendInboxItemEmail escapes them.
type InboxEmailInput struct {
	WorkspaceName string
	Title         string
	Body          string
	Type          string
	DeepLink      string
}

// inboxTypeLabel maps an internal inbox item type to a friendly, on-brand
// Chinese label for the notification pill. Covers both the concrete DB types
// emitted by cmd/server/notification_listeners.go (issue_assigned, new_comment,
// status_changed, …) and the looser aliases earlier templates accepted.
// Unknown/empty types fall back to a neutral "新通知" so the email always
// renders a sensible chip.
func inboxTypeLabel(t string) string {
	switch strings.ToLower(strings.TrimSpace(t)) {
	case "mention", "mentioned", "at":
		return "提及"
	case "comment", "reply", "new_comment":
		return "评论"
	case "assignment", "assigned", "assign", "issue_assigned":
		return "指派"
	case "unassigned":
		return "取消指派"
	case "assignee_changed":
		return "负责人变更"
	case "status_changed":
		return "状态变更"
	case "priority_changed":
		return "优先级变更"
	case "start_date_changed":
		return "开始日期变更"
	case "due_date_changed":
		return "截止日期变更"
	case "invite", "invitation":
		return "邀请"
	case "quick_create_done", "created", "done", "issue_created":
		return "创建完成"
	case "issue_subscribed", "subscribed":
		return "关注更新"
	case "task_completed":
		return "任务完成"
	case "task_failed":
		return "任务失败"
	case "agent_blocked":
		return "智能体受阻"
	case "agent_completed":
		return "智能体完成"
	case "reaction_added":
		return "收到回应"
	case "system":
		return "系统通知"
	case "due", "deadline":
		return "截止提醒"
	case "approval", "approve":
		return "待审批"
	default:
		return "新通知"
	}
}

// mentionLinkRe matches Multica's markdown mention syntax — either
// [@label](mention://type/id) for people/agents/squads or [label](mention://issue/id)
// for issues. In an email these resolve to a dead mention:// scheme that opens
// nothing when clicked, so we collapse them to the bare label (preserving any
// leading @) to avoid presenting useless, clickable links to the recipient.
var mentionLinkRe = regexp.MustCompile(`\[(@?.+?)\]\(mention://(?:member|agent|squad|issue|all|file)/[0-9a-fA-F-]+\)`)

// stripMentionLinks rewrites markdown mention links as plain-text labels.
func stripMentionLinks(s string) string {
	return mentionLinkRe.ReplaceAllString(s, "$1")
}

// SendInboxItemEmail forwards a single inbox notification to the recipient's
// registered email. It reuses the branded BayClaw shell from SendWelcomeEmail
// (gradient header with the 320px mascot badge, Fosun GBA-HQ logo in the
// footer) so inbox notifications read as first-class, on-brand messages rather
// than plain text. Delivery priority mirrors the other senders: SMTP relay →
// Resend API → DEV stdout. Workspace/title/body/type are user-controlled, so
// they are HTML-escaped and the subject is run through sanitizeSubjectField.
func (s *EmailService) SendInboxItemEmail(to string, in InboxEmailInput) error {
	appURL := strings.TrimSpace(os.Getenv("FRONTEND_ORIGIN"))
	if appURL == "" {
		appURL = "http://10.35.178.181:13000"
	}
	deepLink := in.DeepLink
	if deepLink == "" {
		deepLink = appURL + "/inbox"
	}

	// Brand images inlined as data: URIs (same approach as SendWelcomeEmail) so
	// the notification is self-contained and avoids Outlook CID attachment chips.
	mascot, err := bayclawMascotEmailFS.ReadFile("assets/bayclaw_mascot_email.png")
	if err != nil {
		return fmt.Errorf("read BayClaw mascot: %w", err)
	}
	logo, err := fosunLogoEmailFS.ReadFile("assets/fosun_pharma_gba_hq_email.png")
	if err != nil {
		return fmt.Errorf("read Fosun GBA HQ logo: %w", err)
	}
	mascotURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(mascot)
	logoURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(logo)

	// User-controlled fields are untrusted — escape everything that lands in HTML.
	// Mention links (mention://…) are dead in email, so collapse them to plain
	// @labels before escaping to avoid presenting useless, clickable links.
	wsName := html.EscapeString(in.WorkspaceName)
	safeTitle := html.EscapeString(stripMentionLinks(in.Title))
	safeBody := html.EscapeString(stripMentionLinks(in.Body))
	typeLabel := html.EscapeString(inboxTypeLabel(in.Type))

	subject := fmt.Sprintf("%s：%s",
		sanitizeSubjectField(in.WorkspaceName),
		sanitizeSubjectField(in.Title))

	bodyHTML := ""
	if safeBody != "" {
		bodyHTML = fmt.Sprintf(
			"<p style=\"margin:0 0 22px;font-size:15px;line-height:1.78;color:#486581;white-space:pre-wrap;\">%s</p>",
			safeBody)
	}

	fromName := "复星医药大湾区 · BayClaw"

	html := fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;">
  <table width="100%%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.08);">
        <tr><td style="background:linear-gradient(135deg,#0ea5a4 0%%,#0d6efd 100%%);padding:42px 40px 34px;text-align:center;">
          <img src="%s" alt="BayClaw" width="320" height="320" style="display:block;margin:0 auto 22px;width:320px;height:320px;border-radius:42px;box-shadow:0 18px 44px rgba(0,0,0,0.25),0 6px 14px rgba(0,0,0,0.14);"/>
          <div style="color:#fff;font-size:30px;font-weight:800;letter-spacing:0.5px;">BayClaw</div>
          <div style="color:rgba(255,255,255,0.88);font-size:13px;margin-top:4px;">复星医药大湾区 · 智能体工作平台</div>
        </td></tr>
        <tr><td style="padding:34px 40px 8px;">
          <div style="display:inline-block;padding:6px 14px;border-radius:999px;background:#e0f2fe;color:#0369a1;font-size:12px;font-weight:700;letter-spacing:0.5px;margin-bottom:14px;">%s</div>
          <div style="font-size:13px;color:#94a3b8;margin-bottom:6px;">来自工作区 · %s</div>
          <h1 style="margin:0 0 16px;font-size:21px;color:#102a43;line-height:1.45;">%s</h1>
          %s
          <table width="100%%" cellpadding="0" cellspacing="0" style="margin-top:10px;"><tr><td align="center">
            <a href="%s" style="display:inline-block;padding:13px 30px;background:#0d6efd;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;margin:0 6px;">查看详情</a>
            <a href="%s" style="display:inline-block;padding:13px 30px;background:#fff;color:#0d6efd;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;border:1px solid #c7d2fe;margin:0 6px;">打开工作台</a>
          </td></tr></table>
          <p style="font-size:13px;line-height:1.7;color:#64748b;margin-top:18px;">工作台地址：<a href="%s" style="color:#0d6efd;text-decoration:none;">%s</a><br/>（仅限复星医药大湾区总部办公室内网访问）</p>
        </td></tr>
        <tr><td style="padding:20px 40px 26px;border-top:1px solid #eef2f5;">
          <p style="margin:0 0 16px;font-size:12px;line-height:1.6;color:#94a3b8;">本邮件由系统自动发送，包含你的工作区通知，请勿转发他人。<br/>如需停用邮件通知，可在 BayClaw 通知设置中关闭。© 复星医药大湾区 BayClaw</p>
          <div align="center" style="padding-top:16px;border-top:1px solid #eef2f5;"><img src="%s" alt="复星医药大湾区总部" width="200" height="69" style="display:inline-block;width:200px;height:auto;"/></div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`, mascotURI, typeLabel, wsName, safeTitle, bodyHTML, deepLink, appURL, appURL, appURL, logoURI)

	if s.smtpHost != "" {
		return s.sendSMTP(to, subject, html, sendOpt{fromName: fromName})
	}
	if s.client == nil {
		fmt.Printf("[DEV] Inbox email to %s: %s — %s\n", to, subject, deepLink)
		return nil
	}
	_, err = s.client.Emails.Send(&resend.SendEmailRequest{
		From:    s.fromEmail,
		To:      []string{to},
		Subject: subject,
		Html:    html,
	})
	return err
}

// bayclawDisplayTZ is the timezone used to render timestamps inside BayClaw
// emails. The deployment is Shanghai-only, so email display time is pinned to
// Asia/Shanghai regardless of the server's local TZ.
var bayclawDisplayTZ = func() *time.Location {
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		// Unreachable with the embedded tzdata; keep a sane fallback anyway.
		return time.UTC
	}
	return loc
}()

// inboxDigestMaxExcerptRunes bounds the single-line body excerpt shown under
// each digest item, so one verbose comment cannot blow up the email.
const inboxDigestMaxExcerptRunes = 90

// InboxSummaryItem is one unread notification row in the daily digest. Type
// and Severity use the internal inbox_item values; the builder maps them to
// labels. Title/Body are user-controlled and escaped by the builder.
type InboxSummaryItem struct {
	Type      string
	Severity  string
	Title     string
	Body      string
	CreatedAt time.Time
}

// InboxSummarySection groups the digest items of one workspace. OverflowCount
// is how many further unread items exist beyond the Items cap; the caller
// decides the cap, the builder only renders the count.
type InboxSummarySection struct {
	WorkspaceName string
	InboxURL      string
	Items         []InboxSummaryItem
	OverflowCount int
}

// InboxSummaryEmailInput is the already-aggregated digest for one recipient.
// RecipientName and all Section text fields are user-controlled and are
// escaped by the builder. GeneratedAt is the digest's plan time (09:00
// Asia/Shanghai), shown in the header caption.
type InboxSummaryEmailInput struct {
	RecipientName string
	GeneratedAt   time.Time
	Sections      []InboxSummarySection
}

// TotalItems returns the unread-item count across all sections, including
// overflow. Used for the subject line and the headline.
func (in InboxSummaryEmailInput) TotalItems() int {
	n := 0
	for _, s := range in.Sections {
		n += len(s.Items) + s.OverflowCount
	}
	return n
}

// severityPillColors returns the pill background/foreground for an inbox
// severity. action_required reads amber-red so it pops out of the list;
// everything else stays in the calm blue family.
func severityPillColors(severity string) (bg, fg string) {
	switch severity {
	case "action_required":
		return "#fee2e2", "#b91c1c"
	case "attention":
		return "#ffedd5", "#c2410c"
	default:
		return "#e0f2fe", "#0369a1"
	}
}

// truncateRunes caps s at n runes, appending an ellipsis when truncated.
func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	runes := []rune(s)
	return string(runes[:n-1]) + "…"
}

// digestExcerpt prepares an inbox body for the one-line digest excerpt:
// mention links collapse to plain labels, whitespace runs become single
// spaces, and the result is capped. Escaping happens in the builder.
func digestExcerpt(body string) string {
	s := strings.Join(strings.Fields(stripMentionLinks(body)), " ")
	return truncateRunes(s, inboxDigestMaxExcerptRunes)
}

// buildInboxSummaryEmail renders the daily unread digest. Pure apart from
// reading the embedded brand images, so template behaviour is unit-testable
// without an SMTP/Resend mock. User-controlled text is HTML-escaped; mention
// links are collapsed to labels before escaping (same as the per-item email).
func buildInboxSummaryEmail(in InboxSummaryEmailInput) (subject, htmlOut string, err error) {
	appURL := strings.TrimSpace(os.Getenv("FRONTEND_ORIGIN"))
	if appURL == "" {
		appURL = "http://10.35.178.181:13000"
	}

	mascot, err := bayclawMascotEmailFS.ReadFile("assets/bayclaw_mascot_email.png")
	if err != nil {
		return "", "", fmt.Errorf("read BayClaw mascot: %w", err)
	}
	logo, err := fosunLogoEmailFS.ReadFile("assets/fosun_pharma_gba_hq_email.png")
	if err != nil {
		return "", "", fmt.Errorf("read Fosun GBA HQ logo: %w", err)
	}
	mascotURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(mascot)
	logoURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(logo)

	subject = fmt.Sprintf("BayClaw：你有 %d 条未读通知", in.TotalItems())

	name := strings.TrimSpace(in.RecipientName)
	if name == "" {
		name = "你好"
	} else {
		name = "你好，" + html.EscapeString(name)
	}

	generatedAt := ""
	if !in.GeneratedAt.IsZero() {
		generatedAt = " · 生成于 " + in.GeneratedAt.In(bayclawDisplayTZ).Format("2006-01-02 15:04")
	}

	// Sections are rendered in the order given (the caller sorts
	// newest-first); the primary CTA points at the first section's inbox.
	ctaURL := appURL
	if len(in.Sections) > 0 && in.Sections[0].InboxURL != "" {
		ctaURL = in.Sections[0].InboxURL
	}

	var sections strings.Builder
	for _, s := range in.Sections {
		wsName := html.EscapeString(s.WorkspaceName)
		unread := len(s.Items) + s.OverflowCount

		var items strings.Builder
		for _, it := range s.Items {
			bg, fg := severityPillColors(it.Severity)
			label := html.EscapeString(inboxTypeLabel(it.Type))
			title := html.EscapeString(stripMentionLinks(it.Title))
			when := it.CreatedAt.In(bayclawDisplayTZ).Format("01-02 15:04")

			excerpt := ""
			if ex := digestExcerpt(it.Body); ex != "" {
				excerpt = fmt.Sprintf(
					`<div style="font-size:13px;line-height:1.6;color:#64748b;margin-top:3px;">%s</div>`,
					html.EscapeString(ex))
			}

			fmt.Fprintf(&items, `
        <tr><td style="padding:12px 0;border-top:1px solid #f1f5f9;">
          <table width="100%%" cellpadding="0" cellspacing="0"><tr>
            <td style="vertical-align:top;">
              <div style="margin-bottom:5px;"><span style="display:inline-block;padding:3px 10px;border-radius:999px;background:%s;color:%s;font-size:11px;font-weight:700;">%s</span></div>
              <div style="font-size:14px;font-weight:600;color:#102a43;line-height:1.5;">%s</div>
              %s
            </td>
            <td style="vertical-align:top;white-space:nowrap;text-align:right;padding-left:16px;font-size:12px;color:#94a3b8;padding-top:6px;">%s</td>
          </tr></table>
        </td></tr>`, bg, fg, label, title, excerpt, when)
		}

		overflow := ""
		if s.OverflowCount > 0 {
			overflow = fmt.Sprintf(
				`<tr><td style="padding:10px 0;border-top:1px solid #f1f5f9;font-size:13px;color:#64748b;">还有 %d 条未读，打开收件箱查看全部</td></tr>`,
				s.OverflowCount)
		}

		fmt.Fprintf(&sections, `
      <tr><td style="padding:26px 40px 0;">
        <table width="100%%" cellpadding="0" cellspacing="0"><tr>
          <td style="font-size:15px;font-weight:700;color:#102a43;">%s <span style="font-size:12px;font-weight:600;color:#0369a1;background:#e0f2fe;border-radius:999px;padding:2px 10px;margin-left:6px;">%d 条未读</span></td>
          <td style="text-align:right;"><a href="%s" style="font-size:13px;color:#0d6efd;text-decoration:none;">查看收件箱 →</a></td>
        </tr></table>
        <table width="100%%" cellpadding="0" cellspacing="0" style="margin-top:6px;">
          %s%s
        </table>
      </td></tr>`, wsName, unread, s.InboxURL, items.String(), overflow)
	}

	htmlOut = fmt.Sprintf(`<!doctype html>
<html lang="zh-CN"><body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;">
  <table width="100%%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.08);">
        <tr><td style="background:linear-gradient(135deg,#0ea5a4 0%%,#0d6efd 100%%);padding:42px 40px 34px;text-align:center;">
          <img src="%s" alt="BayClaw" width="320" height="320" style="display:block;margin:0 auto 22px;width:320px;height:320px;border-radius:42px;box-shadow:0 18px 44px rgba(0,0,0,0.25),0 6px 14px rgba(0,0,0,0.14);"/>
          <div style="color:#fff;font-size:30px;font-weight:800;letter-spacing:0.5px;">BayClaw</div>
          <div style="color:rgba(255,255,255,0.88);font-size:13px;margin-top:4px;">复星医药大湾区 · 智能体工作平台</div>
        </td></tr>
        <tr><td style="padding:34px 40px 8px;">
          <div style="display:inline-block;padding:6px 14px;border-radius:999px;background:#e0f2fe;color:#0369a1;font-size:12px;font-weight:700;letter-spacing:0.5px;margin-bottom:14px;">未读摘要</div>
          <div style="font-size:13px;color:#94a3b8;margin-bottom:6px;">最近 7 天%s</div>
          <h1 style="margin:0 0 6px;font-size:21px;color:#102a43;line-height:1.45;">%s，过去一周你有 %d 条未读通知</h1>
          <p style="margin:0;font-size:14px;line-height:1.7;color:#486581;">以下是各工作区中等待你查看的通知，点击对应条目可直达收件箱处理。</p>
        </td></tr>
        %s
        <tr><td style="padding:26px 40px 8px;">
          <table width="100%%" cellpadding="0" cellspacing="0"><tr><td align="center">
            <a href="%s" style="display:inline-block;padding:13px 34px;background:#0d6efd;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;margin:0 6px;">打开收件箱</a>
            <a href="%s" style="display:inline-block;padding:13px 30px;background:#fff;color:#0d6efd;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;border:1px solid #c7d2fe;margin:0 6px;">打开工作台</a>
          </td></tr></table>
          <p style="font-size:13px;line-height:1.7;color:#64748b;margin-top:18px;">工作台地址：<a href="%s" style="color:#0d6efd;text-decoration:none;">%s</a><br/>（仅限复星医药大湾区总部办公室内网访问）</p>
        </td></tr>
        <tr><td style="padding:20px 40px 26px;border-top:1px solid #eef2f5;">
          <p style="margin:0 0 16px;font-size:12px;line-height:1.6;color:#94a3b8;">本邮件为每日未读摘要，由系统自动发送。<br/>如需停用邮件通知，可在 BayClaw 通知设置中关闭。© 复星医药大湾区 BayClaw</p>
          <div align="center" style="padding-top:16px;border-top:1px solid #eef2f5;"><img src="%s" alt="复星医药大湾区总部" width="200" height="69" style="display:inline-block;width:200px;height:auto;"/></div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`, mascotURI, generatedAt, name, in.TotalItems(), sections.String(), ctaURL, appURL, appURL, appURL, logoURI)

	return subject, htmlOut, nil
}

// SendInboxSummaryEmail delivers the daily unread-inbox digest for one
// recipient. It reuses the branded BayClaw shell (gradient header with the
// 320px mascot badge, Fosun GBA-HQ logo footer) like the other BayClaw
// senders. Delivery priority mirrors them: SMTP relay → Resend API → DEV
// stdout. All user-controlled fields are escaped inside the builder.
func (s *EmailService) SendInboxSummaryEmail(to string, in InboxSummaryEmailInput) error {
	subject, htmlBody, err := buildInboxSummaryEmail(in)
	if err != nil {
		return err
	}

	if s.smtpHost != "" {
		return s.sendSMTP(to, subject, htmlBody, sendOpt{fromName: "复星医药大湾区 · BayClaw"})
	}
	if s.client == nil {
		fmt.Printf("[DEV] Inbox summary email to %s: %s (%d sections)\n",
			to, subject, len(in.Sections))
		return nil
	}
	_, err = s.client.Emails.Send(&resend.SendEmailRequest{
		From:    s.fromEmail,
		To:      []string{to},
		Subject: subject,
		Html:    htmlBody,
	})
	return err
}
