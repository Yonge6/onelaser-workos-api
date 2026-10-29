# OneLaser Work and Outcomes API

[中文](README.md) · English

For a temporary Mac-hosted integration, see [Mac integration](deploy/MAC_LOCAL.en.md) for startup, private configuration and the independent HTTPS tunnel.

A backend development MVP for employee tasks, OKRs, evidence submissions, and human acceptance reviews. It uses Node.js, TypeScript, Fastify, and PostgreSQL queries. PGlite supports local development and tests; the `pg` adapter connects to a PostgreSQL server.

[Backend repository](https://github.com/Yonge6/onelaser-workos-api) · [Frontend repository](https://github.com/Yonge6/onelaser-workos) · [Frontend demo](https://yonge6.github.io/onelaser-workos/)

Production packaging: [deployment guide](deploy/README.en.md) · [中文部署说明](deploy/README.md). Docker serves a pinned frontend and the API on one origin. The Render Blueprint and existing-server Compose template do not create paid resources automatically.

Knowledge center / Wiki preserves the complete public site at `/wiki/`: homepage, categories, full-text search, downloads, 236 articles and bilingual interface. Archive & review retains the authenticated human review flow. The build pins `deploy/wiki-revision.txt`, verifies all 259 public Git blobs, then applies one recorded catalog-family URL safety patch without changing the original site. `/wiki/wiki-build-info.json` identifies the deployed source and patch. Images and external downloads retain their original links. The pinned same-origin scripts are trusted application code; future revisions require a fresh audit and do not update automatically. See [integration and data boundaries](docs/company-support.md).

**The original GitHub Pages site is a demo deployment.** Its records remain browser-local until a live runtime is deployed and configured on the same origin as this API. All seed records are fictional. DingTalk, Grok assessment and notification adapters are implemented; actual activation requires enterprise authorization, deployment configuration and credentials for the selected review channel. Code and mock tests are not proof of a verified live connection.

The separate model API remains the default (`AI_REVIEW_MODE=api`). Optional [Grok Bot asynchronous assessment](docs/integrations/GROK_BOT_SETUP.en.md) (`AI_REVIEW_MODE=bot`) uses a dedicated Routine and protected remote MCP pickup/completion tools. Bot mode needs no model API credit; actual account allowance and the live connection still require verification. New dispatches are limited to ten per organization per UTC clock hour, without automatic retries.

Render selects MCP OAuth. After an administrator configures exact callbacks, a DingTalk manager explicitly approves `workos.review` and clicks Return to Bot. Only token digests are stored, with server-side refresh rotation, replay protection and grant revocation. Explicit `bearer` compatibility remains available; the native Bot needs no worker secret in chat. Actual client connectivity still requires deployment verification.

## Run locally

Use Node.js 22 or newer; Node.js 24 is recommended. The following commands work in macOS, Linux, or a compatible shell:

```sh
git clone https://github.com/Yonge6/onelaser-workos-api.git
cd onelaser-workos-api
npm ci
npm run typecheck
npm test
npm run build
npm start
```

The default listener is `127.0.0.1:3001`. Demo seeding and development login are disabled by default. Configuration is read from process environment variables. `.env.example` documents the variables; copying it to `.env` does not automatically load the file.

To try the fictional accounts, explicitly enable development mode in the current terminal:

```sh
export NODE_ENV=development
export HOST=127.0.0.1 PORT=3001
export ALLOW_DEV_LOGIN=true SEED_DEMO=true
export DEV_LOGIN_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export PGLITE_DATA_DIR=.runtime/pglite
npm run dev
```

`DEV_LOGIN_SECRET` must contain at least 32 characters and must be supplied in the development login request. Do not commit real configuration files, session tokens, or database files. Production mode prohibits development login and demo seeding, and requires a PostgreSQL connection. PGlite is for local development and tests. Production acceptance requires real DingTalk configuration and live checks of enterprise membership, CSRF, frontend connectivity and enabled integrations.

## Fictional accounts

These records are inserted only when `SEED_DEMO=true` is explicitly set:

| ID | Display name | Department | Role |
| --- | --- | --- | --- |
| `m1` | 林楠 | Marketing | Manager |
| `m2` | 陈一 | Marketing | Employee |
| `m3` | 许夏 | Marketing | Employee |
| `m4` | 周明 | Product | Manager |
| `m5` | 赵然 | Product | Employee |
| `m6` | 顾安 | Product | Employee |

Roles and departments are stored on the server and cannot be asserted by a client. Each authenticated request checks the user's current active status and scope. Deactivated users cannot continue using existing sessions.

## Chinese and English responses

System errors and messages use Chinese by default. Set `Accept-Language: en` for English, or `Accept-Language: zh` for Chinese. API paths, JSON field names, and machine identifiers such as `error.code` stay in English. User-entered titles, descriptions, evidence, and review notes are stored unchanged and are not automatically translated.

```sh
curl --silent http://127.0.0.1:3001/capabilities -H 'Accept-Language: en'
```

## Login and request examples

This development login reads the secret from the environment and sends it in the request body to the local service:

```sh
export ACCESS_TOKEN="$(node -e 'process.stdout.write(JSON.stringify({userId:"m2",secret:process.env.DEV_LOGIN_SECRET}))' \
  | curl --fail --silent --show-error http://127.0.0.1:3001/auth/dev-login \
      -H 'Content-Type: application/json' --data-binary @- \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).accessToken))')"

curl --fail --silent --show-error http://127.0.0.1:3001/tasks \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Accept-Language: en'
```

Login returns `accessToken`, `tokenType`, and `expiresAt`. Sessions use random tokens; only token digests are stored in the database. Do not put tokens in URLs or logs.

Example request body for an employee creating their own task:

```json
{
  "title": "Prepare the product content draft",
  "description": "Submit content and traceable source material",
  "criteria": ["Provide source references", "Explain each acceptance criterion"],
  "ownerId": "m2",
  "reviewerId": "m1",
  "dueAt": "2026-11-01T18:00:00+08:00",
  "krId": "kr2"
}
```

Before submitting evidence or a review, read the task's latest `version` and send it as `expectedVersion`. The review request's `submissionVersion` must match the task response's current `submission_version`. Stale requests return `409`; clients should reload the record and ask the user to confirm the updated state.

## API scope

Business endpoints require a session, except health, capability information, and authentication entry points. The production browser uses an HttpOnly cookie; Bearer authentication is retained for development examples and controlled tooling.

| Method and path | Current behavior |
| --- | --- |
| `GET /health`, `GET /capabilities` | Health and integration capability information |
| `POST /auth/dev-login` | Explicit development mode only; body contains `userId` and `secret` |
| `GET /auth/dingtalk/start`, `GET/POST /auth/dingtalk/callback` | Configured OAuth login flow; returns `501` if configuration is missing |
| `DELETE /auth/session` | Revokes the current session |
| `GET /me` | Current authenticated user |
| `GET /tasks`, `GET /tasks/:id` | Tasks and submission records within the personal or department scope |
| `POST /tasks` | Creates a task with its initial deadline, criteria, and reviewer |
| `POST /tasks/:id/submissions` | Creates a new evidence version with a description and optional HTTPS URL |
| `POST /tasks/:id/reviews` | The designated manager accepts the evidence or returns it for revision |
| `GET /objectives`, `GET /key-results` | Visible objectives, KRs, and business progress |
| `POST /key-results/:id/measurements` | A manager records an actual value, source, and explanation |
| `POST /tasks/:id/analyze` | Configured evidence assessment with validated citations; otherwise `501` |
| `GET /notifications/preview` | Generates an unsent draft for the current visible scope |
| `POST /notifications/send` | Explicit idempotent manager notifications; `501` when disabled or unconfigured |
| `GET /audit` | Audit records within the current permission scope |

Evidence submission body:

```json
{
  "expectedVersion": 1,
  "title": "First evidence submission",
  "description": "Describe the deliverable, source data, and remaining evidence gaps",
  "evidenceUrl": "https://example.com/evidence"
}
```

Human acceptance body:

```json
{
  "expectedVersion": 2,
  "submissionVersion": 1,
  "decision": "accept",
  "quality": 85,
  "note": "I checked the current evidence against the agreed criteria and retained the supporting record",
  "verifiedCurrentSubmission": true
}
```

The version numbers above only illustrate the relationship between fields. Real requests must use the latest returned values. To return a submission, use `decision: "return"` with a reason; a quality score is not required.

## Access and data rules

- Employees can read only their own tasks and cannot create tasks for other people. Managers operate within their own department.
- Personal KRs appear only within the permitted identity scope. Task creation rechecks the owner, reviewer, and linked KR on the server.
- Task owners cannot review their own work. Only the designated reviewer can accept the corresponding task.
- A new evidence version invalidates the previous current acceptance result while retaining history. A stale review cannot overwrite a newer submission.
- Acceptance requires a human quality score, a review note, and confirmation that the current evidence was actually checked. Completing a task does not increase a KR's actual value.
- KR measurements separately record the actual value, source, and explanation. Progress is unknown when the normalization is undefined.
- Evidence URLs are stored as metadata only. The API does not fetch external evidence or upload or parse attachments.
- The API has no payroll data, autonomous retention judgments, automated personnel actions, or individual composite performance scores.
- Requests use parameterized SQL, structured validation, and a bounded request size. Cross-origin access is not enabled by default.

## Validation and remaining work

`npm test` uses Fastify request injection and a PGlite SQL database to check identity, scope, version conflicts, human acceptance, and KR independence. `npm run typecheck` checks TypeScript, and `npm run build` produces runnable JavaScript.

Set `TEST_DATABASE_URL` to run the same API tests against a test PostgreSQL database. Use a dedicated test database, separate from production data. The PostgreSQL adapter still needs verification in the actual server environment. Passing local PGlite tests does not prove a real PostgreSQL deployment, backup, or restore has passed. Remote CI results are established by the corresponding Actions run.

Before a real pilot, verify configured DingTalk permissions and frontend/API connectivity, add private file storage if needed, validate real model output and enabled notifications, establish working calendars, and complete recovery and enterprise access acceptance.


## Production integrations

Serve the frontend and API on one HTTPS origin; strip the `/api` prefix at the proxy. Navigate to `/api/auth/dingtalk/start` for login. Short-lived OAuth state is bound to an HttpOnly browser nonce. The server verifies the configured corporation, unionId-to-enterprise-user mapping, active membership and explicit department allowlist. Only IDs listed in `DINGTALK_MANAGER_USER_IDS` become managers; the first login never grants administration.

Sessions use HttpOnly, Secure, SameSite=Lax cookies. Fetch `GET /auth/csrf`, then include `X-CSRF-Token` on writes. Origin, token, user and resource scope are checked server-side. `GET /capabilities` exposes configuration status and missing variable names, never secret values. Configured does not mean a live tenant has passed acceptance.

For a small company, explicitly set `WORKOS_TEAM_MODE=company` to share one workspace among members already validated against the corporation and approved departments. The code defaults to `department`. Original DingTalk department IDs and names remain in identity mappings. Company synchronization loops through real approved department IDs and deduplicates users; it never sends the internal workspace ID to DingTalk. Migrate existing task/objective scope before changing modes after real data exists.

Managers can call `POST /integrations/dingtalk/sync`; absent members are deactivated and existing sessions stop working. `GET /directory` and `GET /departments` supply the authorized members and workspace. `POST /objectives` accepts `{title,level:"personal"|"department",ownerId?}`; `POST /objectives/:id/key-results` accepts `{title,baseline,target,actual?,direction:"increase"|"decrease",unit}`. Employees can create only their own personal objectives. Ordinary department managers cannot create company-wide objectives.

Grok assessment supports the model API (`AI_REVIEW_MODE=api`) or the [asynchronous Bot adapter](docs/integrations/GROK_BOT_SETUP.en.md) (`AI_REVIEW_MODE=bot`). Bot mode uses a dedicated Work OS Routine while preserving existing customer-support workflows. Only the current task criteria and submitted text are passed to assessment; no salary or workforce-wide data is included and URLs are not fetched. Every criterion must appear once; source IDs and verbatim quotes are validated against the exact submission. Failed or stale results remain errors, never zero performance scores. AI does not accept tasks or make personnel decisions. `GET /tasks/:id/evaluations` retains versioned history; managers must still inspect and confirm the actual evidence.

Notification requests accept `{taskIds:[...],idempotencyKey:"UUID"}`. Only managers can notify current-scope task owners. Configure AgentId and explicitly enable `DINGTALK_NOTIFICATIONS_ENABLED=true`. A `queued` response means provider acceptance, not delivery; `sent:false` avoids claiming receipt. Timeouts become `unknown`, and the same idempotency key is not automatically resent.

OAuth/CSRF, company scope, model citations and notification-idempotency tests mock official services. They do not send real notifications or spend real model credits. Live enterprise permissions, model availability, cost, first-user login and actual notification receipt still require deployment acceptance.
