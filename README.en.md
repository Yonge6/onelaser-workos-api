# OneLaser Work and Outcomes API

[中文](README.md) · English

A backend development MVP for employee tasks, OKRs, evidence submissions, and human acceptance reviews. It uses Node.js, TypeScript, Fastify, and PostgreSQL queries. PGlite supports local development and tests; the `pg` adapter connects to a PostgreSQL server.

[Backend repository](https://github.com/Yonge6/onelaser-workos-api) · [Frontend repository](https://github.com/Yonge6/onelaser-workos) · [Frontend demo](https://yonge6.github.io/onelaser-workos/)

**There is no publicly deployed API service at this stage.** The frontend demo still stores its records in browser `localStorage` and is not connected to this API. All seed records are fictional. DingTalk authentication, AI assessment, and notification delivery are not integrated.

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

`DEV_LOGIN_SECRET` must contain at least 32 characters and must be supplied in the development login request. Do not commit real configuration files, session tokens, or database files. Production mode prohibits development login and demo seeding, and requires a PostgreSQL connection. PGlite is for local development and tests. Real authentication remains unfinished, so this version is not a complete enterprise production backend.

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

Business endpoints require a Bearer session, except health, capability information, and authentication entry points.

| Method and path | Current behavior |
| --- | --- |
| `GET /health`, `GET /capabilities` | Health and integration capability information |
| `POST /auth/dev-login` | Explicit development mode only; body contains `userId` and `secret` |
| `GET /auth/dingtalk/start`, `GET/POST /auth/dingtalk/callback` | Not integrated; returns `501` |
| `DELETE /auth/session` | Revokes the current session |
| `GET /me` | Current authenticated user |
| `GET /tasks`, `GET /tasks/:id` | Tasks and submission records within the personal or department scope |
| `POST /tasks` | Creates a task with its initial deadline, criteria, and reviewer |
| `POST /tasks/:id/submissions` | Creates a new evidence version with a description and optional HTTPS URL |
| `POST /tasks/:id/reviews` | The designated manager accepts the evidence or returns it for revision |
| `GET /objectives`, `GET /key-results` | Visible objectives, KRs, and business progress |
| `POST /key-results/:id/measurements` | A manager records an actual value, source, and explanation |
| `POST /tasks/:id/analyze` | AI is not integrated; returns `501` |
| `GET /notifications/preview` | Generates an unsent draft for the current visible scope |
| `POST /notifications/send` | Delivery is not integrated; returns `501` |
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

Before a real pilot, finish DingTalk authentication, frontend/API integration, private file storage and evidence extraction, model citation validation, notification queues, work calendars, recovery drills, and enterprise access acceptance.
