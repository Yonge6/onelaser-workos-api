# Grok Bot MCP OAuth Compatibility Implementation Plan

**Goal:** Make the existing two-tool MCP bridge usable by an OAuth-only Grok Bot client without exposing static worker credentials to chat or broadening task access.

**Architecture:** Add a small same-origin OAuth authorization server backed by the existing PostgreSQL adapter. A configured DingTalk manager explicitly consents in a server-rendered page; public clients exchange one-use PKCE codes for opaque, revocable, tenant/workspace-bound tokens. Preserve the current static bearer contract in an explicit compatibility mode, with no anonymous fallback or arbitrary client metadata fetches.

**Tech Stack:** Existing Node.js, Fastify, PostgreSQL/PGlite, crypto and Zod; no new dependencies.

The user has authorized implementation in this session. Do not commit, push, create paid infrastructure, access credentials or operate a real Bot while executing this plan.

## Decisions and public contract

- `GROK_BOT_MCP_AUTH_MODE=bearer|oauth`, code default `bearer` for compatibility; Render selects `oauth`.
- `GROK_BOT_OAUTH_REDIRECT_URIS` is an explicit list of exact callback URIs. HTTPS is supported; administrator-pinned exceptions are limited to the one exact native base `cursor://anysphere.cursor-mcp/oauth/callback` and literal `localhost`, `127.0.0.1`, or `[::1]` HTTP callbacks with fixed explicit ports and paths. No defaults, wildcards, fragments, credentials, hostname aliases or guesses. Missing list disables OAuth with safe setup status/503; malformed configured values fail safely. The original HTTPS-only plan was updated after the owner verified the official October 17–21 compatibility discussion.
- OAuth identity is the existing explicitly configured organization (`GROK_BOT_ORG_ID` or `DINGTALK_CORP_ID`). The issuer is the public origin. The protected resource/audience is the complete external `/api/integrations/grok-bot/mcp` URL.
- Publish root and path-specific RFC9728 metadata plus RFC8414 AS metadata. Caddy must forward these exact well-known paths instead of serving static files. Advertise only implemented endpoints, PKCE S256, authorization code/refresh, public clients and the single scope `workos.review`.
- DCR is a bounded compatibility mechanism, not permission: only exact configured redirects and public `token_endpoint_auth_method=none`; only code/refresh grants; ten registrations per organization/UTC hour and fifty retained dynamic clients. Unused dynamic clients older than one hour are reclaimed only if they have no grant history or valid pending request. No CIMD URL fetching. Dynamic client IDs are opaque local identifiers; optional `GROK_BOT_OAUTH_PRE_REGISTERED_CLIENT_ID` pins one exact HTTPS identifier to the local configured callbacks without downloading it. Unknown clients never cause a network request. Discovery explicitly does not advertise automatic CIMD support.
- External endpoints: `/api/integrations/grok-bot/oauth/register`, `/authorize`, `/requests/:requestId`, `/token`, `/revoke`, `/consent.css`; manager APIs `/api/integrations/grok-bot/oauth/grants` and `/grants/:id/revoke`.
- Authorization requests bind client, exact redirect (including any approved static query), state, S256 challenge, scope, resource and an HttpOnly browser nonce. All request IDs are opaque; no arbitrary `returnTo`.
- If login is needed, the consent page links to DingTalk with only its opaque pending request ID. Persist that controlled request reference in the existing nonce-bound DingTalk state, then resume only its fixed consent path after login. Never auto-consent.
- Consent requires an active same-organization manager, a real cookie session (never a Bot/business bearer token), session CSRF and exact Origin. HTML is escaped, no inline JavaScript or CSS; use same-origin external CSS and GET language/theme links with icons. A POST approval creates a grant and one-use 120-second code. Denial returns a safe OAuth error only to the previously validated redirect.
- Completion URLs use URL/URLSearchParams and include unchanged state and fixed `iss`; advertise `authorization_response_iss_parameter_supported:true`. Consent POST returns a same-origin completion page with an explicit Return to Bot anchor, preserving strict form-action CSP without scripts or cross-origin form redirects. Invalid redirect/client requests fail locally without redirecting.
- Tokens are high-entropy opaque values with a distinct prefix, stored only as SHA-256 digests. Suggested lifetimes: access 15 minutes, refresh/grant 30 days. Codes also store only digests. Exact client, redirect, verifier, audience and scope checks precede any issue/refresh.
- Refresh rotation is atomic. Reuse revokes its entire grant/family and all access tokens, including when two refresh requests race; the revocation must commit even though the replay response is an OAuth error.
- Manager deactivation, loss of manager role, organization/workspace change, explicit grant revoke or expiry invalidates every access/refresh immediately. Resolve access per MCP request and revalidate inside the job transaction before pickup/completion. Keep existing requester, task/version/hash, lease and evidence validation intact.
- Pending requests and grants bind a deterministic configuration policy hash. Changing the callback list or pinned client ID rejects old tokens under the current configuration. Restoring exactly the prior policy can make an unexpired, unrevoked grant usable again, still requiring the original manager's current eligibility; this is not a fresh authorization. Use explicit grant revoke for permanent revocation.
- OAuth tokens cannot authenticate business APIs; business cookies/sessions and static worker credentials cannot authenticate an OAuth-only MCP endpoint. Public metadata/register/token routes have purpose-built auth/validation, never development identity bypasses.
- OAuth discovery/consent/registration can be configured before the Routine webhook. Dispatch remains disabled until its own webhook settings are complete. OAuth mode does not require handing a static worker secret to the Bot.

