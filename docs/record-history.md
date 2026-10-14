# Record history

Record history retains 30 days of committed creates, updates and deletes. Each
entry stores validated before/after snapshots, the acting account ID, a timestamp,
and a `change_set_id`. Individual writes, batch inserts, atomic record
transactions and organization imports capture history in their database transaction.
Semantic no-op updates, failed writes and idempotent replays add no entries.

## Read changes

```sh
saas --json records history customers
saas --json records history customers <record-id> --limit 25
saas --json records history customers --change-set-id <change-set-id>
```

REST exposes `GET /v1/orgs/:orgId/collections/:name/history` and
`GET /v1/orgs/:orgId/collections/:name/records/:id/history`.
MCP exposes `records_history` with a required `collection` name. All surfaces use
one service and the existing collection read permissions.

| Parameter       | Behavior                                                                  |
| --------------- | ------------------------------------------------------------------------- |
| `record_id`     | Optional record filter; the record REST route supplies this from its path |
| `change_set_id` | Optional correlation filter within the selected collection                |
| `since`         | Inclusive UTC timestamp                                                   |
| `until`         | Exclusive UTC timestamp, later than `since`                               |
| `limit`         | Maximum visible entries, 1..100, default 50                               |
| `cursor`        | Opaque continuation from `next_cursor`, using the same filters            |

CLI uses an optional positional record ID and hyphenated flags such as
`--change-set-id`. All responses contain `items` and `next_cursor`, with
`status: "ok"` at the transport boundary. Entries have this shape:

```json
{
  "id": "<history-id>",
  "record_id": "<record-id>",
  "operation": "update",
  "actor_id": "<account-id>",
  "change_set_id": "<change-set-id>",
  "created_at": "2026-10-14T12:00:00.000Z",
  "before": { "name": "Ada", "status": "pending" },
  "after": { "name": "Ada", "status": "approved" },
  "changes": { "status": { "before": "pending", "after": "approved" } }
}
```

Results follow journal insertion order, newest first. Multiple mutations to one
record in a transaction remain separate and ordered even when timestamps match.
The same unit of work shares a change-set ID across its records and collections.
Query each authorized collection to inspect its entries from that change set.

## Permissions and pagination

Current membership, collection read grants, row conditions and field filters
apply to saved versions. Each version is checked independently against its
stored data and record metadata. A reader can inspect an allowed before-version
even if the after-version moves outside their row access. Deleted records use
their saved before-version for authorization.

Fields used in a permission condition must have saved values compatible with
their current schema types. Incompatible values cannot satisfy that grant;
independent matching grants still apply.

`before` and `after` contain projected record data. A `null` version means the
record did not exist; an omitted version means it is inaccessible. Within
`changes`, an omitted side means that value is absent or inaccessible; use the
projected snapshots to distinguish a missing field from an unavailable version.
Updates confined to unreadable fields are omitted entirely, including their
event metadata. Correlation does not grant access to sibling records or fields.

Pagination counts visible entries only and returns no total. Cursors identify
the last visible entry and are scoped to the caller, collection and filters.
An expired cursor, or one whose anchor is no longer readable, returns a query
error; restart the query to obtain a new page.

## Corrections and retention

Inspect the live record before applying a correction through ordinary record
updates, inserts, deletes or atomic transactions. The same write permissions and
schema validation apply, and corrections receive their own history. A replacement
insert for a deleted record gets a new record ID.

History expires 30 days after capture. Reads enforce that window immediately;
the background scheduler deletes at most 500 expired entries per tick. The audit
log and seven-day transaction idempotency receipts remain independently retained.
Deleting a collection or organization also deletes its record history.

Organization imports capture record creation with the importing actor while
preserving original record metadata. Organization export/import handles current
records; database backups include retained history. SQLite upgrades apply the
additive Prisma migration; PostgreSQL upgrades apply the generated Prisma schema.
Existing records and audit entries are preserved, and subsequent mutations
capture history.
