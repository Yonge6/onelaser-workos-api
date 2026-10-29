# Source-bound OKR import implementation plan

**Goal:** Import a reviewed DingTalk monthly snapshot without manufacturing metrics, appraisals, identities or duplicate records.

**Architecture:** A strict source manifest is validated by a server-side import service. A private CLI defaults to read-only preview; explicit apply writes one transaction using existing verified employee mappings. Legacy fields remain in a separate owner/manager-only archive. No HTTP import endpoint is added.

**Tech stack:** TypeScript, Zod, PostgreSQL/PGlite, Node CLI, existing authenticated Fastify read routes.

1. Freeze manifest version 1 and synthetic source keys; retain complete original row fields and provenance, with no implied incremental synchronization.
2. Permit unknown native KR metric fields and guard progress/measurement calculations. Keep existing numeric creation and appraisal rules.
3. Add source/batch tables, serialized transactional import, exact content-hash no-ops and fail-closed conflicts. Resolve external identities, verify the real manager actor and preserve source weights/dates.
4. Expose only basic source metadata on native OKRs. Read legacy fields through existing appraisal scope and an equivalently protected objective source endpoint.
5. Package an operator CLI in the production image. Require DATABASE_URL and actor ID, default dry-run, explicit --apply, optional --stdin. Never initialize schema or seed data from this CLI.
6. Test empty metrics, identity/tenant/role boundaries, complete rollback, idempotency, changed-source conflicts, unchanged native edits and source privacy. Production apply remains a separate authorized operator action.
