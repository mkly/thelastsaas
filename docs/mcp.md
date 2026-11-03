# Model Context Protocol (MCP)

Last SaaS exposes its organization-scoped data, access-control, file,
notification, queue, automation, and system operations as MCP tools over Streamable HTTP.

Call `server_info` to identify the running server. It returns `version` (the
server version), `bundledCliVersion` (the CLI available for download), `commit`
(the build's Git SHA), `builtAt` (UTC build time), and `startedAt` (UTC process
start time), alongside the API version and request identity. Both server build
commands embed the revision and build time; source runs report `null` for
`commit` and `builtAt`. These fields identify a deployment; they do not trigger
client tool refreshes.

## Connect ChatGPT or Claude

Browser-based MCP clients connect through OAuth. They do not require the Last
SaaS CLI or a manually copied bearer token.

Add this remote MCP server URL to the client's custom connector or app setup:

```text
https://<lastsaas-host>/v1/mcp
```

The client discovers Last SaaS's OAuth endpoints automatically. When the
browser opens, sign in and approve account access. You can connect before
creating an organization. The client can list and create organizations and
select which one to use, subject to the signed-in user's permissions.
Last SaaS issues a refresh token so the client can renew access.

Use `organizations_list`, `organizations_create`, and `organizations_select`
to manage the active organization. Creating one also selects it. If no selection
exists and you belong to exactly one organization, it is selected automatically;
otherwise the assistant must ask you to choose or create one. The selection is
stored in `mcp_organization` per user and OAuth client, survives server restarts
and token refreshes, and is separate from the browser and CLI selections.
Conversations using the same OAuth client share that selection. In-flight calls
use the organization resolved at the start of their request.

Membership is checked on every request. If access to the selected organization
is removed, organization operations stop until you select another organization.
Organization-bound API keys remain restricted to their assigned organization;
they cannot create or switch organizations.

Existing organization-scoped OAuth connections must reconnect and approve account
access. Their tokens and refresh grants cannot acquire account access implicitly.

In ChatGPT, add the URL as a custom app in **Settings > Apps > Advanced
settings > Developer mode**. In Claude, add it as a custom connector in
**Settings > Connectors**. Product and workspace plans can affect whether those
controls are available.

The `server_info` tool returns the API version and the authenticated `userId`
and `orgId` (`null` when no organization is active). Authorization is identical to the REST API: collection tools apply
Casbin record conditions and independent field policies, while administrative tools
require their corresponding management permissions. Tool failures are returned
as structured MCP errors.

Prefer `files_upload_link` for chat clients: it returns a browser link where the
user selects and uploads one file without another login. The link expires after
five minutes. After the user finishes, `files_upload_status` reports the file ID.
Agents that can transfer bytes directly use `files_prepare_upload`, PUT the file
to the returned URL with its headers, then call `files_complete_upload`.
The CLI `files upload` handles that sequence automatically.

`files_upload` is a last resort for small RFC 4648 base64 uploads, only when
neither direct binary transfer nor a browser upload link can be used. Do not
read or encode file bytes into the conversation when either is available, and
do not automatically retry large files as base64. All upload methods enforce
`MAX_UPLOAD_SIZE`. See [upload storage setup](uploads.md) for S3 CORS requirements. Destructive tools such as `collections_delete`,
`files_delete`, and `org_import` require `confirm: true`.

For downloads, use `files_download_link`: it checks read access and returns a
five-minute URL for one file, with no extra login. Give the URL to the user or
fetch the raw bytes outside the conversation. Links allow repeated downloads
until expiry. The CLI `files download` handles this automatically. Base64
`files_download` is a last resort for small files when a link cannot be used.

## Getting started

The MCP `getting_started` tool and CLI `saas getting-started` command use one
tutorial source in `packages/shared/src/getting-started.ts`. Only their
organization setup and tool/command instructions differ.

The `getting_started` tool explains collections, records, and fields, and
includes a reading list example using requests you can give your assistant.
After creating the list, the guide suggests a reading reminder, followed by
optional steps for inviting someone or connecting an agent with a service account.
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
| `records related`           | `records_related`           |
| `records query`             | `records_query`             |
| `records count`             | `records_count`             |
| `records batch`             | `records_batch`             |
| `records aggregate`         | `records_aggregate`         |

