# Milton CRM architecture

## Core invariants

1. `Client.normalizedPhone` is the identity key. All supported Kazakhstan formats normalize to `+7XXXXXXXXXX` before duplicate checks.
2. Manager and Closer IDs point to the same `Client`; there is no role-specific client table or copy.
3. Trial lessons, payments, notes, and history are append-only collections. Rescheduling closes an active trial and adds another trial.
4. Reference records are deactivated, never removed. Historical foreign keys remain displayable.
5. Status behavior follows `actionType` and `requiredFields`; visible names do not drive logic.
6. Payment attribution is captured on the payment record and analytics use `paymentDate`.

## Authorization

| Capability | Admin | Manager | Closer |
|---|---:|---:|---:|
| View all clients | Yes | Own | Assigned |
| Register and schedule | Yes | Yes | No |
| Change status | Yes | No | Assigned |
| Record payment | Yes | View | Assigned |
| Generate closer availability | Yes | No | Own |
| Analytics / export / configuration | Yes | No | No |

Every mutating endpoint rechecks the actor on the server. UI visibility is convenience, not authorization.

### Flexible permissions

Authorization now resolves in this order: a user-specific override, then the assigned role template, then default deny. The three system templates (`ADMIN`, `MANAGER`, and `CLOSER`) are migrated onto existing accounts without changing their historical business-role field. Custom roles use a base business role for existing Manager/Closer attribution while permissions remain independently configurable.

Clients, schedules, payments, and analytics support `OWN`, `TEAM`, and `ALL` scopes. `TEAM` uses the nullable `teamId` prepared on each user; no team-management complexity is exposed until the business needs it.

Branding is stored under database metadata (`companyName`, `logoUrl`, and `accentColor`). Logo uploads are persisted as validated image data URLs in the current storage adapter. A PostgreSQL/object-storage deployment should move logo bytes to object storage and retain only the resulting URL.

## Booking transaction

The service validates that the selected slot belongs to the selected Closer and
is `FREE`, locks the relevant rows, creates the Client and TrialLesson, and marks
the slot `BOOKED` in one PostgreSQL transaction. Rescheduling closes the old
trial and reserves the new slot in the same transaction. Partial unique indexes
prevent more than one active trial per slot or client.

## Status actions

- `NONE`: status-only transition.
- `REQUIRE_REFUSAL_REASON`: validates an active Admin-managed refusal reason.
- `REQUIRE_RESCHEDULE`: validates a real free slot, releases the old booking, preserves the old trial, and creates the new trial.
- `REQUIRE_PAYMENT`: validates amount, active payment method, and explicit payment date, then appends a payment with historical attribution.

## Finance and salary

Finance is a derived read model over active payments and completed trials; it does not duplicate accounting records. Payment rows keep their original Manager/Closer attribution, while effective-dated employee rates and payment-method bank commissions preserve the conditions that applied to each operation. A deal with a positive `totalDealAmount` accrues no employee commission until active, non-voided payments cover the full amount. Conducted-trial bonuses use configured qualifying statuses and one immutable trial result, so one trial can contribute at most one bonus.

Current team membership limits who team leaders can view, but never rewrites historical attribution. Company totals, detailed payment rows, client finance history, and export are separate server-enforced permissions. Refunds are marked through an additive status flag and are never silently deducted from salary.

## Persistence and production boundary

The production adapter uses PostgreSQL through `pg`; JSON remains available for
local demos. Critical writes use repositories, row locks, constraints, and
database transactions. Legacy read endpoints still consume an API-shaped read
model. PostgreSQL read models are cached briefly to coalesce bursts, but future
large datasets should move list/search/analytics endpoints to paginated SQL.

Production runs the app and PostgreSQL as separate containers on one private
Docker network. PostgreSQL uses a persistent volume and must not publish port
5432. Backups must be copied to encrypted storage outside the VPS and restore
procedures must be tested regularly.
