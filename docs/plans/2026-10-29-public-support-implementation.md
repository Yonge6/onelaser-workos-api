# Public Wiki assistant and support workflow implementation plan

**Goal:** Open the current native Wiki to visitors and deliver traceable support corrections, handovers, public assistance and customer-service knowledge feedback.

**Architecture:** Reuse the native Wiki renderer and public content package. Keep employee authorization intact; give public sessions their own short-lived secret and exact endpoints. Store append-only internal records and public feedback in PostgreSQL. Model responses use only explicitly eligible public content and validated citations; unavailable providers fall back to honest document recommendations.

**Tech stack:** Existing Fastify/TypeScript/PostgreSQL API and plain JavaScript frontend. No new paid infrastructure.

## Work packages

1. `src/support.ts`, support tests and snapshot collector: inbound/sent thread matching; immutable correction reasons and outcomes; rule-based quality signals; source-bound handover records with concurrency controls.
2. Frontend `company-support.js`, `support-workflow.css`: matching, correction reasons, outcomes, rule findings, handover editor/history; preserve drafts and unsaved input.
3. Frontend `live-app.js`, `wiki.js`, `wiki-assistant.js/css`: anonymous native knowledge routes, public shell, assistant drawer, cited messages, feedback and confirmed handoff.
4. `src/public-wiki.ts` and tests: bounded public corpus search, isolated sessions, idempotent messages and handoffs, feedback, strict citations, approved-public-answer gate, rate and usage controls; internal inbox and knowledge candidate review.
5. `src/shopify.ts` and tests: authorized internal read-only lookup, exact order references and fulfillment states; configure only after real store/application authority and credentials are verified. No anonymous order lookup.
6. Integrate backend registration/schema/config, build and run complete relevant tests; verify existing auth, OAuth and CSP routes.
7. Publish frontend, pin immutable revision in backend, pass CI/container checks, deploy existing Render service, and read back craftos.app with an anonymous session and an authorized employee session.

## Acceptance

- Anonymous visitors can use the same native Wiki overview/search/download/article routes; employee-only routes and API data remain protected.
- Public messages never inherit employee authority; no model key, customer mail or private tool appears in the client/public corpus.
- Model-disabled behavior is marked as document guidance; no fictional AI-generated assessment, shipping fact, approval or ticket number.
- Exact correction/actual-mail relationships have evidence and human confirmation where thread matching is unavailable; idempotent retries and conflicts preserve content.
- Handovers separate confirmed facts, previous attempts, commitments, blockers, next action and receiving owner.
- Feedback and human requests persist in an authorized internal inbox; knowledge candidates require version-bound review before answer eligibility.
- SLA and financial/legal policy values remain draft until specifically resolved. No customer email sending enabled.
- External permissions/usage requiring action-time approval are presented only after concrete configuration is prepared; absence of such approval does not prevent independent implementation and testing.
