# Company support integration

The authenticated Work OS frontend has native Support and Knowledge modules. The existing support pilot remains the only Zoho/Grok dispatcher; it is not yet migrated off the Mac. The outbound connector is read-only locally and writes bounded snapshots to PostgreSQL. It never exports credential files, raw mail snapshots, delivery payloads, approval keys or customer-send capabilities.

## Knowledge center / Wiki

The primary Knowledge center / Wiki is a native Work OS section. It uses the shared sidebar, typography, language and theme controls, with no iframe or original-site JavaScript. `#knowledge/` routes cover overview, all guides, families, full-text search, downloads and complete articles. The original public GitHub Pages site remains unchanged.

The fixed public package is still served under `/wiki/`, from `Yonge6/onelaser-support-center` at the full commit in `deploy/wiki-revision.txt`. `tools/fetch-wiki.mjs` accepts only the 259 known public files, including 236 articles, and verifies each Git blob and declared size. It rejects unknown paths, inconsistent indexes, symlinks and private-operation or published/approved flags. The two previously recorded compatibility patches affect only the standalone public site's navigation scripts; native Work OS reads its unchanged JSON and assets directly. Updates remain explicitly reviewed and pinned.

The native renderer preserves the original technical text, 2181 images, 314 tables, 2691 complete TOC entries, 486 internal article links and 221 external links. It rebuilds source HTML using explicit tag/attribute/URL allowlists, prefixes source IDs, preserves table spans, and strips scripts, event attributes, forms and privileged application attributes. Source metadata is escaped too. Internal links map only known article IDs or exact source URLs; unmatched original HTTPS links remain external with safe target attributes. Interface translation never rewrites technical text. No private records are included in Wiki routes or public data.

Caddy denies child frames in the main employee shell. It permits the existing seven HTTPS image hosts plus `document-image.mubu.com`, the audited Mubu redirect destination, for native article images. Script/connect/font sources stay same-origin; API and OAuth response policies are unchanged. The standalone `/wiki/` compatibility package keeps its previous policy. Original remote media and downloads remain linked, so this is not an offline mirror and pre-existing source placeholders remain source limitations.

Archive & review retains authenticated article snapshots and human review records. API permissions, actor attribution, content hashes and freshness checks are unchanged. Navigating away or opening a newer record invalidates late detail responses. Shared theme/language changes preserve unsaved company review forms. Source content stays marked as awaiting review: displaying it does not approve technical content, publish knowledge, activate SLA or send customer messages. The static `/wiki/` data contains only already-public material and does not require an employee session.

Configure private Render variables:
- `WORKOS_SUPPORT_ORG_ID`: existing Work OS organization identifier.
- `WORKOS_SUPPORT_INGEST_TOKEN`: a new random secret (32+ characters), scoped only to snapshot ingestion.
- `WORKOS_SUPPORT_USER_IDS`: explicit internal account IDs allowed to read customer support records.
- `WORKOS_SUPPORT_REVIEWER_IDS`: explicit internal account IDs allowed to record source-bound human review findings.

Existing executive accounts gain support visibility only in the configured support organization. Public Wiki material is available to authenticated employees in that organization. Reviews bind the actual authenticated account and exact content hash. They do not approve customer sending, publish knowledge, activate SLA or enable automatic answer reuse. Legacy local review records are not silently converted into new authenticated approvals.

`tools/support/publish_snapshot.py` uses an operator-owned mode-0600 JSON configuration with `origin`, `token` and `projectRoot`. Only craftos.app and the current Render hostname are accepted. Run `--dry-run` for a local schema-source/count check, `--once` for one ingestion, or without either for the single-instance 60-second loop. It reads the established SQLite database in a consistent read-only transaction and never starts another worker. It checks the DevSSD volume identity before each pass. No autostart installation is implied by launching the loop.

Ingestion is tenant-bound, bounded to 8 MiB and rejects older/conflicting timestamps, duplicate IDs and unrelated draft references. The session credential cannot ingest; the connector credential cannot read. Screens label snapshots older than 180 seconds and reject review writes until refreshed. Poller and deadline-check timestamps are separately displayed: a fresh upload does not prove the automation is running.

Production cutover must independently verify the real employee session and loaded records. Keep customer content out of GitHub and public QA artifacts. A subsequent worker migration must preserve the old database, checkpoints, existing callback tools and ambiguous-job handling, with only one active dispatcher.
