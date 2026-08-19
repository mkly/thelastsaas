# API Endpoints

Organization membership discovery and creation use the account-scoped
`/v1/orgs` route. All organization data routes are explicitly scoped through
`/v1/orgs/:orgId`. They require a Better Auth session cookie or the bearer
session issued by the RFC 8628 device authorization flow.

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
GET    /v1/orgs/:orgId/collections/:name/records/:id
PATCH  /v1/orgs/:orgId/collections/:name/records/:id
DELETE /v1/orgs/:orgId/collections/:name/records/:id
POST   /v1/orgs/:orgId/collections/:name/records/query
POST   /v1/orgs/:orgId/collections/:name/records/count
POST   /v1/orgs/:orgId/collections/:name/records/aggregate

# Files (`/files` permission)
POST   /v1/orgs/:orgId/files                     write
GET    /v1/orgs/:orgId/files?prefix=<path-prefix> read
GET    /v1/orgs/:orgId/files/:id                  read
GET    /v1/orgs/:orgId/files/:id/content          read
DELETE /v1/orgs/:orgId/files/:id                  delete

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

# Notifications
GET    /v1/orgs/:orgId/notifications?unread=true
GET    /v1/orgs/:orgId/notifications/preferences
PATCH  /v1/orgs/:orgId/notifications/preferences
POST   /v1/orgs/:orgId/notifications/queue
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

Uploads use `multipart/form-data` with one file and an optional relative `path`
field. Download responses stream bytes. Every response other than a download
is JSON with `status: "ok"` or `status: "error"`.
