# Organization access

All organization APIs use an authenticated BetterAuth user session and an
explicit organization path: `/v1/orgs/:orgId/...`.

Agents can act through a delegated user session or a service account with its
own identity. Grant access directly to `user:<id|email>` or through a role.
Collection grants can include an optional row condition and field list, for
example `where: {"created_by":"$user.id"}` and `fields: ["title","status"]`.
Grant `create`, `update`, `read`, and `delete` as needed; `write` covers create
and update. All grants are additive, so unrestricted grants still give full
access. See [conditional row and field grants](mcp.md#conditional-row-and-field-grants)
for MCP and CLI examples.

Member management is available under `/v1/orgs/:orgId/members`; invitations are
created, listed, accepted, and canceled under
`/v1/orgs/:orgId/invitations`. Invitation operations require session
authentication. Accepting an invitation is the only organization-scoped action
that does not require pre-existing membership.