## Task 1: Durable OAuth model and provider

**Files:** `src/db.ts`, new `src/integrations/grok-bot-oauth.ts`.

1. Add idempotent schema for clients, bounded DCR counters, pending browser requests, grants, code digests and rotating token digests. Extend DingTalk state only with a controlled pending request ID.
2. Implement strict environment validation and external URL builders; discovery metadata, bounded registration and safe OAuth error responses.
3. Implement nonce-bound pending requests, manager consent, code exchange, rotating refresh and revoke. Use transactions/locks; do not roll back family revocation when returning a replay error.

## Task 2: Consent surface and browser resume

**Files:** new `src/integrations/grok-bot-consent.ts`, `src/integrations/routes.ts`, `src/app.ts`.

1. Render bilingual light/dark server HTML with explicit Approve/Deny forms, escaped values, external CSS and no auto-approval.
2. Add narrowly scoped urlencoded handling and cookie/CSRF/Origin enforcement for consent and manager revoke.
3. Preserve current DingTalk login behavior unless a valid existing pending request plus matching nonce is supplied; resume only `/api/integrations/grok-bot/oauth/requests/<opaque>`.

## Task 3: MCP and job authorization

**Files:** `src/integrations/grok-bot-mcp.ts`, `grok-bot-jobs.ts`, `grok-bot.ts`, `routes.ts`, `app.ts`.

1. Keep existing bearer tests/contracts; select exactly one MCP auth mode.
2. Resolve OAuth access tokens to a narrow principal and propagate it only to the two tool callbacks.
3. Revalidate grant/token/manager within the existing job SQL transaction and restrict the job to the grant's organization/workspace. Do not weaken current submission, lease or requester checks.
4. Report selected mode/setup names without tokens, and independently gate OAuth connectivity versus actual Routine dispatch.

## Task 4: Deployment and operator guide

**Files:** `deploy/Caddyfile`, `render.yaml`, `.env.example`, README and bilingual Bot/deployment guides.

1. Forward required root/path well-known endpoints to the API; keep strict CSP and same-origin consent assets.
2. Select OAuth in Render and document the empty exact callback allowlist as a deliberate setup blocker; never put guessed callbacks in the template.
3. Explain manager one-time consent, grant listing/revocation, bearer compatibility, known-client registration, token rotation and remaining real-client verification.

## Task 5: Verification

**Files:** new `test/grok-bot-oauth.test.ts`, existing MCP/Bot/production tests and container smoke as needed.

Use synthetic fixtures/mock transports only. Support `TEST_DATABASE_URL` with an isolated random schema, as existing integration tests do.

Cover discovery/API prefixes, disabled missing allowlist, registration limits, invalid client/redirect/resource/scope, no metadata fetches, unauthenticated and employee/cross-org consent, explicit cookie/nonce/Origin/CSRF consent, controlled DingTalk resume, state/iss/query encoding, wrong PKCE, one-use/expired code, short-lived access, token/cookie separation, rotation races and family replay revoke, manager deactivation/demotion and grant revoke, unchanged Bot job/evidence/human acceptance invariants.

Run `node node_modules/typescript/bin/tsc --noEmit`, relevant Node tests, then full `node node_modules/tsx/dist/cli.mjs --test --test-concurrency=1 test/*.test.ts`, production build and `git diff --check`. Record PGlite versus actual PostgreSQL results separately. No real provider requests or new paid resources.

## Remaining live verification

The owner must verify the actual client identifier/callbacks from the real Bot flow or the fixed official client metadata before explicitly configuring the allowlist. The public [Cursor client metadata](https://cursor.com/oauth/mcp-client.json) was independently inspected by the main agent on 2026-10-28; it is a verification source, not a default enabled configuration. Historical DCR can include the legacy native callback, as documented in the [October support updates](https://forum.cursor.com/t/grok-bot-custom-mcp-oauth-fails-before-sign-in-redirect-uri-not-allowed/171877). Actual registration behavior, protocol negotiation, real browser consent/callback and one fictional Routine round-trip remain unverified until deployed. OAuth-only compatibility does not itself prove that a real Bot is connected.

Sources: [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration), [Grok Bot routines](https://cursor.com/help/grok-bot/routines).
