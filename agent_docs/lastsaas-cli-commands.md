# CLI Commands

Global options may precede a command family:

```text
saas [--org <org-id>] [--json] [--token <api-token>] <command>
```

```text
# Tutorial (prints the shared guide; no login required)
saas getting-started

# Authentication
saas login [--server <url>]
saas whoami
saas logout

# Organizations (alias: org)
saas orgs list
saas orgs create <name> [--slug <slug>]
saas orgs use <org-id>

# Collections (alias: c)
saas collections list
saas collections create <name> --schema <json> [--description <text>]
saas collections describe <name>
saas collections update-schema <name> [--add <json>] [--remove <fields>] [--update <json>]
saas collections delete <name> --confirm

# Records (alias: r)
saas records insert <collection> --data <json>
saas records get <collection> <id> [--expand <paths>]
saas records related <collection> <id> --source <collection> --field <field> [--where <json>] [--order-by <field>] [--expand <paths>] [--limit <n>] [--offset <n>]
saas records history <collection> [id] [--since <utc>] [--until <utc>] [--change-set-id <id>] [--limit <n>] [--cursor <cursor>]
saas records update <collection> <id> --data <json>
saas records delete <collection> <id>
saas records query <collection> [--where <json>] [--order-by <field>] [--expand <paths>] [--limit <n>] [--offset <n>]
saas records query <collection> --occurs-between <field> --from <timestamp> --to <timestamp>
saas records count <collection> [--where <json>]
saas records batch <collection> --data <json-array>
saas records aggregate <collection> [--where <json>] [--group-by <fields>] --metrics <json> [--having <json>] [--order-by <field>]

# Policies and filters (alias: p)
saas permissions list
saas permissions grant --subject <subject> --resource <path> --action <action>
saas permissions revoke --subject <subject> --resource <path> --action <action>
saas permissions assign --user <id-or-email> --role <name>
saas permissions unassign --user <id-or-email> --role <name>
saas permissions check --user <id-or-email> --resource <path> --action <action>
saas permissions row-filter set --collection <name> --role <name> --action <action> --condition <where-json>
saas permissions row-filter list [--collection <name>]
saas permissions row-filter delete <id>
saas permissions field-filter set --collection <name> --role <name> --action <action> --readable-fields <json-array> --writable-fields <json-array>
saas permissions field-filter list [--collection <name>]
saas permissions field-filter delete <id>

# Membership (alias: m)
saas members list [--role <role>] [--search <query>] [--limit <n>] [--offset <n>]
saas members role-change <member-id> --role <role>
saas members remove <member-id> --confirm
saas permissions invite --email <email> [--role <role>] [--permissions <json>]
saas permissions invitations
saas permissions accept-invite --id <invitation-id>
saas permissions cancel-invite --id <invitation-id>

# Notifications
saas notifications list [--unread]
saas notify --subject <text> [--message <text>] [--data <json>] [--dedupe-key <key>] [--at <utc-time> | --recurrence <content>]
# Audience options: --to <id-or-email> (repeatable), --to-role <role> (repeatable), or --to-all
saas notifications schedules list
saas notifications schedules cancel <id>
saas notifications read <id>
saas notifications unread <id>
saas notifications delete <id>
saas notifications preferences show
saas notifications preferences set-default [--in-app <on/off>] [--email <on/off>]
saas notifications preferences set-kind <kind> [--in-app <on/off>] [--email <on/off>]

# Files
saas files list [--prefix <path-prefix>]
saas files upload <local-path> [--path <remote-path>] [--collection <name> --record <id> --field <name>]
saas files get <id>
saas files download <id> [--output <path>]
saas files delete <id> --confirm

# Queues (configuration and inspection; one page per list, continue with --cursor)
saas queues create <queue> (--schema <json> | --schema-file <path>) [--enabled on|off]
saas queues update <queue> [--schema <json> | --schema-file <path>] [--enabled on|off]
saas queues list [--limit <n>] [--cursor <cursor>]
saas queues show <queue>
saas queues delete <queue> --confirm
saas queues jobs <queue> [--state <state>] [--where <json>] [--limit <n>] [--cursor <cursor>]

# Queue publication and workers (claim prints tokens; no automatic ack)
saas queues enqueue <queue> (--payload <json> | --payload-file <path>) [--available-at <UTC>] [--idempotency-key <key>]
saas queues claim <queue> [--limit <n>]
saas queues ack <queue> <job-id> --lease-token <token>
saas queues nack <queue> <job-id> --lease-token <token> [--error <safe-text>]
saas queues extend <queue> <job-id> --lease-token <token>
saas queues cancel <queue> <job-id>
saas queues redrive <queue> <dead-delivery>

# General schedules (payload-file may replace payload)
saas schedules create --queue <name> --payload <json> (--at <UTC> | --recurrence <content>) [--timezone <zone>] [--enabled on|off]
saas schedules update <id> [--queue <name>] [--payload <json> | --payload-file <path>] [--at <UTC> | --recurrence <content>] [--timezone <zone>] [--enabled on|off]
saas schedules list [--limit <n>] [--cursor <cursor>]
saas schedules show <id>
saas schedules pause <id>
saas schedules resume <id>
saas schedules delete <id> --confirm

# Collection triggers
saas triggers create --collection <name> --queue <name> --events <list> --mapping-file <file> [--watch-fields <list>] [--where <json> | --where-file <file>] [--enabled on|off]
saas triggers update <id> [--collection <name>] [--queue <name>] [--events <list>] [--mapping-file <file>] [--watch-fields <list>] [--where <json> | --where-file <file>] [--enabled on|off]
saas triggers list [--limit <n>] [--cursor <cursor>]
saas triggers show <id>
saas triggers pause <id>
saas triggers resume <id>
saas triggers delete <id> --confirm

# Organization inspection and portability
saas stats
saas audit-log
saas export --output <file>
saas import <file>

# Atomic transactions
saas transactions execute (--input <file> | --stdin) [--idempotency-key <key>]

# Bundled agent guide
saas skills print
saas skills install [--directory <skill-root>]
```

