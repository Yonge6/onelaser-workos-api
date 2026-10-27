# Deploy OneLaser Work OS

[中文](README.md) · English

The production host supplies an HTTPS subdomain. GitHub Pages remains a public demo. The Docker image serves a pinned frontend and `/api` on one origin, backed by PostgreSQL. Implemented adapters and mock tests do not establish real provider or production acceptance.

## Selected setup

- One company workspace for approximately 10 people, with `WORKOS_TEAM_MODE=company`. The configured DingTalk enterprise and department allowlist still apply.
- Managers are explicitly listed in `DINGTALK_MANAGER_USER_IDS`; the first login never becomes an administrator automatically.
- The pilot prefers an independent Work OS workflow using the existing Grok Bot allowance. The existing support Bot and Zoho workflows stay untouched. The separately billed model API remains an optional fallback.
- No demo seeds or developer login in production. Business content is never persisted in browser localStorage.
- DingTalk notifications are disabled initially. The designated manager inspects and accepts deliverables; AI findings remain advisory.

## Managed hosting with Render

1. Open [New Blueprint](https://dashboard.render.com/select-repo?type=blueprint), select `Yonge6/onelaser-workos-api`, and use the root `render.yaml`.
2. Review the Web Service, PostgreSQL instance, region and actual charges before applying. The template selects Singapore, web plan `0.5c-512mb`, database plan `0.1c-256mb` and 1 GB storage. Current platform plans and displayed prices govern; this template authorizes no payment.
3. Enter credentials only in the hosting secret settings. Never put them in GitHub, the frontend, URLs or chat.
4. Use the assigned `https://<service>.onrender.com` URL. `APP_PUBLIC_URL` defaults to Render's `RENDER_EXTERNAL_URL`; no purchased domain is required. Register the app homepage and `https://<service>.onrender.com/api/auth/dingtalk/callback` in DingTalk.
5. Complete real acceptance below before inviting employees. Missing credentials disable login; they do not enable a fallback identity.

| Variable | Purpose |
| --- | --- |
| `DINGTALK_CLIENT_ID`, `DINGTALK_CLIENT_SECRET` | Separate enterprise internal app credentials |
| `DINGTALK_CORP_ID` | Approved enterprise |
| `DINGTALK_ALLOWED_DEPARTMENT_IDS` | Approved real department IDs, comma separated; required in company mode |
| `DINGTALK_MANAGER_USER_IDS` | Explicit manager user IDs, comma separated |
| `AI_REVIEW_MODE` | Template selects `bot`; code defaults to `api`. Incomplete integration settings disable assessment |
| `GROK_BOT_WEBHOOK_URL`, `GROK_BOT_WEBHOOK_SECRET` | Dedicated routine's actual HTTPS trigger URL and secret |
| `GROK_BOT_WEBHOOK_ALLOWED_HOST` | Exact verified routine hostname, without wildcards or local/private destinations |
| `GROK_BOT_WORKER_TOKEN` | Separate random MCP credential, at least 32 characters, different from the webhook secret |
| `GROK_BOT_ORG_ID` | Approved worker organization; may fall back to the explicitly configured DingTalk corporation |
| `AI_PROVIDER_API_KEY`, `AI_MODEL_ID` | Required only in `api` mode: separate API key and an account-accessible model supporting structured output |
| `DINGTALK_AGENT_ID` | App AgentId, required for work notifications |

An enterprise administrator must grant the independent app its login identity, enterprise membership mapping and approved department/member read permissions. Work notifications still require the app AgentId and explicit activation. Use the current developer console and official documentation for exact scope names. Limit app visibility to approved employees. The model receives only the authorized task criteria and submitted text; it does not fetch links or receive compensation or the employee directory. Use fictional material for the first real call.

See the [Bot integration guide](../docs/integrations/GROK_BOT_SETUP.en.md). Deploy the base service, obtain the dedicated Routine's actual webhook URL and secret without triggering it, then complete the Bot environment settings and redeploy before connecting the MCP client. Setting only the worker token does not enable MCP; incomplete Bot settings produce 503 on that endpoint. The template does not require buying model API credits. Bot review is asynchronous: webhook acceptance means execution started; results return separately through restricted MCP tools. Bot usage still has plan limits. Bots on one account share a cloud computer and logins, so workflow separation does not replace server authorization.

## Existing server alternative

`compose.yaml` includes a persistent PostgreSQL volume and the application. It exposes only `127.0.0.1:8088`; an existing HTTPS reverse proxy must forward the production origin to this port.

1. Create the Git-ignored `.env.production` at repository root, with approved settings and `APP_PUBLIC_URL=https://<host>`.
2. Set a strong random `POSTGRES_PASSWORD`. Use URL-safe random characters if embedding it in a connection string.
3. Run `docker compose --env-file .env.production -f deploy/compose.yaml up -d --build`.
4. Back up the database volume. Do not use `down -v` for routine restarts. Test restores in a separate database before switching production.

## Acceptance and releases

- Require CI: TypeScript, PGlite, real PostgreSQL, Docker build, same-origin API, security headers, fail-closed login and an unconfigured Bot adapter.
- `/healthz` checks database connectivity. `/api/capabilities` reports configuration only; `configured` is not verified acceptance. In this version, `productionReady:false` is a constant marker that does not change with configuration or real tenant acceptance. It is not a deployment-failure signal or a substitute for acceptance records.
- Verify actual manager and employee login, rejection of unapproved enterprise/departments, employee scope, no privilege escalation, and immediate loss of sessions after member deactivation through sync.
- Create OKRs/KRs and a task; submit evidence; verify Grok citations; inspect and accept as manager; reload and confirm persistence. Stale writes must return 409 without silent overwrites. In Bot mode also verify pending, leased, completed and uncertain/failed states, explicit retry, invalidated leases and rejection of old submissions. Dispatch must never masquerade as a completed assessment.
- Check Chinese/English, theme, logout and login. Only theme/language preferences may use localStorage, never task data or sessions.
- Approve a specific test recipient before setting `DINGTALK_NOTIFICATIONS_ENABLED=true`. `queued` means provider acceptance, not confirmed delivery.
- Confirm backup retention, costs and a restore drill. `frontend-revision.txt` pins the frontend; updating it requires rebuilding the image. Keep database migrations compatible with any rollback.

The application does not automatically decide retention, termination or compensation. Managers can inspect evidence and human acceptance records.
