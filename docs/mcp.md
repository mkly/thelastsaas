# Model Context Protocol (MCP)

Last SaaS exposes its organization-scoped data, access-control, file,
notification, and system operations as MCP tools over Streamable HTTP.

## Connect a client

The endpoint for an organization is:

```text
https://<lastsaas-host>/v1/orgs/<org-id>/mcp
```

Every request must use `POST` and include a bearer session for a user who is a
member of that organization:

```http
Authorization: Bearer <session-token>
Content-Type: application/json
Accept: application/json
```

The organization is selected by the URL, not by a tool argument. Each request
is stateless, so clients should use the HTTP endpoint directly rather than
expecting a long-lived server session.

For an MCP client that accepts JSON server configuration, the corresponding
configuration is:

```json
{
  "mcpServers": {
    "lastsaas": {
      "url": "https://<lastsaas-host>/v1/orgs/<org-id>/mcp",
      "headers": {
        "Authorization": "Bearer <session-token>"
      }
    }
  }
}
```

Keep the bearer token out of source control. How a client injects secrets into
this configuration varies by client.

The `server_info` tool returns the API version and the authenticated `userId`
and `orgId`. Authorization is identical to the REST API: collection tools apply
Casbin permissions plus row and field filters, while administrative tools
require their corresponding management permissions. Tool failures are returned
as structured MCP errors.

File content is transferred as RFC 4648 base64 through `files_upload` and
`files_download`. The decoded content is bounded by the server's
`MAX_UPLOAD_SIZE` setting. Destructive tools such as `collections_delete`,
`files_delete`, and `org_import` require `confirm: true`.

## CLI command parity

The tables below cover every command family registered in
`packages/client/src/commands.ts`. MCP names use underscores so they are valid,
stable tool identifiers.

| CLI command                 | MCP tool                    |
| --------------------------- | --------------------------- |
| `collections list`          | `collections_list`          |
| `collections create`        | `collections_create`        |
| `collections describe`      | `collections_describe`      |
| `collections update-schema` | `collections_update_schema` |
| `collections delete`        | `collections_delete`        |
| `records insert`            | `records_insert`            |
| `records get`               | `records_get`               |
| `records update`            | `records_update`            |
| `records delete`            | `records_delete`            |
| `records query`             | `records_query`             |
| `records count`             | `records_count`             |
| `records batch`             | `records_batch`             |
| `records aggregate`         | `records_aggregate`         |

| CLI command                                | MCP tool                                                       |
| ------------------------------------------ | -------------------------------------------------------------- |
| `permissions list`                         | `permissions_list`                                             |
| `permissions grant`                        | `permissions_grant`                                            |
| `permissions revoke`                       | `permissions_revoke`                                           |
| `permissions assign`                       | `permissions_assign_role`                                      |
| `permissions unassign`                     | `permissions_unassign_role`                                    |
| `permissions check`                        | `permissions_check`                                            |
| `permissions invite`                       | `invitations_create`                                           |
| `permissions invitations`                  | `invitations_list`                                             |
| `permissions accept-invite`                | `invitations_accept` (existing members only; see exclusions)   |
| `permissions cancel-invite`                | `invitations_cancel`                                           |
| `permissions row-filter set/list/delete`   | `row_filter_set`, `row_filter_list`, `row_filter_delete`       |
| `permissions field-filter set/list/delete` | `field_filter_set`, `field_filter_list`, `field_filter_delete` |
| `members list`                             | `members_list`                                                 |
| `members role-change`                      | `members_change_role`                                          |
| `members remove`                           | `members_remove`                                               |

| CLI command                             | MCP tool                                      |
| --------------------------------------- | --------------------------------------------- |
| `files list`                            | `files_list`                                  |
| `files get`                             | `files_get`                                   |
| `files upload`                          | `files_upload`                                |
| `files download`                        | `files_download`                              |
| `files delete`                          | `files_delete`                                |
| `notifications list`                    | `notifications_list`                          |
| `notifications read`                    | `notifications_read`                          |
| `notifications unread`                  | `notifications_unread`                        |
| `notifications delete`                  | `notifications_delete`                        |
| `notifications queue`                   | `notifications_queue`                         |
| `notifications schedules list`          | `notification_schedules_list`                 |
| `notifications schedules once`          | `notification_schedules_create_once`          |
| `notifications schedules recurring`     | `notification_schedules_create_recurring`     |
| `notifications schedules cancel`        | `notification_schedules_cancel`               |
| `notifications preferences show`        | `notification_preferences_show`               |
| `notifications preferences set-default` | `notification_preferences_set` without `kind` |
| `notifications preferences set-kind`    | `notification_preferences_set` with `kind`    |
| `audit-log`                             | `audit_log`                                   |
| `stats`                                 | `stats`                                       |
| `export`                                | `org_export`                                  |
| `import`                                | `org_import`                                  |

The following commands deliberately do not have MCP tools:

- `login` and `logout` manage the CLI's local bearer session. An MCP client
  supplies its own bearer token in the HTTP `Authorization` header.
- `whoami` includes CLI configuration and credential-store state. Use
  `server_info` for the server-confirmed user and organization identity.
- `orgs list`, `orgs create`, and `orgs use` operate outside or select the
  organization-scoped MCP endpoint. Configure one endpoint per organization;
  use the REST API or CLI to discover or create organizations first.
- `skills print` and `skills install` read an asset embedded in the CLI build
  and write the user's local filesystem, so they are not server operations.
- Accepting an invitation as a not-yet-member user cannot go through the
  organization-scoped MCP endpoint because that endpoint requires membership.
  Use the CLI, browser flow, or REST endpoint for that initial acceptance.
