# CalDock accounts, orders and referrals

CalDock reuses the existing craftos.app service and PostgreSQL database, at the user's explicit request. It has its own `caldock_*` tables, Google/Apple identities, HttpOnly session cookies, CSRF protection, administrator allowlist and audit events. Work OS / DingTalk sessions and customer sessions are not interchangeable. Existing Work OS and Wiki frontend pins remain unchanged.

## URLs

- Marketing preview: https://yonge6.github.io/mac-mini-rental/
- Account app: https://craftos.app/caldock/?view=login&lang=zh
- Customer center: https://craftos.app/caldock/?view=account&lang=zh
- Order administration: https://craftos.app/caldock/?view=admin&lang=zh
- Configuration availability: https://craftos.app/api/caldock/capabilities

Account routes stay on craftos.app so authentication uses first-party HttpOnly cookies rather than third-party cookies or tokens in a marketing-page URL. CalDock statics are built from a full verified commit in `deploy/caldock-revision.txt` and mounted at `/caldock/`. The GitHub marketing site directs account/checkout flows there. All API writes require exact Origin and the session CSRF token.

## Google activation

Create a CalDock web OAuth client in the owner's Google Cloud project. Configure this exact authorized redirect URI:

`https://craftos.app/api/caldock/auth/google/callback`

Place the client ID and client secret in Render's private environment variables `CALDOCK_GOOGLE_CLIENT_ID` and `CALDOCK_GOOGLE_CLIENT_SECRET`. Never put a client secret in GitHub, the frontend or chat. The flow requests only OpenID, email and basic profile; verifies signature, issuer, audience, expiry, nonce and Google PKCE. A configuration flag is not a completed real-login acceptance test.

## Apple activation

Associate a Sign in with Apple-enabled primary app with a CalDock Services ID and private key in the owner's Apple developer account. Register domain `craftos.app` and this return URL:

`https://craftos.app/api/caldock/auth/apple/callback`

Set the private server variables `CALDOCK_APPLE_SERVICE_ID`, `CALDOCK_APPLE_TEAM_ID`, `CALDOCK_APPLE_KEY_ID`, `CALDOCK_APPLE_PRIVATE_KEY`. The server signs a short-lived client secret; private key and identity tokens never enter the frontend. Apple's form_post callback uses a separate Secure SameSite=None OAuth browser-binding cookie; the final account session remains HttpOnly, Secure and SameSite=Lax.

## Administrator activation

1. Finish and verify a real Google or Apple sign-in as the intended owner.
2. Read that CalDock user's immutable ID from their authenticated `/api/caldock/me` response, or from the private database.
3. Have the owner explicitly confirm the ID, then add it to `CALDOCK_ADMIN_USER_IDS` in private hosting configuration.
4. Verify that this user can access administration and another ordinary account receives 403.

The first user is never an administrator. Matching email addresses do not auto-link Google and Apple identities. Client profile data cannot assign roles. No development login is exposed by CalDock.

## Orders and commission rules

- The server determines USD 199/month, USD 507/quarter (169/month), or USD 1,548/year (129/month) in integer cents. Clients cannot supply prices, customer IDs or paid status.
- Pricing changes apply to new orders only. Existing orders retain their snapshotted amount and commission rule. Quarterly delivery starts a three-calendar-month service period.
- Order creation is idempotent per customer/request key and respects one open rental per customer.
- A new customer's initial referral is bound from a server-side 30-day first-touch record. Existing customers cannot overwrite attribution; self-referrals cannot earn commission.
- Commission defaults to zero and first paid order. Administrators can set 0–100% and first/every paid order. Each order snapshots the rule, so future edits do not retroactively change it.
- Paid state and commissions come only from `recordVerifiedCaldockPayment`, an internal adapter function. It is intentionally NOT an HTTP endpoint. A future payment adapter must authenticate and verify provider events before invoking it. The current application does not collect money or accept a client payment-success flag.
- Full refunds void commissions. Prior offline settlement references and timestamps are preserved so a settled/refunded commission can be flagged for recovery.
- Administrator order actions only advance verified paid orders through provisioning and delivery. Delivery begins the billing period. Version checks prevent stale changes.
- Commissions require approval, then a reference for a completed OFFLINE settlement. No automatic transfer is performed.

## Explicit demonstrations

`?view=account&demo=1&role=customer` and `?view=admin&demo=1&role=admin` use fictional browser-local records and a visible demo banner. They never call production business APIs, create real users, seed the server database or simulate Google/Apple consent success. Production sign-in buttons remain unavailable until their provider is configured.

## Verification

`npm run typecheck`, `npm test` (embedded and real PostgreSQL CI), Docker/Caddy smoke tests, and browser checks cover ownership, namespace separation, role escalation, CSRF, OIDC claims, state/replay, order tampering, request/payment idempotency, commission snapshots, refunds and delivery versions. Real provider sign-in, real payment and real payout remain separate acceptance items.

Official references:
- https://developers.google.com/identity/openid-connect/openid-connect
- https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple
- https://developer.apple.com/documentation/signinwithapple/verifying-a-user
- https://developer.apple.com/documentation/signinwithapple/receiving-a-users-identity-token
- https://github.com/panva/jose
