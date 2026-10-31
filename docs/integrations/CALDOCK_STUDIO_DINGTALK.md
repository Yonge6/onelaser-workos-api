# CalDock Studio: reuse OneLaser DingTalk login

Studio uses the existing configured DingTalk application and `/api/auth/dingtalk/callback`. No second client secret or callback registration is needed when the existing OneLaser login is working.

Start at `/api/auth/dingtalk/start?destination=caldock-studio&lang=zh` (or `en`). The destination and language are stored in the one-use OAuth state. The callback only returns to the fixed Studio team tab. Bot OAuth continuation is mutually exclusive with this destination and retains its original flow.

## Access

- Plans and plan history remain publicly readable. Team membership is not public.
- A verified member in the configured enterprise and department/person scope receives a stable Studio actor and viewer membership on first use.
- Only identities explicitly listed in `DINGTALK_MANAGER_USER_IDS`, with a current manager role, bootstrap as owners. No first-visitor ownership or name/email matching is used.
- Owners grant Studio permissions separately. Removing a member retains their identity mapping, so a later login does not restore access. Removed identities are available to owners for an explicit regrant.
- Bootstrap owner access falls to viewer when the source role or configured manager eligibility is removed. Restoring that source eligibility does not automatically restore owner access. Explicit later Studio grants are independent, while enterprise scope and active status remain mandatory.
- The last-owner check excludes inactive, out-of-scope and ineligible bootstrap identities. Keep at least one eligible owner when handing over access.

## Sessions and isolation

Studio reuses the existing one-hour HttpOnly WorkOS cookie and CSRF token. It rechecks source-session expiry, active status, configured corporation, real external department/person scope and Studio membership, including inside write transactions. Source and membership changes serialize with writes. It never creates a normal CalDock customer session or commerce identity.

`GET /api/caldock/studio/health` advertises DingTalk availability. `/me` returns the stable actor, effective role, CSRF and `provider`. A valid scoped WorkOS session takes precedence over a legacy CalDock session; writes still validate the selected identity's CSRF. Legacy CalDock Studio members continue to work.

DingTalk sign-out uses `DELETE /api/auth/session`, which also signs out the browser's OneLaser workspace. It does not sign out the DingTalk application itself. If another legacy CalDock browser session remains, the UI reloads its identity rather than presenting a false signed-out state.

The bridge does not change CalDock customer orders, payments, Google/Apple provider settings, referral commissions or saved planning values. Credentials remain in existing deployment configuration, never in GitHub Pages or Studio exports.
