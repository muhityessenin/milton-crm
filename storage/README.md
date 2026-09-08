# Milton CRM storage layer

The HTTP API supports both the JSON adapter and PostgreSQL without changing its
routes or response shapes. JSON remains the default until data import and final
cutover are explicitly approved.

## Configuration

- `STORAGE_BACKEND=json` is the default and keeps using `data/db.json`.
- `STORAGE_BACKEND=postgres` selects PostgreSQL when code calls
  `createStorage()` directly. It requires `DATABASE_URL` and migrations 001–003.
- `server.js` runs the same HTTP API through either backend. PostgreSQL requests
  load a consistent read model and flush changes as one transaction.

Do not put credentials in `.env.example`; the local `.env` remains ignored.

## Repository coverage

Both adapters expose repositories for users, roles, clients, trials,
availability slots, payments, status/source/tag/reason/method reference data,
notes, history, notifications, audit logs, saved filters, sessions, and app
settings. PostgreSQL roles also expose the permission catalog and persisted role
permission/scope records.

The PostgreSQL storage provides transactions for client registration with trial
booking, trial rescheduling, payment creation/correction, client archive and
restore, and protected permanent client deletion.

## Current HTTP boundary

Moved behind the storage unit-of-work:

- initial file creation, load, legacy migration, and atomic save;
- test-state replacement;
- session access (in-memory for JSON, hashed and persisted for PostgreSQL).

All HTTP handlers now execute inside the selected storage unit-of-work. The
business rules still use the established API-shaped read model, but it is no
longer a process-global JSON database. PostgreSQL changes are diffed and written
through repositories before the buffered response is sent.

## Tests

`npm test` keeps PostgreSQL integration skipped and runs the existing CRM suite.
Run `npm run test:postgres` or `npm run test:postgres-api` only with an
authorized development `DATABASE_URL`.
The integration suite wraps its fixtures and workflows in one outer transaction
and rolls it back, leaving no test business rows behind.
