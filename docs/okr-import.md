# Private DingTalk OKR import

The operator imports an explicitly reviewed monthly snapshot with `node build/src/cli/import-okr.js`. This is a server-side CLI included by the existing Docker TypeScript build; there is no HTTP import endpoint, user impersonation or new credential. Run it inside the deployed service using its existing `DATABASE_URL` and `DINGTALK_CORP_ID`. Schema migration runs through normal server startup; the CLI never initializes schema, seeds users or falls back to a local database.

```sh
# Default: validates mappings and conflicts, writes no application rows.
node build/src/cli/import-okr.js --file /private/manifest.json --actor-user-id EXISTING_INTERNAL_MANAGER_ID

# Equivalent bounded standard-input preview.
cat /private/manifest.json | node build/src/cli/import-okr.js --stdin --actor-user-id EXISTING_INTERNAL_MANAGER_ID

# Explicitly apply the already reviewed manifest as one transaction.
cat /private/manifest.json | node build/src/cli/import-okr.js --stdin --actor-user-id EXISTING_INTERNAL_MANAGER_ID --apply
```

Input is capped at 4 MiB. Keep exports, manifests and results in private, ignored storage; never commit them, tokens or database connection strings. CLI output contains aggregate counts, source digest and warning counts, not employee descriptions, scores, source fields or database errors. A nonzero exit means validation, conflict or execution failed; do not assume any partial import succeeded. After apply, read back the native counts, source counts and real employee UI independently.

Manifest version 1 is defined strictly by `okrImportManifest` in `src/okr-import.ts`:

```json
{
  "version": 1,
  "source": {
    "provider": "dingtalk", "corpId": "VERIFIED_CORPORATION",
    "documentId": "SOURCE_DOCUMENT", "tableId": "SOURCE_TABLE",
    "period": "2026-10", "url": "https://example.test/source",
    "exportedAt": "2026-10-29T00:00:00Z",
    "snapshotSha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "rowIdStrategy": "verified-identity-parent-item"
  },
  "records": [{
    "sourceKey": "verified-external-id:O1", "kind": "objective", "parentSourceKey": null,
    "ownerExternalUserId": "verified-external-id", "itemLabel": "O1",
    "title": "Original description", "metrics": null,
    "planning": {"weight": 100, "description": "Original description", "type": "mandatory", "scoringDueDate": null},
    "rawFields": [{"name": "Original self score", "value": null}]
  }]
}
```

Every KR uses `kind: "key_result"`, the same verified owner as its parent, and a `parentSourceKey` present in the manifest. KR planning contains only weight, description and optional scoringDueDate. Objective planning additionally permits nullable location, type (`mandatory`/`bonus`) and bonusIncluded. Weights are absolute percentages from 0 to 100: an O at 50 and KRs at 30/20 remain 50/30/20. Warnings report mismatched totals, missing weights/types and scoring dates whose month differs from the imported period; original values remain unchanged.

Metrics are either `null`, or `{baseline,target,actual,direction,unit}` with valid finite baseline/target, increase/decrease direction and unit. Actual may be null when not recorded. Missing metrics stay null, progress remains unknown, and a result without a configured metric cannot receive measurement writes. Valid numeric zero remains zero. No placeholder target, zero completion or invented score is generated.

The actor must be an active, already mapped DingTalk manager in the source organization. Employee ownership resolves exclusively through `(provider,corp_id,external_user_id)` in `external_identities`, and must remain in the actor's existing workspace. Source exports that lack IDs require an explicitly checked external ID during manifest preparation; display names are never automatically matched. All imported goals are personal, including in company workspace mode. This does not grant boss or manager access.

This export has no native row IDs. Synthetic source keys combine a verified employee identity with parent/item labels and are unique across snapshots for the same organization, document and table. The importer serializes its own writes and enforces this unique key in PostgreSQL. Identical normalized source records are skipped even when the export timestamp/file hash changes, and native edits are never overwritten. A changed record under an existing key is a conflict that aborts the entire transaction. Synthetic keys do not resolve renames or deletions: this is a fixed-snapshot import with conflict detection, not incremental synchronization. An operator must not invent new keys to bypass an unresolved conflict.

Original fields live in `okr_source_records`, linked to native O/KR IDs, the batch, content hash and real importing actor's audit event. Blank cells, original formula results, dates and evaluation notes remain source history, not new approvals. `kr_appraisals` and measurements are never populated by this import. The native list responses expose only `importSource` metadata (source URL, period, row label, timestamps and original scoring date). Legacy `rawFields` are available only to the owner or a manager in the same workspace through KR appraisal `legacySource` and `GET /objectives/:id/source`; ordinary list responses do not include them. Formula interpretation remains unverified.

Acceptance checks include dry-run with zero writes; complete atomic apply; repeat no-op; changed-source and mapping failures with zero partial writes; rollback; preserved absolute weights/nulls; owner/manager-only legacy reads; and no changes to existing numeric workflows or human appraisal records.
