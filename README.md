# Milton CRM

A runnable, role-aware sales CRM for Milton English Language Center, centered on the workflow **Lead → Trial lesson → Payment**.

## Run

Node.js 20 or newer is the only requirement.

```bash
npm start
```

Open [http://localhost:4173](http://localhost:4173).

Demo accounts (all use password `demo123`):

| Role | Login |
|---|---|
| Admin | `admin@milton.kz` |
| Manager | `manager@milton.kz` |
| Closer | `closer@milton.kz` |

Storage is selected with `STORAGE_BACKEND`. Local demo mode uses the gitignored
`data/db.json`; production uses PostgreSQL and requires migrations 001–005.
Delete the JSON file only when you explicitly want to restore the demo seed.

## Verification

```bash
npm run check
npm test
```

## Included flows

- Separate Admin, Manager, and Closer accounts with role-scoped records and navigation
- Editable role templates, custom roles, per-user permission overrides, and OWN/TEAM/ALL scopes
- Persistent company name, logo, and accent-color branding
- One shared client record with Kazakhstan phone normalization and duplicate protection
- Closer availability generation (30/45/60 minutes), free-slot booking, and locked booked slots
- Admin-configured statuses, colors, required fields, and action types
- Refusal, reschedule, and payment status workflows with server-side validation
- Append-only notes, client activity, trial history, and payment history
- Original-manager and closing-closer sale attribution
- One-hour overdue indicator without mutating the CRM status
- Role dashboards, dynamic Kanban, global search, internal notifications, and source analytics
- CSV export compatible with Excel
- Responsive desktop/mobile experience with a sticky client drawer

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the data and transaction design and the production hardening boundary.

## Docker and cloud deployment

Production Docker Compose, HTTPS reverse-proxy, migrations, health checks, and
GitHub-to-server deployment instructions are documented in
[DEPLOYMENT.md](./DEPLOYMENT.md). The frontend is included in the application
container and is served from the same origin as the API.

The production stack runs the application and PostgreSQL in separate
containers. On the first deployment it creates one Owner account from the
`INITIAL_ADMIN_*` values in `.env.production`; further deployments never reset
that account.
