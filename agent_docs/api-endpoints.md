# API Endpoints

Organization membership discovery and creation use the account-scoped
`/v1/orgs` route. All organization data routes are explicitly scoped through
`/v1/orgs/:orgId`. They accept a BetterAuth session cookie, bearer session from device login,
or an organization-bound service-account API token on `x-api-key`.

Organization membership alone grants no data access. Admins receive wildcard
authority when the organization is created. Other members need explicit
Casbin grants. Collection creation requires `write` on `/collections` and
atomically grants the creator `read`, `write`, and `manage` on the new
collection; deletion remains a separate permission.

```text
# System and authentication
GET    /health
*      /api/auth/**
GET    /v1/me
GET    /auth/login
POST   /auth/login
GET    /auth/signup
POST   /auth/signup
GET    /auth/invitations/:invitationId
POST   /auth/invitations/:invitationId
GET    /v1/orgs
POST   /v1/orgs
GET    /auth/magic-link
POST   /auth/magic-link
GET    /auth/forgot-password
POST   /auth/forgot-password
GET    /auth/reset-password
POST   /auth/reset-password
GET    /auth/logout
GET    /auth/dashboard
POST   /api/auth/device/code
GET    /api/auth/device?user_code=...
POST   /api/auth/device/approve
POST   /api/auth/device/deny
POST   /api/auth/device/token
GET    /auth/device?user_code=...
POST   /auth/device/approve
POST   /auth/device/deny

# Collections (required permission)
POST   /v1/orgs/:orgId/collections                    /collections:write
GET    /v1/orgs/:orgId/collections                    filters by collection:read
GET    /v1/orgs/:orgId/collections/:name              collection:read
PATCH  /v1/orgs/:orgId/collections/:name/schema       collection:manage
DELETE /v1/orgs/:orgId/collections/:name?confirm=true collection:delete

# Records
POST   /v1/orgs/:orgId/collections/:name/records
POST   /v1/orgs/:orgId/collections/:name/records/batch
GET    /v1/orgs/:orgId/collections/:name/history
GET    /v1/orgs/:orgId/collections/:name/records/:id/history
GET    /v1/orgs/:orgId/collections/:name/records/:id
POST   /v1/orgs/:orgId/collections/:name/records/:id/related
PATCH  /v1/orgs/:orgId/collections/:name/records/:id
DELETE /v1/orgs/:orgId/collections/:name/records/:id
POST   /v1/orgs/:orgId/collections/:name/records/query
POST   /v1/orgs/:orgId/collections/:name/records/count
POST   /v1/orgs/:orgId/collections/:name/records/aggregate

# Files (library grants or attachment access as indicated)
POST   /v1/orgs/:orgId/files                     write
GET    /v1/orgs/:orgId/files?prefix=<path-prefix> read
GET    /v1/orgs/:orgId/files/:id                  library or attachment read
GET    /v1/orgs/:orgId/files/:id/content          library or attachment read
DELETE /v1/orgs/:orgId/files/:id                  delete; no live/history pins

# Queues: configuration and jobs. Payload access requires whole-queue read.
# Responses carry Cache-Control: no-store.
POST   /v1/orgs/:orgId/queues                     /queues:write
GET    /v1/orgs/:orgId/queues?limit=&cursor=       filters by /queues/:name:read
GET    /v1/orgs/:orgId/queues/:name                /queues/:name:read
PATCH  /v1/orgs/:orgId/queues/:name                /queues/:name:manage
DELETE /v1/orgs/:orgId/queues/:name                /queues/:name:delete
GET    /v1/orgs/:orgId/queues/:name/jobs?limit=&cursor=&where=&state= read
POST   /v1/orgs/:orgId/queues/:name/jobs           create on queue
POST   /v1/orgs/:orgId/queues/:name/claim          read+update on queue
POST   /v1/orgs/:orgId/queues/:name/jobs/:id/ack    read+update and owned unexpired token
POST   /v1/orgs/:orgId/queues/:name/jobs/:id/nack   same
POST   /v1/orgs/:orgId/queues/:name/jobs/:id/extend same
POST   /v1/orgs/:orgId/queues/:name/jobs/:id/cancel queue:manage
POST   /v1/orgs/:orgId/queues/:name/jobs/:id/redrive queue:manage, dead only

# Schedules and triggers (creator authority rechecked on edit and execution)
POST   /v1/orgs/:orgId/schedules       /schedules:write + destination create
GET    /v1/orgs/:orgId/schedules       filters by /schedules/:id:read
GET    /v1/orgs/:orgId/schedules/:id   read
PATCH  /v1/orgs/:orgId/schedules/:id   update
DELETE /v1/orgs/:orgId/schedules/:id   delete
POST   /v1/orgs/:orgId/triggers        /triggers:write + source read + destination create
GET    /v1/orgs/:orgId/triggers        filters by /triggers/:id:read
GET    /v1/orgs/:orgId/triggers/:id    read
PATCH  /v1/orgs/:orgId/triggers/:id    update
DELETE /v1/orgs/:orgId/triggers/:id    delete
POST   /v1/orgs/:orgId/transactions   each operation's record gates

# Casbin policies and data filters
GET    /v1/orgs/:orgId/permissions
POST   /v1/orgs/:orgId/permissions/policies
DELETE /v1/orgs/:orgId/permissions/policies
POST   /v1/orgs/:orgId/permissions/roles
DELETE /v1/orgs/:orgId/permissions/roles
POST   /v1/orgs/:orgId/permissions/check
GET    /v1/orgs/:orgId/permissions/row-filters
POST   /v1/orgs/:orgId/permissions/row-filters
DELETE /v1/orgs/:orgId/permissions/row-filters/:id
GET    /v1/orgs/:orgId/permissions/field-filters
POST   /v1/orgs/:orgId/permissions/field-filters
DELETE /v1/orgs/:orgId/permissions/field-filters/:id

# Organization access
# Every organization member may read the member directory. Membership changes
# and invitation administration require manage permission on /members.
GET    /v1/orgs/:orgId/members
PATCH  /v1/orgs/:orgId/members/:memberId/role
DELETE /v1/orgs/:orgId/members/:memberId
POST   /v1/orgs/:orgId/invitations
GET    /v1/orgs/:orgId/invitations
POST   /v1/orgs/:orgId/invitations/accept
POST   /v1/orgs/:orgId/invitations/cancel
# Service accounts (manage permission on /members). Creation returns only a
# single-use claim URL; the raw API token is shown once on the claim page to an
# authenticated admin of the owning organization.
POST   /v1/orgs/:orgId/service-accounts
GET    /v1/orgs/:orgId/service-accounts/:serviceAccountId/api-keys
DELETE /v1/orgs/:orgId/service-accounts/:serviceAccountId/api-keys/:apiKeyId
POST   /v1/orgs/:orgId/service-accounts/:serviceAccountId/api-keys/:apiKeyId/rotate
GET    /tokens/claim/:code

# Notifications
GET    /v1/orgs/:orgId/notifications?unread=true
GET    /v1/orgs/:orgId/notifications/preferences
PATCH  /v1/orgs/:orgId/notifications/preferences
POST   /v1/orgs/:orgId/notifications/notify
GET    /v1/orgs/:orgId/notifications/schedules
DELETE /v1/orgs/:orgId/notifications/schedules/:id
PATCH  /v1/orgs/:orgId/notifications/:id
DELETE /v1/orgs/:orgId/notifications/:id

# Inspection and portability
GET    /v1/orgs/:orgId/stats       `/system/stats`:read
GET    /v1/orgs/:orgId/audit-log   `/system/audit`:read
POST   /v1/orgs/:orgId/export
POST   /v1/orgs/:orgId/import
```

