---
name: lastsaas
description: Use the saas CLI to manage Last SaaS collections, records, access rules, members, notifications, and files on behalf of an authenticated user.
---

# Last SaaS Agent Guide

Last SaaS is an organization-scoped data store for assistants. Its server
provides horizontal primitives; compose application behavior from collections,
records, Casbin policies, row filters, field filters, recurrence values,
notifications, and files.

Assume `saas` is installed and available on `PATH`. Add `--json` when another
program will consume the output.

## Authenticate and choose an organization

```bash
saas login --server http://localhost:8787
saas orgs list
saas orgs create <name> [--slug <slug>]
saas orgs use <org-id>
saas whoami
saas --org <org-id> collections list
saas logout
```

Login uses browser-based PKCE and stores a rolling user session in
`~/.lastsaas/config.json`. Every data operation acts as that user. Organization
scope is explicit: create an organization or join one by invitation, select its
stored default with `orgs use`, or pass `--org <org-id>` for one command.
If a request returns 401, authenticate again; do not substitute another
credential type.

## Define collections

```bash
saas --org <org-id> collections list
saas --org <org-id> collections create contacts \
  --description "People we work with" \
  --schema '{"name":{"type":"string","description":"Display name"},"email":"string","status":"enum:active,archived"}'
saas --org <org-id> collections describe contacts
saas --org <org-id> collections update-schema contacts --add '{"phone":"string"}'
saas --org <org-id> collections delete contacts --confirm
```

Supported field types are `string`, `text`, `number`, `integer`, `float`,
`boolean`, `date`, `datetime`, `json`, `recurrence`, `enum:a,b,c`, and
`ref:collection_name`. Prefer the object shape with a description when an AI
hint will clarify meaning or units.

## Work with records

```bash
saas --org <org-id> records insert contacts \
  --data '{"name":"Jane","email":"jane@example.com","status":"active"}'
saas --org <org-id> records get contacts <record-id>
saas --org <org-id> records update contacts <record-id> \
  --data '{"status":"archived"}'
saas --org <org-id> records delete contacts <record-id>

saas --org <org-id> records query contacts \
  --where '{"and":[{"status":"active"},{"email":{"contains":"@example.com"}}]}' \
  --order-by name --limit 50
saas --org <org-id> records count contacts \
  --where '{"status":{"not":"archived"}}'
saas --org <org-id> records batch contacts \
  --data '[{"name":"Alice","email":"alice@example.com"},{"name":"Bob","email":"bob@example.com"}]'
saas --org <org-id> records aggregate orders \
  --group-by status \
  --metrics '[{"op":"count","as":"n"},{"op":"sum","field":"amount","as":"total"}]' \
  --having '{"n":{"gte":10}}' --order-by=-total
```

The recursive Where DSL accepts `and`, `or`, and `not` nodes. Leaf operators
are `eq`, `not`, `gt`, `lt`, `gte`, `lte`, `contains`, `in`, `is_null`,
`between`, and `occurs_between`. A bare scalar means equality. Metadata fields
such as `_id`, `_created_at`, and `_updated_at` may be available alongside
schema fields.

## Recurrence values and window queries

A `recurrence` value is RFC 5545 content with exactly these logical lines:

```text
DTSTART;TZID=America/Los_Angeles:20260818T090000
RRULE:FREQ=WEEKLY;BYDAY=TU
EXDATE;TZID=America/Los_Angeles:20260825T090000
```

`DTSTART` must carry a TZID. `RRULE` supports daily, weekly, monthly, and yearly
frequencies. `EXDATE` is optional and may contain comma-separated local
date-times. Store the lines as one JSON string separated by `\n`.

Recurring queries must use a bounded window:

```bash
saas --org <org-id> records query appointments \
  --occurs-between schedule \
  --from 2026-08-01T00:00:00Z \
  --to 2026-09-01T00:00:00Z
```

The server applies ordinary Where clauses and row filters before expansion,
then returns each matching record once with its occurrences in the requested
window. A hidden recurrence field cannot be queried. Keep windows narrow; the
server enforces window and occurrence caps.

## Compose restricted data entry

Treat restricted data entry as three independent controls over one collection:

1. A Casbin gate grants the role `write` on the collection resource.
2. A row filter restricts which records that role may write, commonly to rows
   whose `created_by` is `$user.id`.
3. A field filter lists exactly which fields the role may read and write.

Validation remains in the collection schema, so every write path has the same
rules.

```bash
saas --org <org-id> permissions assign \
  --user respondent@example.com --role respondent
saas --org <org-id> permissions grant \
  --subject role:respondent --resource /collections/responses --action write
saas --org <org-id> permissions row-filter set \
  --collection responses --role respondent --action write \
  --condition '{"created_by":"$user.id"}'
saas --org <org-id> permissions field-filter set \
  --collection responses --role respondent --action write \
  --readable-fields '["question","answer","created_by"]' \
  --writable-fields '["question","answer"]'
```

