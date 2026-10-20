# Application automation

Schedules publish queue messages over time. Collection triggers publish messages
inside record writes. External workers claim and process those messages using
[queue leases and permissions](queues.md). Neither producer executes arbitrary
code.

## Schedules

Create the destination queue first:

```sh
saas schedules create --queue jobs \
  --payload '{"job_id":"daily-report","title":"Daily report"}' \
  --at 2026-10-15T09:00:00Z
saas schedules create --queue jobs \
  --payload '{"job_id":"weekly-report","title":"Weekly report"}' \
  --recurrence $'DTSTART;TZID=America/Los_Angeles:20261015T090000\nRRULE:FREQ=WEEKLY'
saas schedules list --limit 20
saas schedules show <schedule-id>
saas schedules pause <schedule-id>
saas schedules resume <schedule-id>
saas schedules update <schedule-id> --payload-file report.json
saas schedules delete <schedule-id> --confirm
```

Use exactly one of `--at` (UTC ending in Z) or `--recurrence`. Recurrence stores
local `DTSTART;TZID`, `RRULE` and optional `EXDATE` lines. `--timezone` can supply
the TZID for a bare local DTSTART or must match the embedded TZID; it cannot
accompany `--at`. Payload input is `--payload` or `--payload-file`.

REST creation at `POST /v1/orgs/:orgId/schedules` uses:

```json
{
  "queue": "jobs",
  "payload": { "job_id": "daily-report", "title": "Daily report" },
  "timing": { "kind": "once", "at": "2026-10-15T09:00:00Z" }
}
```

Recurring timing is `{ "kind": "recurring", "recurrence": "DTSTART;TZID=..." }`.
Timezone is derived from the recurrence.
MCP `schedules_create` takes this same object. List/show/update/delete use
`schedules_list`, `schedules_show`, `schedules_update` and `schedules_delete`.
Pause/resume are patches with `enabled: false/true`.

Creation requires write on `/schedules` and creator enqueue authority on the
destination. Read/update/delete require those respective actions on
`/schedules/<id>`. Creation does not automatically grant the creator management
or read access. Read grants disclose the stored schedule payload. Editing also
rechecks the original creator's current destination authority; fire time checks
membership and queue create authority again.

Each occurrence's enqueue and durable cursor advance commit together. A unique
schedule/UTC-occurrence identity prevents duplicate publication on retries.
After downtime, recurring schedules publish once for missed work and advance
to the next occurrence after the current time. Changing timing resets the cursor for the new definition;
already materialized entries remain unchanged. Revoked authority or invalid
schema pauses with `pause_reason`; inspect, repair grants/schema and resume.
Transient database failures roll back enqueue and cursor together.

SQLite ticks every 10 seconds using croner; PostgreSQL ticks every minute using
pg-boss. Availability is an earliest time, not a guaranteed delivery deadline:
tick delay, backlog, worker polling and retries add latency. Application tables
hold durable state. Notification schedules keep their separate audience/inbox
API and share occurrence locking/cursor helpers; see [notifications](notifications.md).

## Collection triggers and publication

For a `tickets` collection with a `title` field and the `jobs` queue above,
write `mapping.json` with explicitly tagged destination fields:

```json
{
  "job_id": { "kind": "metadata", "key": "recordId" },
  "title": { "kind": "after", "field": "title" }
}
```

```sh
saas triggers create --collection tickets --queue jobs --events update \
  --watch-fields title --where '{"title":{"contains":"urgent"}}' \
  --mapping-file mapping.json
saas triggers list
saas triggers show <trigger-id>
saas triggers pause <trigger-id>
saas triggers resume <trigger-id>
saas triggers update <trigger-id> --mapping-file mapping.json
saas triggers delete <trigger-id> --confirm
```

REST `POST /v1/orgs/:orgId/triggers` and MCP `triggers_create` accept
`{collection,queue,events,watched_fields?,where?,mapping,enabled?}`. MCP list/show/
update/delete are `triggers_list`, `triggers_show`, `triggers_update` and
`triggers_delete`. The CLI also accepts `--where-file` instead of `--where`.

Mappings are `literal` with `value`, `before`/`after` with `field`, or `metadata`
with `key`: `recordId`, `collectionName`, `event`, `occurredAt`. Before is
unavailable for create, after for delete; use separate triggers when necessary.
Predicates inspect after for create/update and before for delete. Watched fields
require an update event. Updates fire only on actual watched changes, or any
changed field if no watch is configured. No-op updates never fire. At most 25
enabled triggers are allowed per collection.

Creation requires write `/triggers`, creator read access to all mapped, watched
and predicate source fields, and destination create authority. Read/update/delete
use `/triggers/<id>` with the corresponding action. Reading a trigger reveals its
mapping/literals. Execution rechecks the creator's membership, source row/field
read constraints and destination create constraints. Only explicitly mapped,
authorized data is published, including on delete; no arbitrary source snapshot
is allowed.

Every record mutation path, including batch, REST, MCP and bounded transactions,
publishes through the same unit of work. Source mutation, event identity and
queue enqueue commit together. Authorization/schema invalidation pauses the
trigger visibly and lets the source write proceed. Persistence failures roll
back the write. Retry identity prevents duplicate publication for one mutation.
External workers can create feedback cycles by writing back to collections;
choose business keys and guards to avoid repeated work.

## Atomic transactions

Prepare a request file and submit it once:

```json
{
  "idempotency_key": "ticket-and-note-42",
  "operations": [
    {
      "op": "record.update",
      "collection": "tickets",
      "id": "<record-id>",
      "data": { "title": "urgent report" }
    },
    {
      "op": "record.create",
      "collection": "notes",
      "data": { "title": "Escalated ticket 42" }
    }
  ]
}
```

```sh
saas --json transactions execute --input transaction.json
```

REST `POST /v1/orgs/:orgId/transactions` and MCP `transactions_execute` take the
same request. Use 1..25 ordered `record.create`, `record.update`, or `record.delete`
operations across collections, capped at 1 MiB of transaction JSON. REST ingress
also limits the raw body to 1 MiB. MCP limits the whole JSON-RPC envelope to
16 MiB and applies the transaction limit to parsed tool arguments.
Each operation uses existing row/field permissions. Record writes, history,
trigger publications and transactional audits commit or roll back together.
Each operation takes literal IDs and payloads.
Matching record triggers publish their queue messages within the same transaction.
[Record history](record-history.md) correlates its mutations with one `change_set_id`.

Idempotency keys are scoped to organization and principal, retained seven days.
The background scheduler removes expired receipts, including keys never reused.
Same canonical requests return saved results without repeating writes;
conflicting requests return 409. Replays reauthorize result visibility after
revocation. CLI performs no automatic retry; `--idempotency-key` may supply an
absent key or match the file's key.

## Export and restore

Organization export/import includes queue definitions, processing policies, schedules
and triggers. Export requires manage `/system/export`; import requires manage
`/system/import`. Import remaps references and restores schedules/triggers paused.
Inspect their configuration and creator permissions before resuming them.

Pending jobs, delivery state and occurrence history belong to database backups.
SQLite backups must include both application and Bunqueue databases; PostgreSQL
backups must include the pg-boss schema. See [backend operations](job-backends.md).
