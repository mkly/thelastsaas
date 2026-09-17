# Model Context Protocol (MCP)

Last SaaS exposes its organization-scoped data, access-control, file,
notification, and system operations as MCP tools over Streamable HTTP.

## Connect ChatGPT or Claude

Browser-based MCP clients connect through OAuth. They do not require the Last
SaaS CLI or a manually copied bearer token.

Add this remote MCP server URL to the client's custom connector or app setup:

```text
https://<lastsaas-host>/v1/mcp
```

The client discovers Last SaaS's OAuth endpoints automatically. When the
browser opens, sign in, choose the organization to connect, and approve the
requested access. The resulting connection is limited to that organization and
to the permissions of the signed-in user. Last SaaS issues a refresh token so
the client can renew its access without asking the user to reconnect each time.

In ChatGPT, add the URL as a custom app in **Settings > Apps > Advanced
settings > Developer mode**. In Claude, add it as a custom connector in
**Settings > Connectors**. Product and workspace plans can affect whether those
controls are available.

The `server_info` tool returns the API version and the authenticated `userId`
and `orgId`. Authorization is identical to the REST API: collection tools apply
Casbin permissions plus row and field filters, while administrative tools
require their corresponding management permissions. Tool failures are returned
as structured MCP errors.

File content is transferred as RFC 4648 base64 through `files_upload` and
`files_download`. The decoded content is bounded by the server's
`MAX_UPLOAD_SIZE` setting. Destructive tools such as `collections_delete`,
`files_delete`, and `org_import` require `confirm: true`.

## Getting started

The `getting_started` tool returns a friendly introduction, explains collections,
records, and fields, and offers a small reading-list tutorial using MCP tools.
It takes no arguments and does not read or change organization data.

Try asking your assistant "What can I do with Last SaaS?" or "Help me get
started." The assistant can call `getting_started` and walk through the guide
with you. The guide is available on request; it is not automatically displayed
when you connect. Creating the example list and adding books are separate
actions that save real data when you choose to try them.

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
| `audit`                                 | `audit_log`                                   |
| `stats`                                 | `stats`                                       |
| `export`                                | `org_export`                                  |
| `import`                                | `org_import`                                  |

The following commands deliberately do not have MCP tools:

- `login` and `logout` manage the CLI's local session. MCP clients authenticate
  through the browser OAuth flow described above.
- `whoami` includes CLI configuration and credential-store state. Use
  `server_info` for the server-confirmed user and organization identity.
- `orgs list`, `orgs create`, and `orgs use` operate outside the MCP server.
  MCP clients choose an existing organization in the browser.
- `skills print` and `skills install` read an asset embedded in the CLI build
  and write the user's local filesystem, so they are not server operations.
- Accepting an invitation as a not-yet-member user cannot go through the
  organization-scoped MCP endpoint because that endpoint requires membership.
  Use the CLI, browser flow, or REST endpoint for that initial acceptance.

## Conditional row and field grants

`permissions_grant` accepts optional `where` and `fields` on a specific
`/collections/<name>` resource, for either `user:<id|email>` or `role:<name>`.
For example, let an agent edit the title and status of tasks it created:

```json
{
  "subject": "user:<agent-id>",
  "resource": "/collections/tasks",
  "action": "update",
  "where": { "created_by": "$user.id" },
  "fields": ["title", "status"]
}
```

Use `permissions_grant` again with `action: "delete"`, the same `where`, and no
`fields` to allow deleting its own tasks. Grant `create` separately to allow
new tasks. `write` remains shorthand for both create and update.

Permissions are additive: no matching grant means no access; any matching grant
adds access. Omitting `where` allows every row, and omitting `fields` allows
every collection data field. An empty field list allows no data fields. Standard
record metadata (`id`, `created_by`, `created_at`, `updated_at`) remains visible
on readable records. An existing unrestricted admin grant continues to work.
An unrestricted member grant also continues to work, so replace broad member
grants when the intention is own-record access. Conditional grants do not need
an additional unrestricted grant.

Conditions use the existing Where language, including `$user.id`, `$user.email`,
and `$org.id`. They may compare `created_by` or ordinary collection fields such
as `owner_id` or `assigned_to`. They require a specific existing collection;
resource wildcards, `manage`, `*`, and deferred `occurs_between` conditions are
not supported with grant options. Delete applies to the whole row and rejects
`fields`.

Each grant keeps its condition and fields together. An update must have a grant
for every submitted field, matching both the existing and proposed row. It
cannot gain access by changing an ownership field or moving between two grants.
Create checks the proposed row, including server-set creator metadata; batch
requests with an unauthorized record save no records. Read results include only
fields from grants matching that row. Filtering, sorting, counting, and
aggregating on a field include only rows where that field is readable; a field
with no applicable read grant is rejected.

`permissions_list` includes the options. `permissions_revoke` removes the exact
grant: supply the same `where` and `fields`; omit both to remove only an
unrestricted grant. Field order does not matter. `permissions_check` reports
`conditional: true` when access depends on a conditional grant; its resource-level
answer does not authorize a particular row or field. Export/import preserves
the options.

The CLI accepts the same options as JSON:

```sh
saas permissions grant --subject 'user:<agent-id>' \
  --resource /collections/tasks --action update \
  --where '{"created_by":"$user.id"}' --fields '["title","status"]'
```

Existing role row/field filter tools remain for compatibility and are resolved
as paired grants. They retain their existing behavior for creation and updates;
new configurations should use conditional grants. No database migration is
needed: optional grant metadata uses the existing `casbin_rule.v3` column. All
server instances must run this version before creating conditional grants;
older versions do not interpret that metadata.
