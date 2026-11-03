# Key Patterns

## Dynamic schemas

Fields use either a type string or `{ "type": "...", "description": "..." }`.
Supported types are string, text, number, integer, float, boolean, date,
datetime, JSON, recurrence, enums, collection references, and attachments.
Reference objects accept `multiple:true`; attachments and multiple references
contain ordered unique ID lists. Field names are
validated before interpolation into SQLite JSON expressions.

## Where DSL

Boolean nodes contain exactly one of `and`, `or`, or `not`. Leaf fields accept
a scalar equality value or `eq`, `not`, `gt`, `lt`, `gte`, `lte`, `contains`,
`in`, `is_null`, `between`, and `occurs_between`. User predicates and applicable
allowed record IDs are composed before querying.

`contains` escapes SQL wildcard characters. Empty `in` lists are always false.
Limits are bounded. Aggregate aliases may be used by `having` and `order_by`.

## Permission composition

Casbin stores `cond` in `v3` and the denial `msg` in `v4`. The matcher checks
roles, resource paths, exact actions (or `*`), and `eval(p.cond)` with the shared
rule context. Read policies evaluate rows in a batch and pass allowed IDs as one
SQL array parameter. A true policy avoids scanning rows. Writes recheck current
policies against before/proposed data inside the UnitOfWork.

Field policies use `/collections/<name>/fields/<field>` (or `*`). Check each field
once per request and project allowed fields; reject queries referencing hidden
fields. Each changed field also needs create/update permission. Fields cannot
have record-dependent conditions. Rules use `r.usr.id`, `r.usr.email`, `r.usr.org`,
`r.obj.data`, `r.next.data` and lazily loaded `refs`. See [permissions](../docs/mcp.md#conditional-permissions).

## Recurrence

Store local recurrence content with `DTSTART;TZID`, `RRULE`, and optional
`EXDATE`. Expansion must have a bounded UTC window. Row filtering happens before
expansion; pagination happens after expansion. A field without read permission
cannot be referenced by `occurs_between`.

To change one occurrence, exclude its original local start from the series and
write a linked standalone record. This keeps exceptions visible to ordinary
record queries and access rules.

## Storage and database providers

Stream uploads directly to the configured `Storage` implementation. Database
rows hold metadata; object keys use organization and file IDs. Validate relative
paths and enforce the configured size limit before committing metadata.

Keep `schema.prisma` provider-neutral except for its SQLite provider literal.
Generate the PostgreSQL schema; do not hand-maintain a second model definition.

## Errors

Domain failures extend `LastSaasError` and serialize through `errorResponse`.
Malformed request bodies return 400, missing resources return 404, and denied
fields or policies return 403. CLI handlers convert failed responses to
`CliError` so command exit codes remain nonzero and predictable.

## Record history

Capture validated, persisted snapshots through `publishRecordMutation` inside
its `UnitOfWork`. Imports append creation history using the same storage helper.
Keep one `changeSetId` per unit and one history row per actual mutation; semantic
no-ops and idempotent replays produce none. Internal monotonic positions order
mutations, including equal timestamps. Do not expose positions in public cursors.

`queryRecordHistory` is the shared read service. Evaluate current record grants
on each saved version, then project permitted fields. Omit updates affecting only
hidden fields; paginate visible results, with no hidden-entry totals. Read-time
cutoffs and bounded scheduler cleanup enforce 30-day retention independently of
the permanent audit log. See [record history](../docs/record-history.md).

## Queues and transactional producers

Queue payloads reject unknown fields and reuse collection field types, including
omitted/null values. Schema changes
require zero retained entries. Claim and settlement require whole-queue read/update permissions and an owned
lease token. Authorized workers receive full payloads. Collection policies still apply.

Keep outer transaction ownership in services. Pass `{db,provider}` through record
mutation, enqueue, trigger publication and occurrence materialization; do not
open nested transactions or infer a provider from the transaction client.
Queue enqueue idempotency expires with retained entries; transaction idempotency
is scoped to organization+principal for seven days. Public claim tokens are returned only by claim and excluded from logs/audit/export.
Their hashes and native backend tokens remain private.
Processing is at least once: external effects require consumer idempotency.

Schedules and triggers recheck their creator at execution. Authority/schema
invalidation pauses the producer with a safe reason; persistence failures roll
back publication with the source write/cursor. Imports restore configuration and
pause producers. See [contracts](../docs/queues-design.md), [workers](../docs/queues.md)
and [automation](../docs/automation.md).

REST routes attach shared Zod validators through `@hono/zod-validator`; the chained
`apiRouter` supplies `ApiType` to Hono clients. Do not handwrite client API shapes.
`lib/transport.ts` shares validation diagnostics and domain error envelopes across
REST and MCP. Validation reports paths and issue codes without submitted values;
logs use route templates and error types. Hono body limits bound transport ingress.

## Relationships and attachments

`synchronizeRecordLinks` validates newly assigned targets and persists indexed
links with record JSON in the same UnitOfWork. Names remain schema keys.
`relationshipPredicates` resolves target grants and compiles scoped SQL subqueries;
`expandRecords` batches target reads and projects each target independently.
Deletion services lock PostgreSQL target rows before checking incoming links;
foreign-key insertion locks coordinate these checks. Organization deletion
cascades its whole graph. SQLite uses its transactional write serialization.

`attachment-access.ts` centralizes current and historical file authorization.
Contextual upload completion sets `standalone=false` and updates the containing
record within its UnitOfWork. `record_history_files` pins bytes referenced by
snapshots; history cleanup releases pins. File deletion checks live/history pins
before deleting metadata and then storage bytes. Library listings select only
standalone files. See [relationships](../docs/relationships.md) and
[attachments](../docs/attachments.md).

## Collection validation

Collection `validations` store named expressions or count/sum queries and safe failure messages. REST, MCP and CLI create/update accept replacement arrays. The database layer validates expressions and reference-field names when saving. Record create, batch, update and import evaluate applicable rules inside their UnitOfWork using the shared Casbin expression pipeline. Transition rules referencing `r.obj` skip creates. Rule references load full tenant-scoped target data only for evaluation; failures expose configured messages.

Query rules fill `$next.<field>` values, then use countRecords/aggregateRecords in
the same UnitOfWork, excluding the record being updated. Sums add the proposed
value. Field uniqueness sees every row, as do query rules and reference checks.
These application checks do not serialize simultaneous conflicting PostgreSQL
writes. SQLite serializes writes. Validation always applies to administrators.
