# Company support integration

The authenticated Work OS frontend has native Support and Knowledge modules. The existing support pilot remains the only Zoho/Grok dispatcher; it is not yet migrated off the Mac. The outbound connector is read-only locally and writes bounded snapshots to PostgreSQL. It never exports credential files, raw mail snapshots, delivery payloads, approval keys or customer-send capabilities.

Configure private Render variables:
- `WORKOS_SUPPORT_ORG_ID`: existing Work OS organization identifier.
- `WORKOS_SUPPORT_INGEST_TOKEN`: a new random secret (32+ characters), scoped only to snapshot ingestion.
- `WORKOS_SUPPORT_USER_IDS`: explicit internal account IDs allowed to read customer support records.
- `WORKOS_SUPPORT_REVIEWER_IDS`: explicit internal account IDs allowed to record source-bound human review findings.

Existing executive accounts gain support visibility only in the configured support organization. Public Wiki material is available to authenticated employees in that organization. Reviews bind the actual authenticated account and exact content hash. They do not approve customer sending, publish knowledge, activate SLA or enable automatic answer reuse. Legacy local review records are not silently converted into new authenticated approvals.

`tools/support/publish_snapshot.py` uses an operator-owned mode-0600 JSON configuration with `origin`, `token` and `projectRoot`. Only craftos.app and the current Render hostname are accepted. Run `--dry-run` for a local schema-source/count check, `--once` for one ingestion, or without either for the single-instance 60-second loop. It reads the established SQLite database in a consistent read-only transaction and never starts another worker. It checks the DevSSD volume identity before each pass. No autostart installation is implied by launching the loop.

Ingestion is tenant-bound, bounded to 8 MiB and rejects older/conflicting timestamps, duplicate IDs and unrelated draft references. The session credential cannot ingest; the connector credential cannot read. Screens label snapshots older than 180 seconds and reject review writes until refreshed. Poller and deadline-check timestamps are separately displayed: a fresh upload does not prove the automation is running.

Production cutover must independently verify the real employee session and loaded records. Keep customer content out of GitHub and public QA artifacts. A subsequent worker migration must preserve the old database, checkpoints, existing callback tools and ambiguous-job handling, with only one active dispatcher.