| CLI command                 | MCP tool                                                     |
| --------------------------- | ------------------------------------------------------------ |
| `permissions list`          | `permissions_list`                                           |
| `permissions grant`         | `permissions_grant`                                          |
| `permissions revoke`        | `permissions_revoke`                                         |
| `permissions assign`        | `permissions_assign_role`                                    |
| `permissions unassign`      | `permissions_unassign_role`                                  |
| `permissions check`         | `permissions_check`                                          |
| `permissions invite`        | `invitations_create`                                         |
| `permissions invitations`   | `invitations_list`                                           |
| `permissions accept-invite` | `invitations_accept` (existing members only; see exclusions) |
| `permissions cancel-invite` | `invitations_cancel`                                         |
| `members list`              | `members_list`                                               |
| `members role-change`       | `members_change_role`                                        |
| `members remove`            | `members_remove`                                             |

| CLI command                             | MCP tool                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `files list`                            | `files_list`                                                                   |
| `files get`                             | `files_get`                                                                    |
| `files upload`                          | `files_prepare_upload`, `files_complete_upload` (or `files_upload` for base64) |
| `files download`                        | `files_download_link` (base64 `files_download` as a last resort)               |
| `files delete`                          | `files_delete`                                                                 |
| `notifications list`                    | `notifications_list`                                                           |
| `notifications read`                    | `notifications_read`                                                           |
| `notifications unread`                  | `notifications_unread`                                                         |
| `notifications delete`                  | `notifications_delete`                                                         |
| `notify`                                | `notify`                                                                       |
| `notifications schedules list`          | `notification_schedules_list`                                                  |
| `notifications schedules cancel`        | `notification_schedules_cancel`                                                |
| `notifications preferences show`        | `notification_preferences_show`                                                |
| `notifications preferences set-default` | `notification_preferences_set` without `kind`                                  |
| `notifications preferences set-kind`    | `notification_preferences_set` with `kind`                                     |
| `audit`                                 | `audit_log`                                                                    |
| `orgs list`                             | `organizations_list`                                                           |
| `orgs create`                           | `organizations_create`                                                         |
| `orgs use`                              | `organizations_select`                                                         |
| `stats`                                 | `stats`                                                                        |
| `export`                                | `org_export`                                                                   |
| `import`                                | `org_import`                                                                   |

`notify` accepts optional timing and an optional `audience`:
`self` (default), `users` with IDs or emails, `all`, or `roles` with existing role
names. Team sends use the same Casbin destination permissions as REST and CLI.
See [notifications](notifications.md) for payloads and delivery behavior.

Local CLI commands and browser flows complement MCP:

- `login` and `logout` manage the CLI's local session. MCP clients authenticate
  through the browser OAuth flow described above.
- `whoami` includes CLI configuration and credential-store state. Use
  `server_info` for the server-confirmed user and organization identity.
- `skills print` and `skills install` read an asset embedded in the CLI build
  and write the user's local filesystem.
- Use the CLI, browser flow, or REST endpoint to accept an invitation before
  joining an organization. `invitations_accept` operates within an active organization.

## Conditional permissions

Policies accept `cond` (default `true`) and `msg` (default empty). Conditions use
Casbin expressions with `&&`, `||`, comparisons and `in ('draft', 'pending')`.
`r.obj.data` is the current record, `r.next.data` is the complete proposed record,
and `r.usr` contains `id`, `email`, and `org`. Creates have empty `r.obj.data`;
reads and deletes use the current record for both objects.

```json
{
  "subject": "role:sales",
  "resource": "/collections/quotes",
  "action": "update",
  "cond": "r.obj.data.status == 'draft' && r.next.data.status in ('draft', 'pending') && r.next.data.discount <= 10",
  "msg": "Sales can move drafts to pending with discounts up to 10%."
}
```

Policies are additive: any matching true condition grants the action. A denied
write returns messages from applicable policies, or a plain permission error.
`create`, `update`, `read`, and `delete` are distinct collection-record actions.
`write` is used by resource APIs that explicitly request it, such as collection
creation and trigger configuration; it does not imply create or update.

Field access is independent and does not vary by row. Grant `/collections/quotes/fields/*`
for all fields, or specific paths such as `/collections/quotes/fields/discount`.
Use `read` to expose a field and `create` or `update` to allow changes. Field
conditions may use caller attributes but cannot depend on records. Hidden fields
cannot be used in filters, sorting, aggregates or recurrence queries.

```sh
saas permissions grant --subject role:sales --resource /collections/quotes \
  --action read --cond 'r.obj.data.owner == r.usr.id'
saas permissions grant --subject role:sales --resource '/collections/quotes/fields/*' --action read
saas permissions grant --subject role:sales --resource /collections/quotes/fields/discount --action update
```

