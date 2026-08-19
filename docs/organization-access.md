# Organization access

All organization APIs use an authenticated BetterAuth user session and an
explicit organization path: `/v1/orgs/:orgId/...`.

External agents do not receive a separate agent identity. To grant an agent
access, invite the user account on whose behalf the agent operates, assign that
member a limited BetterAuth organization role, and grant only the Casbin
permissions the work requires. The agent then authenticates with that user's
delegated session.

Member management is available under `/v1/orgs/:orgId/members`; invitations are
created, listed, accepted, and canceled under
`/v1/orgs/:orgId/invitations`. Invitation operations require session
authentication. Accepting an invitation is the only organization-scoped action
that does not require pre-existing membership.