Record query bodies accept `where`, `order_by`, `limit`, and `offset`.
`occurs_between` belongs inside a Where leaf on a `recurrence` field and must
contain a bounded pair of ISO timestamps. Aggregate bodies accept `where`,
`group_by`, `metrics`, `having`, `order_by`, `limit`, and `offset`.

`notify` accepts subject, optional message/type/data/dedupe_key, optional once or
recurring `timing`, and optional `audience`:
`{"kind":"self"}` (default), `{"kind":"users","users":["id-or-email"]}`,
`{"kind":"all"}`, or `{"kind":"roles","roles":["existing-role"]}`.
Team destinations require Casbin `write` on each recipient's user path or one
of their role paths under `/notifications`; `/notifications/*` covers all.
Schedule listing and cancellation belong to the creator; delivered notifications
belong to each recipient. Queue responses return `ids` and counts; `id` is
`null` for fanouts. Schedule `recipient` is `null` for team audiences. See
[notifications](../docs/notifications.md).

Uploads use `multipart/form-data` with one file and an optional relative `path`
field. Download responses stream bytes. Every response other than a download
is JSON with `status: "ok"` or `status: "error"`.

Enqueue bodies are `{entries:[{payload,available_at?,idempotency_key?}]}` with
1..100 entries. Claim takes `{limit?,lease_seconds?}` and returns
`{status:"ok",claims,has_more}`. Ack takes `{token}`, nack
`{token,delay_seconds?,error?}`, extend `{token,lease_seconds}`; cancel/redrive
require `{}`. Lists use `{status:"ok",items,next_cursor}`. Stale/settled leases
and conflicting idempotency keys return 409. See [queue examples and ACLs](../docs/queues.md).

Schedule creation uses `{queue,payload,timing,enabled?}`, where timing is
`{kind:"once",at}` or `{kind:"recurring",recurrence}`. Trigger creation uses
`{collection,queue,events,watched_fields?,where?,mapping,enabled?}`. Pause/resume
are PATCH `{enabled:false/true}`. Transaction bodies contain 1..25 `operations`
and optional `idempotency_key`, bounded to 1 MiB. See [automation examples](../docs/automation.md).

History routes use current collection read grants, row conditions and field
projection on each stored version. Query parameters are `record_id`,
`change_set_id`, UTC `since` (inclusive), UTC `until` (exclusive), `limit`
(1..100, default 50), and `cursor`. The record route supplies `record_id` from
its path. Responses contain `items` and `next_cursor`; see
[record history](../docs/record-history.md).

Record GET supports comma-separated `expand` paths; record query accepts an
`expand` array. Query/count/aggregate predicates support related `some`, `none`,
`every`, and list-ID `has`. The related-record route accepts `source_collection`
and `field`, plus normal source filters/pagination/expansion. See
[relationships](../docs/relationships.md).

Upload-link and prepare-upload requests accept optional
`attachment:{collection,record_id,field}`. Destination record-field update access
replaces the library write gate for these uploads. File metadata/content/download
link requests resolve library, current attachment, or retained-history access;
file deletion requires library delete authority and zero live/history references.
See [attachments](../docs/attachments.md).