`saas whoami` reports the authenticated user's name, email address, and user ID.
It does not require a selected organization; when one is selected, it also reports
the organization and the user's role.

Queue creation requires `write` on `/queues`; configuration requires `manage`
on `/queues/<name>`, and deletion requires `delete`. Job inspection requires
`read`; claim and settlement require `read` and `update`. Management alone does
not grant payload access. Schema edits require zero retained jobs. Queue
create/update accept `--max-attempts`, `--lease-seconds`, `--retry-delay-seconds`
and `--retention-days` (defaults 3, 60, 30, 7 respectively).

Transaction input is a UTF-8 JSON request object with an `operations` array and
optional `idempotency_key`. Raw input and the submitted request are bounded to
1 MiB; the array contains 1..25 `record.create`, `record.update`, or `record.delete`
operations using literal IDs and data, including across collections. The CLI submits
one request, performs no automatic retries or result interpolation, and prints
the response with results in input order. Each operation requires its existing
permissions; all operations commit together or roll back together.
`--idempotency-key` may supply an absent key or match the input key; conflicting
keys are rejected. Keys are scoped to organization and principal and retained
for seven days. See [transactions](../docs/automation.md#atomic-transactions).

Notification queue and schedule creation commands accept one audience selector:
repeat `--to <id-or-email>`, repeat `--to-role <existing-role>`, or `--to-all`.
No selector targets self. Team sends require `write` on each resolved recipient's
`/notifications/users/<id>` or one of their `/notifications/roles/<role>`
destinations; `/notifications/*` covers everyone. See
[notification behavior](../docs/notifications.md) for resolution and delivery.

`skill` aliases `skills`; `path` aliases `skills install`. The default install
location is `~/.lastsaas/skills/lastsaas/SKILL.md`.

### Invite with collection access

```bash
saas permissions invite --email reader@example.com --permissions '[{"resource":"/collections/reading_list","action":"read"}]'
```

Optional `--permissions` accepts an array of grants (`resource`, `action`, and
optional `where`/`fields`). Grants are saved on the invitation and applied when
it is accepted. Setting grants requires permission to manage permissions.
`permissions invitations --json` includes the pending grants.

Authentication precedence is global `--token`, then `SAAS_API_TOKEN`, then the
stored human session. API tokens use `x-api-key`; human sessions use bearer.
Delivery `--lease-token` is separate. Process claim payloads before explicit ack;
make side effects idempotent and never log claim tokens. Current grants are
checked again on settlement. See [workers](../docs/queues.md) and
[automation](../docs/automation.md) for ACLs, retry, trigger publication and restore.
`records history` reads 30 days of changes under current record permissions,
including deletions. Pagination counts visible entries only. See
[history semantics and correction](../docs/record-history.md).

`records get` and `records query` accept `--expand company,company.parent`.
`records related` queries source records linking to a readable target.
Attachment uploads use all three destination options together. Ordinary record
updates attach, detach, replace, or reorder file IDs. See
[relationships](../docs/relationships.md) and [attachments](../docs/attachments.md).