Add separate read rules if the role must retrieve its submissions. Hidden
fields cannot be selected, filtered, grouped, aggregated, or written.

## Compose a calendar collection

Use ordinary schema conventions so agents can recognize the meaning of each
field:

```bash
saas --org <org-id> collections create appointments --schema '{
  "title":{"type":"string","description":"Short calendar label"},
  "starts_at":{"type":"datetime","description":"Start of a one-off entry"},
  "ends_at":{"type":"datetime","description":"End of a one-off entry"},
  "timezone":{"type":"string","description":"IANA timezone"},
  "schedule":{"type":"recurrence","description":"DTSTART, RRULE, and optional EXDATE"},
  "status":"enum:confirmed,cancelled",
  "location":"string",
  "attendee_user_ids":"json",
  "series_record_id":"string",
  "replaces_occurrence":"datetime"
}'
```

Conventions:

- A one-off entry uses `starts_at` and `ends_at` and leaves `schedule` null.
- A repeating entry stores its local start and rule in `schedule`; retain an
  end duration or an explicit end field according to the collection's needs.
- Store attendee user IDs in a JSON array, or use a second collection when
  attendance itself needs querying and access rules.
- Query repetitions with `occurs_between`; never generate and store every
  future occurrence.

For a cancelled or moved occurrence, do both of the following:

1. Add the original local start to the parent series' `EXDATE` line.
2. Insert a standalone one-off record linked by `series_record_id` and
   `replaces_occurrence`. Use the new time for a move. For a cancellation, keep
   the original time and set `status` to `cancelled` so the change is explicit.

This recipe preserves history without introducing a special override entity.

## Manage permissions and membership

Casbin subjects are `role:<name>` or `user:<id|email>`. Actions are `read`,
`write`, `delete`, `manage`, and `*`.

```bash
saas --org <org-id> permissions list
saas --org <org-id> permissions grant \
  --subject role:editor --resource '/collections/*' --action write
saas --org <org-id> permissions revoke \
  --subject role:editor --resource '/collections/*' --action write
saas --org <org-id> permissions check \
  --user alice@example.com --resource /collections/contacts --action read

saas --org <org-id> permissions row-filter list --collection contacts
saas --org <org-id> permissions field-filter list --collection contacts
saas --org <org-id> members list
saas --org <org-id> permissions invite --email alice@example.com --role member
saas --org <org-id> permissions invitations
saas --org <org-id> permissions accept-invite --id <invitation-id>
```

Casbin is the collection-level gate. Row filters use the same Where DSL as
record queries and support `$user.id`, `$user.email`, and `$org.id`. Field
filters are plain arrays. If access is surprising, inspect all three layers.

Organization membership does not grant data access. Admins have full
organization access; members need explicit user or role policies for each
resource. Creating a collection requires `write` on `/collections` and grants
the creator `read`, `write`, and `manage` on that new collection, but not
`delete`. Collection listings omit resources the caller cannot read. Files use
the separate `/files` resource, and organization statistics and audit logs use
`/system/stats` and `/system/audit`.

## Notifications and files

```bash
saas --org <org-id> notifications list --unread
saas --org <org-id> notifications read <notification-id>
saas --org <org-id> notifications queue \
  --subject "Import finished" --message "The contact import is ready"

saas --org <org-id> files upload ./report.pdf --path reports/2026/report.pdf
saas --org <org-id> files list --prefix reports/2026/
saas --org <org-id> files download <file-id> --output ./report.pdf
saas --org <org-id> files delete <file-id> --confirm
```

Uploads are multipart and streamed. File paths are unique within an
organization; use slash-separated prefixes to organize them. Downloads always
require the user's session. Link a file to a collection record when its
metadata belongs with structured data.

Notification delivery can be immediate, one-shot at a future timestamp, or
recurring from the same recurrence content described above. Use a stable
dedupe value when retrying a request.

## Portability and inspection

```bash
saas --org <org-id> stats
saas --org <org-id> audit-log
saas --org <org-id> export --output backup.json
saas --org <org-id> import --input backup.json
```

Export before bulk or destructive work. Import reconstructs collection schemas
before their records. Audit entries identify the user behind every operation.

## Install this guide

```bash
saas skills print
saas skills install
saas skills install --directory /path/to/agent-skills
```

The default install destination is
`~/.lastsaas/skills/lastsaas/SKILL.md`. `skills install` prints the resulting
path. `skill` is an alias for `skills`, and `path` is an alias for `install`.
