# Company Workspace Implementation Plan

**Goal:** Bring Work OS and the existing Zoho support project into one authenticated company workspace at craftos.app.

**Architecture:** Keep the established support poller/worker as the sole Zoho/Grok dispatcher during migration. A read-only outbound connector publishes bounded, versioned support snapshots into the existing PostgreSQL service. Work OS supplies common DingTalk authentication, explicit support access, native screens, source-bound review records, and an executive summary. This is a service integration, not an iframe or collection of external links. Cloud migration of the dispatcher is a separate cutover with checkpoint preservation; the UI must disclose the current Mac dependency and data age.

**Tech Stack:** Fastify, PostgreSQL, vanilla JavaScript, Python stdlib connector; existing Render deployment.

## Tasks
1. Add support snapshot and immutable review tables; isolated ingest credential scoped to one configured organization, strict data limits and replay protection.
2. Add authenticated knowledge/library, ticket/draft, SLA, standard-answer and operating-status API. Customer sends, policy activation and Bot tool expansion remain unavailable. Separate summary access from customer detail access; record real authenticated reviewer IDs.
3. Build native bilingual support and knowledge screens within existing navigation/theme, with actionable source-bound human-review forms, staleness indicators and executive summaries.
4. Read existing public knowledge and approved local pilot records using SQLite read-only transactions. Do not copy credentials, raw email, delivery payloads, secrets or approval keys. Keep the existing single dispatcher untouched.
5. Test unauthorized/other-org access, stale/replayed snapshots, forged reviewer/hash, immutable versions, no-send behavior, source changes and synthetic UI escaping. Run existing regression tests.
6. Deploy frontend/API at pinned revisions; configure private connector credential. Verify a real permitted login, bounded sync and review flow without customer send.
7. Complete craftos.app DNS/TLS then update DingTalk and existing Work OS Bot issuer. Verify new-domain login and controlled evidence-review callback.

## Acceptance boundaries
Public GitHub contains code and public-only assets. Private support content stays in private local state/PostgreSQL behind login. Existing local review history is provenance, not a new SSO approval. Missing or stale data is unknown, never zero. The server must not claim the support dispatcher is cloud-hosted while it still runs on the Mac.
