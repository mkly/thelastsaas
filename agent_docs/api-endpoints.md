# API Endpoints

Organization membership discovery and creation use the account-scoped
`/v1/orgs` route. All organization data routes are explicitly scoped through
`/v1/orgs/:orgId`. They require a Better Auth session cookie or the bearer
session issued by the RFC 8628 device authorization flow.

```text
# System and authentication
GET    /health
*      /api/auth/**
GET    /auth/login
POST   /auth/login
GET    /auth/signup
POST   /auth/signup
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

# Collections
POST   /v1/orgs/:orgId/collections
GET    /v1/orgs/:orgId/collections
GET    /v1/orgs/:orgId/collections/:name
PATCH  /v1/orgs/:orgId/collections/:name/schema
DELETE /v1/orgs/:orgId/collections/:name?confirm=true

# Records
POST   /v1/orgs/:orgId/collections/:name/records
POST   /v1/orgs/:orgId/collections/:name/records/batch
GET    /v1/orgs/:orgId/collections/:name/records/:id
PATCH  /v1/orgs/:orgId/collections/:name/records/:id
DELETE /v1/orgs/:orgId/collections/:name/records/:id
POST   /v1/orgs/:orgId/collections/:name/records/query
POST   /v1/orgs/:orgId/collections/:name/records/count
POST   /v1/orgs/:orgId/collections/:name/records/aggregate

# Files
POST   /v1/orgs/:orgId/files
GET    /v1/orgs/:orgId/files?prefix=<path-prefix>
GET    /v1/orgs/:orgId/files/:id
GET    /v1/orgs/:orgId/files/:id/content
DELETE /v1/orgs/:orgId/files/:id

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
GET    /v1/orgs/:orgId/stats
GET    /v1/orgs/:orgId/audit-log
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
