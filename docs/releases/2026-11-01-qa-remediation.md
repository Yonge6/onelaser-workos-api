# QA remediation — 2026-11-01

This release keeps the existing task-result lock and all employee authorization boundaries. It fixes unknown progress/on-time data and separates recovery of an unsuccessful model score from modification of a completed result.

- The owner or designated reviewer may retry an unscored completion, including one whose result is already locked. Visible colleagues cannot trigger the provider. Successful scores are returned unchanged.
- Send the current `completionId` to `POST /tasks/:id/completion/rescore` to detect a stale screen. Missing model configuration returns `503 AI_NOT_CONFIGURED` without a provider call. In-flight attempts return 202; a stale claim can be recovered after two minutes.
- Claims and attempt IDs persist in PostgreSQL. Late provider replies cannot overwrite a superseded completion or a newer attempt. Retries are rate limited and recorded in audit events without submitted evidence text. Retrying does not change the completion date or result.
- Capabilities are derived from the exact configured model instance. A key without a model, or an invalid provider base URL, is not ready. Existing Grok Bot evidence review and model-API task scoring remain separate integrations.
- Task lists and board rows return the current accepted submission's human acceptance time. Unknown timestamps are excluded from on-time statistics, with known/unknown coverage counts.
- Profile time zones must be valid named time zones (or unset).

Database changes add only `ai_attempted_at`, `ai_attempt_id` and `ai_attempts` to `task_completions`; startup migration is idempotent and preserves existing results and scores. No production permissions or credentials are changed.

The frontend pin in `deploy/frontend-revision.txt` includes responsive task titles, honest model states, a read-only completion/retry card, prototype assignment isolation and reporting regressions.

Validation: full API and frontend regression suites, new recovery/concurrency/authorization/configuration tests, typecheck/build, pinned Wiki preservation tests, and local browser checks with synthetic data. Real model calls and notification delivery require their existing provider setup and are not claimed by these synthetic tests.

Final browser follow-up: unknown percentage rings expose “Progress unknown” / “进度未知” to assistive technology instead of the drawing fallback 0%. A rendered DOM regression covers all three unknown rings.
