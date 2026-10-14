# Architecture

The Last SaaS is a Bun and TypeScript monorepo. Hono exposes an organization-scoped
REST API; Prisma persists application and BetterAuth data; Casbin handles
resource gates; the CLI consumes the Hono route type through `hc`.

## Request flow

1. Application middleware injects configuration, Prisma, storage, auth,
   notification queue, and audit helpers.
2. BetterAuth validates the user's cookie or bearer session.
3. The `:orgId` path segment is checked against the user's membership.
4. Casbin evaluates the requested resource and action.
5. Collection middleware resolves row and field filters for record operations.
6. Zod validates input, the database layer performs the operation, and Hono
   returns a typed response.

Human sessions and organization-bound service-account API keys resolve to a user
principal and current membership. CLI API tokens use `x-api-key`; rolling human
sessions use bearer/cookie authentication. REST organization scope is explicit;
MCP resolves its selected organization at request start.

## Data primitives

Collections own dynamic schemas. Records store schema-validated JSON plus
native database timestamps and creator identity. Record mutations append full
before/after snapshots in the same transaction to a separate 30-day history.
History reads apply current row and field permissions to saved versions, including
deleted records. The audit log and idempotency receipts have independent retention. The recursive Where DSL is
shared by record queries and row filters, avoiding a second condition language.

Casbin policies provide the coarse gate. Row filters narrow visible records;
field filters narrow readable and writable field names. Read filtering also
applies to query predicates, aggregate fields, exports, and recurrence
expansion.

Recurrence is a field type, not a separate domain model. Values contain
`DTSTART;TZID`, `RRULE`, and optional `EXDATE`. `occurs_between` performs an SQL
prefilter, expands in the stored timezone, applies strict caps, and paginates
the expanded result.

Files are streamed through a `Storage` interface backed by local disk or S3.
Metadata and unique per-organization paths live in the database. Slash prefixes
provide organization without a separate hierarchy model.

Queues store immutable payloads and one native job per job ID.
PostgreSQL uses pg-boss, SQLite uses embedded Bunqueue with a transactional outbox.
Workers receive whole payloads after organization and queue authorization.
Libraries own job lifecycle; application rows retain identities and audit events.

Schedules publish once for missed work after downtime. Triggers publish within
source record transactions and preserve collection row/field permissions.
Notification rows hold inbox/channel state while private native queues deliver.
See [workers](../docs/queues.md), [backends](../docs/job-backends.md), and
[automation](../docs/automation.md).

## Databases and portability

`schema.prisma` targets SQLite; the generation script produces the PostgreSQL
variant. SQLite migrations do not run against PostgreSQL. Generate provider-specific
SQL or use `prisma db push` for a new PostgreSQL database.

Organization export/import reconstructs configuration and records. Queue runtime
state belongs to database backups. Imports restore schedules and triggers paused.
Secret values use AES-256-GCM with organization/secret/version authenticated
identity. Metadata read is separate from reveal. Back up key material separately.