`permissions_list` returns conditions and messages. Revoke with the exact same
subject, resource, action, `cond` and `msg`. `permissions_check` reports
`conditional: true` when the resource has conditional policies; it does not
approve a particular record or field. `collections_describe` includes the caller's
applicable record and field policies. Export/import preserves them.

`r.obj.refs.customer` and `r.next.refs.customer` contain full data from a referenced
record; multiple references yield arrays. References are tenant scoped and loaded
only when an expression uses them. Their values are used only for evaluation.
A missing attribute cannot grant access; only configured messages reach callers.

`invitations_create` accepts `permissions` entries with `resource`, `action`, and
optional `cond`/`msg`. Grant record and field paths explicitly. They are applied
when the recipient accepts, and pending grants appear in `invitations_list`.

## Record history

`records_history` accepts `collection`, optional `record_id`, `change_set_id`,
UTC `since`/`until`, `limit` (1..100, default 50), and `cursor`. It returns the
last 30 days of permitted changes, including deleted records, with the same
`items`/`next_cursor` response as REST and `saas records history`.
Current row and field permissions filter each saved version independently.
See [history semantics and corrections](record-history.md).

## Durable queues and automation

Tools use the current selected organization and the same membership, payload
whole-queue grants and native claim checks as REST. Organization-bound API keys use
`x-api-key` and cannot switch organizations. Human OAuth clients use the browser
flow above. Manage authority does not grant queue payload read.

| CLI (`saas` prefix)                      | MCP tool                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| queues create/list/show/update/delete    | queues_create / queues_list / queues_show / queues_update / queues_delete                |
| queues enqueue/claim/ack/nack/extend     | queues_enqueue / queues_claim / queues_ack / queues_nack / queues_extend                 |
| queues cancel/redrive                    | queues_cancel / queues_redrive                                                           |
| schedules create/list/show/update/delete | schedules_create / schedules_list / schedules_show / schedules_update / schedules_delete |
| schedules pause/resume                   | schedules_update with enabled false/true                                                 |
| triggers create/list/show/update/delete  | triggers_create / triggers_list / triggers_show / triggers_update / triggers_delete      |
| triggers pause/resume                    | triggers_update with enabled false/true                                                  |
| transactions execute                     | transactions_execute                                                                     |

Queue tools select `queue`, and settlement uses `job_id`. Schedule/trigger tools
select `id`. DTO fields are snake_case. Lists accept limit/cursor and return
items/next_cursor. Creation/update take the shared strict DTO; unknown keys are
rejected even where the MCP advertised schema is compact.

```json
{
  "queue": "jobs",
  "entries": [
    {
      "payload": { "job_id": "job-42", "title": "Index report" },
      "idempotency_key": "job-42"
    }
  ]
}
```

Send that to `queues_enqueue`. Then `queues_claim` takes
`{"queue":"jobs","limit":1}`. Process the returned
payload before `queues_ack` with `{queue,job_id,token}`. Claim alone returns
lease tokens; never copy them into logs or automatically ack. Nack accepts optional safe `error`; retry delay and lease duration are queue settings.
At-least-once delivery requires idempotent external effects. Revoked grants or
expired leases prevent settlement. Cancel/redrive need queue manage; redrive
only accepts dead jobs. These tools take selectors without `confirm`;
queue deletion also takes only selectors. CLI deletion requires
`--confirm`.

Schedule timing is `{kind:"once",at}` or `{kind:"recurring",recurrence}` with
DTSTART;TZID; triggers use explicitly tagged before/after/literal/metadata
mappings. See [worker ACLs and examples](queues.md) and
[atomic producers and transactions](automation.md). Direct worker claims,
shared consumption, schema restrictions, retry and restore rules apply
equally to MCP.

Queue consumers need whole-queue read/update grants. Claims include complete
payloads, so use separate queues for different access boundaries. Collection
row and field restrictions remain in effect for record operations.

## Relationships and record attachments

Use `ref:companies` for a single reference, or
`{"type":"ref:companies","multiple":true}` for an ordered list. Collection
descriptions include relationship discovery. `records_get` and `records_query`
accept `expand:["company","company.parent"]`; `records_related` finds reverse
links through `source_collection` and `field`. Filters support `some`, `none`,
`every`, and list-ID `has`. All targets retain their own row/field permissions.

Use an `attachments` field for ordered file IDs. Pass
`attachment:{collection,record_id,field}` to `files_upload_link` or
`files_prepare_upload` to append the upload directly to the record. Record reads
include file metadata under `attachments`. Ordinary record updates set attachment
lists; `files_download_link` authorizes current and retained-history attachment
access. See [relationships](relationships.md) and [attachments](attachments.md).
