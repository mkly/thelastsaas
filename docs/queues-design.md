# Queue and automation contracts

The authoritative request validators, DTOs and service interfaces live in
`packages/shared/src/{queue,schedules,triggers,transactions}.ts`.
REST, MCP and CLI use the same services and permissions. Wire fields are
snake_case; dates are ISO UTC strings. Public routes are under
`/v1/orgs/:orgId`; permission paths omit that prefix.

## Storage and transactions

Application tables own queue definitions, immutable job payloads and claim
credentials. Each job uses the same ID in the application and native backend.
pg-boss (PostgreSQL) and Bunqueue (SQLite) own state, attempts, leases, retry
scheduling and retention. Public lease tokens are random, hashed in storage,
and tied to the claiming account; native tokens never leave the server.

Outer services own transactions. `UnitOfWork` carries the Prisma transaction,
database provider, change-set ID and registered job backend. Record mutations,
record history, trigger events,
schedule occurrences, publication and audit rows share that unit. PostgreSQL
publication joins the transaction using pg-boss's Prisma adapter. SQLite stores
a transactional outbox, then publishes durable jobs into Bunqueue's separate
SQLite file. Stable IDs deduplicate handoff replay while native jobs are retained.
See [backend operations](job-backends.md) for runtime and backup requirements.

Notification jobs use a private native queue per organization. Notification rows
retain inbox/read state and channel results. Successful channels are skipped on
retry; a crash between external delivery and recording success can still duplicate
an effect. Application code continues to check recipient permissions/preferences.

## Authorization and producers

Queue permissions apply to the whole queue. Authorized workers
receive full job payloads; use separate queues for different access boundaries.
Collection row/field restrictions remain in effect, including source access for
triggers and record operations inside transactions. Membership and current grants
are checked on each worker request. See [permissions and commands](queues.md).

Schedules persist an occurrence identity and advance their cursor atomically
with publication. After downtime they publish once for missed work, then advance
to the next occurrence after the current time. Collection triggers publish only
explicit mappings of authorized source fields. Both producers recheck creator
authority; invalid authority/schema pauses them, while persistence errors roll
back the source write or occurrence. See [automation](automation.md).

## Portability

Organization export/import includes queue definitions, processing policies, schedules
and triggers. Import remaps configuration references and restores producers
paused. Pending jobs, delivery state, occurrence ledgers and transaction replay
receipts and retained record history belong to database backups.

## API conventions

Success envelopes use `status: "ok"`; domain errors use
`{status:"error",error,message}`. Unknown fields in request control objects are
rejected. Pagination uses resource-scoped keyset cursors (`limit` 1..100).
Job inspection joins identities to native current state, so a state-filtered
page may be empty while a continuation cursor remains.

Immutable enqueue receipts enforce schema validation and idempotency; consumer
side effects still require business-level idempotency. Native job retention bounds
deduplication.
