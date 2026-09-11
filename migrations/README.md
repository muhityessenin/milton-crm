# Milton CRM PostgreSQL migrations

These migrations support the PostgreSQL HTTP backend. They do not import
`data/db.json` and do not change frontend contracts.

## Order

1. `001_initial_schema.sql` creates tables, foreign keys, checks, indexes, and the permission catalog.
2. `002_integrity_and_security.sql` adds timestamps, booking synchronization, payment-correction validation, Owner protection, and the protected permanent-delete function.
3. `003_preserve_trial_completion_behavior.sql` keeps the existing API rule that a paid/resulted trial may be closed before its scheduled time.
4. `004_concurrency_and_idempotency.sql` adds optimistic row versions and payment idempotency protection.
5. `005_realtime_trial_receipts_and_schedule.sql` adds trial-payment metadata, persistent receipt references, historical occupied slots, and commit-safe PostgreSQL change notifications.
6. `006_unassigned_trials.sql` adds an explicit unassigned trial state, preferred-time fields, assignment concurrency versioning, reminder configuration, and assignment permissions without adding a CRM status.
6. `tests/verify_schema.sql` validates the catalog and exercises critical constraints inside a transaction that is always rolled back.

## Application requirements for the future cutover

- Preserve the existing text IDs during JSON import.
- Store only a SHA-256 hash of each session token in `sessions.token_hash`.
- Create, reschedule, or complete trials inside database transactions. Active trial insertion locks and synchronizes its slot.
- Call `permanently_delete_client(client_id, actor_user_id, 'УДАЛИТЬ')` for hard client deletion. Direct client deletion is rejected unless the transaction actor is an active Owner.
- Keep the server API contract unchanged until the PostgreSQL adapter passes all current CRM tests.

The `DATABASE_URL` remains local in `.env` and is intentionally excluded from Git.
