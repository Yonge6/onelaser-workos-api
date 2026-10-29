# Tracked ticket search and reply comparison

Implement local search across authorized tracked ticket number, subject, status and attention reasons, with match count and empty result state. Keep the existing tracked-scope disclosure.

Open ticket details in a wide native two-column dialog. The left retains versioned AI source drafts and human reviews. The right lets authorized support staff copy a selected draft, edit the final response and save immutable revisions with the exact draft hash and ticket revision. Saving is internal; actual delivery stays in Zoho. Preserve unsaved input during interface/theme changes and failed writes.

Read successful public outbound agent EMAIL threads with existing Zoho read credentials. Verify ticket department/org and thread metadata, read the Get Thread include=plainText body (never list summaries), with complete original MIME fallback when text is absent or explicitly truncated; retain text, source thread ID and time, and do not infer that an outbound message adopted an AI draft. Attach confirmed inReplyToThreadId where available; unmatched replies remain visible with explicit matching status. Cache only in the connector private directory. Export the latest three qualifying sent replies per tracked ticket, rotate one due ticket per cycle, cache complete bodies for up to 24h, and bound aggregate reply text to 2MB. Export bounded records through the existing authenticated support snapshot. A read failure keeps previous verified records and exposes an unknown/stale sync state.

Store manual revisions in PostgreSQL independently from snapshots with authorization, CSRF, exact source binding, optimistic conflict detection, request idempotency and audit metadata. Manual text and observed delivery are separate. Comparison records are candidates for human-reviewed learning; no automatic model training or knowledge publication is introduced.

Verify API scope, source conflicts, duplicate requests, editor retention, escaped untrusted text and read-only outbound filtering with fictional fixtures. Publish the pinned frontend/API after CI; verify assets and real authenticated UI. Production customer sending stays on the existing manual Zoho path.

Source contract: https://desk.zoho.com/DeskAPIDocument (Get Thread, include=plainText, Desk.tickets.READ). Live read verification returned three successful public agent email bodies through the existing adapter; customer delivery was not invoked.
