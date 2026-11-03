# Organization access

All organization APIs use an authenticated BetterAuth user session and an
explicit organization path: `/v1/orgs/:orgId/...`.

Agents can act through a delegated user session or a service account with its
own identity. Grant access directly to `user:<id|email>` or through a role.
Collection policies accept `cond` and `msg`; field policies use paths such as
`/collections/tasks/fields/title`. Grant `create`, `update`, `read`, and `delete`
as needed. All policies are additive, including the administrator wildcard.
See [conditional permissions](mcp.md#conditional-permissions) for syntax and examples.

Member management is available under `/v1/orgs/:orgId/members`; invitations are
created, listed, accepted, and canceled under
`/v1/orgs/:orgId/invitations`. Invitation operations require session
authentication. Accepting an invitation is the only organization-scoped action
that does not require pre-existing membership.
