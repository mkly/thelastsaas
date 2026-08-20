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

There is one principal type: a user. CLI and agent requests act through the
user's delegated, rolling session. Organization scope never comes from hidden
session state.

## Data primitives

Collections own dynamic schemas. Records store schema-validated JSON plus
native database timestamps and creator identity. The recursive Where DSL is
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

Notifications use a durable queue with retry and deduplication. The scheduler
turns one-shot or recurring schedules into queue entries. SQLite uses an
in-process scheduler; PostgreSQL deployments can use pg-boss.

## Databases and portability

`schema.prisma` is the only hand-edited Prisma schema and targets SQLite. A
script generates the PostgreSQL variant by changing only the provider literal.
SQLite migrations are not replayed against PostgreSQL; generate provider-
specific SQL or use `prisma db push` for PostgreSQL.

Organization export/import reconstructs schemas before records and provides a
portable backup and cloning boundary. Audit rows preserve the acting user,
operation, resource, and details.
