# Star account sign-in for BayClaw

This optional integration makes a standard OIDC provider the Star (星舵) account
entry point. It does not make BayClaw or OpenClaw an identity issuer. Existing
Multica users, workspace membership, roles, browser sessions, CLI consent and
personal access tokens remain the authority for Multica access.

## Configure the relying party

1. Deploy a maintained OIDC provider, for example Keycloak, with authorization
   code flow and PKCE S256. Register a confidential client for BayClaw with one
   exact redirect URI: `<APP_URL>/auth/star/callback`.
2. Obtain the provider's immutable `sub` and the existing Multica user's UUID.
   Verify the account owner before linking them. An email address is not a link.
3. Store the configuration below in an absolute, owner-only regular file
   (mode `0600`, not a symlink). Generate a random 32-byte base64 cookie key and
   use the provider's client secret. Do not put these values in Git, skills,
   prompts, public configuration, screenshots or logs.
4. Set `MULTICA_STAR_OIDC_CONFIG` to that file path and restart the backend.
   The callback origin must equal `APP_URL`. Keep `FRONTEND_ORIGIN` aligned with
   the browser-facing scheme so the existing session cookie uses the right
   Secure policy. Forward `/auth/*` to the API using the existing web rewrites.

```json
{
  "issuer": "https://accounts.example.com/realms/star",
  "clientId": "bayclaw",
  "clientSecret": "REPLACE_WITH_PRIVATE_CLIENT_SECRET",
  "redirectUri": "https://bayclaw.example.com/auth/star/callback",
  "cookieKey": "REPLACE_WITH_BASE64_OF_32_RANDOM_BYTES",
  "subjects": {
    "REPLACE_WITH_IMMUTABLE_PROVIDER_SUBJECT": "11111111-1111-4111-8111-111111111111"
  },
  "allowLoopbackHttp": false
}
```

The example UUID is a placeholder, not an account to create. Changes to the
mapping require a backend restart. A failed provider/configuration load keeps
the Star entry visible but returns an unavailable error; it never authenticates
without verification. Unconfigured instances retain the previous login page.

Same-Mac deployment does not require a public domain. For an entirely loopback
test or local deployment, explicitly set `allowLoopbackHttp: true` and use
loopback issuer/callback URLs. Use a consistent host spelling: `localhost` and
`127.0.0.1` have separate browser cookies. HTTP on LAN IPs is rejected by this
OIDC client. `MULTICA_BIND_HOST=127.0.0.1` confines the API to the local machine;
its existing default remains unchanged when the variable is unset. An API that
must be accessed across a network belongs behind the deployment's trusted TLS
entry point.

## What sign-in does

The browser follows the provider's code flow. The relying party verifies the
signature, issuer, audience, expiry, nonce, browser state and PKCE verifier.
The temporary browser transaction is encrypted and expires in five minutes.
Only a subject explicitly mapped to an existing native user receives the
ordinary Multica session. No user, workspace, role or membership is created.

A verified but unlinked/disabled account clears any older Multica browser
session and returns an actionable login error. Unverified requests cannot
establish a session. The account's existing workspace membership determines
access after successful login.

Star is the primary button when configured. Existing native methods remain
under “Other sign-in options” during the staged rollout. This is not an
SSO-enforcement switch. Removing an OIDC link alone does not prohibit an
otherwise enabled native login method.

## CLI, cockpit and skills

An ordinary local user's `multica login` keeps the native browser consent flow.
Select Star sign-in in that browser, verify the account, then authorize the CLI.
Its callback and state survive the OIDC round trip; the CLI receives and stores
its own native Multica credential. It never receives the provider's password,
client secret, ID token or refresh token. The success page removes the transient
callback query and sends no-store/no-referrer headers.

Use a named native CLI profile for each deployment and select the intended
workspace. Check `multica workspace list --output json` and the workspace's
membership before writes. The cockpit skill uses this same CLI context; it
needs no cockpit token. Projects and file operations still obey native
workspace and resource permissions.

Inside a daemon-managed task, keep the injected task identity. `multica login`
is intentionally unavailable there. Do not unset the task context, inject a
personal token or switch HOME to bypass that boundary. Third-party services
called by skills (for example messaging services) retain their own native
authorization; this integration does not convert a Star session into their
credentials.

## Session lifetime, rollback and acceptance

SSO sign-in does not imply single logout. The identity provider session,
Multica browser session and CLI PAT have their existing independent lifetimes.
Logging out of the provider or browser does not revoke a previously authorized
CLI PAT. Use native user-disable/token-revoke controls when terminating access;
changing the mapping is not a substitute. Federated logout and immediate
provider-side revocation propagation are not implemented in this change.

Before enabling a real account, test in an independent database/provider realm:
successful browser and CLI login, immutable identity mapping, unlinked/disabled
accounts, bad/expired/replayed proofs, workspace denial, native logout and PAT
revocation. Verify the old CLI profile and existing workspace memberships are
unchanged. Desktop wiring uses the existing browser/deep-link handoff; validate
an installed desktop binary separately before claiming desktop acceptance.

Rollback: remove `MULTICA_STAR_OIDC_CONFIG` and restart the backend. This hides
the Star entry and leaves existing native accounts/data untouched. Already
issued native sessions/PATs remain valid according to native policy; revoke
them explicitly if rollback is intended to terminate access.

## OpenClaw boundary

OpenClaw must use its own supported trusted-proxy/device authorization. Do not
share a Multica PAT or Star ID token as a Gateway token. Use a maintained OIDC
proxy, overwrite identity headers, restrict the allowed subject before all
upstream routes, and map identity scopes in native configuration. Default to
manual pairing and least privilege; do not auto-grant admin.

The pinned OpenClaw 2026.9.8 build checked on 2026-10-16 rejects forwarded loopback
client addresses with `proxy_attribution_required`, even when the same-host
proxy peer is trusted. This integration does not change that behavior. A
`localhost` front proxy is therefore not yet an accepted OpenClaw SSO path on
that build. Use a genuinely attributed client address and a trusted HTTPS
entry (which can be private/local), or validate an upstream-supported fix.
Never fabricate the forwarded IP, strip provenance to bypass the check, or
disable native device/permission checks. Keep the current Gateway deployment
until the complete browser/WebSocket/permissions flow passes independently.

The same attribution rule is present in the official
[2026.10.4 source](https://github.com/openclaw/openclaw/blob/v2026.10.4/src/gateway/ingress-attribution.ts);
an upgrade alone has not been established as a fix.
