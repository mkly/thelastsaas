# CLI Commands

Global options may precede a command family:

```text
saas [--org <org-id>] [--json] <command>
```

```text
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
saas records get <collection> <id>
saas records update <collection> <id> --data <json>
saas records delete <collection> <id>
saas records query <collection> [--where <json>] [--order-by <field>] [--limit <n>] [--offset <n>]
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
saas permissions invite --email <email> [--role <role>]
saas permissions invitations
saas permissions accept-invite --id <invitation-id>
saas permissions cancel-invite --id <invitation-id>

# Notifications
saas notifications list [--unread]
saas notifications queue --subject <text> [--message <text>] [--data <json>]
saas notifications read <id>
saas notifications unread <id>
saas notifications delete <id>
saas notifications preferences show

# Files
saas files list [--prefix <path-prefix>]
saas files upload <local-path> [--path <remote-path>]
saas files get <id>
saas files download <id> [--output <path>]
saas files delete <id> --confirm

# Organization inspection and portability
saas stats
saas audit-log
saas export --output <file>
saas import --input <file>

# Bundled agent guide
saas skills print
saas skills install [--directory <skill-root>]
```

`skill` aliases `skills`; `path` aliases `skills install`. The default install
location is `~/.lastsaas/skills/lastsaas/SKILL.md`.
