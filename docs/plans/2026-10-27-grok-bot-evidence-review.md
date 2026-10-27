# Grok Bot Evidence Review Implementation Plan

**Goal:** Reuse an existing Grok Bot allowance for optional asynchronous evidence assessment, without requiring this pilot to purchase model API credits.

**Architecture:** Keep the current synchronous xAI API adapter as the default code path. In Bot mode, the application stores an authorized, version-bound review job and sends only its opaque ID to an authenticated Grok Bot routine webhook. A narrowly scoped remote MCP service lets the Bot retrieve that job's evidence and submit a validated advisory result; employees inspect its state through their existing sessions.

**Tech stack:** TypeScript, Fastify, PostgreSQL/PGlite, stateless HTTP MCP, vanilla browser client, existing evidence-validation schema.

## Decisions and evidence

- The pilot serves approximately ten employees in one explicitly approved enterprise workspace.
- User asks to reuse the existing Grok Bot instead of immediately purchasing API credits. This development adds an optional adapter and preserves API fallback.
- [Official routines documentation](https://cursor.com/help/grok-bot/routines) supports authenticated webhook POSTs with JSON. A 200 response means a run started, not that a review completed. Routine quota failures may require manual reruns.
- [Official Bot configuration](https://docs.x.ai/grok-bot/team-bots) supports remote HTTPS MCP. Bots on the same account share a computer and logins; a separate Bot is a workflow distinction, not a security boundary.
- Model API billing and Bot plan allowances are distinct. Existing Bot usage is still metered; this implementation does not claim unlimited or free analysis.
- No real webhook, Bot routine, worker credential, employee data transfer or paid resource is created by this source change. Existing Zoho/customer-support configuration remains untouched.

## Step 1: Persist advisory review jobs

**Files:** `src/db.ts`, new `src/integrations/bot.ts`, focused tests.

1. Add an additive job table keyed by random IDs and bound to organization, department, task, requester, current submission, input hash and expiry.
2. Store only server-controlled status and lease hashes. Public job views must never contain worker credentials, source payloads or webhook secrets.
3. Deduplicate requests for the same immutable submission and rubric. A network timeout must become an uncertain dispatch state, not a silent retry.
4. Re-check the active requester's permission and current submission before returning evidence or accepting a result.

**Verify:** concurrent duplicate requests, tenant separation, deactivated requesters, stale submissions, expired jobs and invalid leases are rejected or marked appropriately.

## Step 2: Reuse evidence validation

**Files:** `src/integrations/grok.ts`, Bot integration, tests.

1. Share the existing strict result schema and source quotation validator between providers.
2. Require every rubric criterion exactly once, exact authorized reference IDs and quotes present in that source.
3. Reject arbitrary score, employment or acceptance-state fields. Record generic provider `grok-bot`; the Bot's selected underlying model is not asserted.
4. Save validated results in the same evaluation history as the API adapter. Human acceptance and business KR measurements remain separate explicit actions.

**Verify:** invented quotes, external references, missing criteria, stale results, duplicate conflicting completions and human-review suppression fail.

## Step 3: Protect the remote MCP boundary

**Files:** Bot integration, `src/app.ts`, `src/integrations/routes.ts`, tests.

1. Only the dedicated MCP route bypasses ordinary employee sessions; it must authenticate a separate server-configured, sufficiently random bearer token.
2. Bind the worker to one explicitly configured organization. The worker cannot enumerate employee tasks, create tasks, change roles, approve results or send notifications.
3. Provide only `workos_get_review_job({jobId})` and `workos_submit_review({jobId,leaseToken,result})` plus protocol-required discovery methods.
4. Use short, bounded leases, constant-time credential checking, stable protocol errors and no secret logging. Reject unexpected browser origins and unknown protocol variants.
5. Verify the current official MCP transport specification and document the exact supported protocol versions. Do not claim compatibility from hand-written method names alone.

**Verify:** no-cookie fallback, invalid/absent tokens, unknown methods, malformed protocol envelopes, disallowed origins, another organization's IDs and expired leases fail safely.

## Step 4: Connect the authorized task routes

**Files:** `src/integrations/routes.ts`, environment reference and tests.

- `POST /tasks/:id/analyze` returns normal evaluation data for API or cached success, otherwise `202 {mode:"bot",job:{id,status,submissionVersion,createdAt,expiresAt,errorCode?}}`.
- `GET /tasks/:id/analysis-jobs` lists safe jobs for an authorized task, newest first.
- `GET /tasks/:id/analysis-jobs/:jobId` returns safe state.
- `POST /tasks/:id/analysis-jobs/:jobId/retry` requires explicit current-user intent. Do not automatically repeat a webhook after an uncertain dispatch.

Environment selection is `AI_REVIEW_MODE=api|bot`. Bot mode requires `GROK_BOT_WEBHOOK_URL`, `GROK_BOT_WEBHOOK_SECRET`, `GROK_BOT_WEBHOOK_ALLOWED_HOST`, `GROK_BOT_WORKER_TOKEN`, and an approved `GROK_BOT_ORG_ID` (or explicit DingTalk corporation). URLs must be HTTPS with no credentials, query or fragment; redirects and non-public DNS destinations are prohibited. Capability responses show missing configuration names only. Job states are `dispatching`, `pending`, `leased`, `completed`, `dispatch_unknown`, `failed`, `expired` and `superseded`. Jobs expire after 30 minutes; leases after 5 minutes. A retry creates or returns a replacement job and invalidates the old attempt.

**Verify:** all existing API adapter tests remain valid. A successful webhook response leaves the task submitted and its job pending until a valid worker result arrives.

## Step 5: Add bilingual asynchronous UI

**Files in frontend repository:** `dist/live-app.js`, optional styles/client helpers, client tests.

1. Read `capabilities.aiReviewMode` to label the selected provider accurately.
2. Display job states separately from completed evaluations. Pending or failed work must never display a fabricated score or successful review.
3. Poll only the current open task, with bounded backoff; stop on close, account change, failure, expiry or a fixed time budget.
4. Offer manual refresh and explicit retry. Disable duplicate submissions while a request is in flight. A dispatch-unknown retry explains possible repeated Bot usage.
5. Preserve the supplied English brand, compact language switch, icon-only theme control, escaping and preferences-only localStorage policy.

**Verify:** pending, completed, failed, unknown and stale-version views; polling cancellation; 401/409 behavior; synchronous API and demo modes unchanged.

## Step 6: Package and verify

1. Run backend type checking and tests with PGlite and PostgreSQL, frontend tests and syntax checks.
2. Run a local synthetic browser workflow with mocked webhook and MCP completion, clearly labeled as synthetic.
3. Publish frontend changes, pin its exact Git commit in the backend image, then run Docker same-origin CI.
4. Update Chinese/English deployment guides with mode selection and a reviewable Bot routine prompt and MCP tool contract.
5. Keep real deployment marked pending until hosting, approved credentials, actual Bot connection and a fictional end-to-end run succeed.

## External activation checklist

- Finish the account holder's GitHub recovery-code confirmation and hosting login.
- Review actual hosting prices before creating paid resources.
- Configure the independent DingTalk app's production homepage/callback and release the four approved read permissions.
- Create the dedicated Work OS Bot/routine without altering the customer-support Bot. Review new persistent MCP access before granting it.
- Store webhook and worker secrets only in the hosting/Bot secret settings, never in prompts, source, URLs or screenshots.
- Trigger one fictional review; independently verify webhook dispatch, MCP claim, validated completion, employee scope and human acceptance.
- Confirm behavior when Bot allowance is exhausted or a routine fails. Model API can be enabled later through its own approved billing and credentials.
