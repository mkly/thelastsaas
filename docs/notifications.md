# Notifications

Immediate, one-shot, and recurring notifications accept the same audience.
Omitting the audience sends to yourself. Team audiences include human members
of the current organization; service accounts can send with appropriate grants
but are excluded from team recipients.

| Audience                | CLI option                  | API / MCP `audience`                         |
| ----------------------- | --------------------------- | -------------------------------------------- |
| Self                    | No audience option          | `{"kind":"self"}`                            |
| Selected people         | Repeat `--to <id-or-email>` | `{"kind":"users","users":["<id-or-email>"]}` |
| Everyone, including you | `--to-all`                  | `{"kind":"all"}`                             |
| Existing roles          | Repeat `--to-role <role>`   | `{"kind":"roles","roles":["engineering"]}`   |

Choose one audience kind per request. Multiple roles form a union; each member
receives one notification even when selected more than once. IDs and emails
can be mixed in a selected-people audience (up to 200 references per request).

## Send and schedule

```sh
saas notifications queue --subject "Build ready" --message "Please review" \
  --to alice@example.com --to <user-id> --channel email --dedupe-key build-42

saas notifications schedules once --at 2026-10-15T09:00:00Z \
  --message "All hands" --to-all --channel email

saas notifications schedules recurring \
  --recurrence $'DTSTART;TZID=UTC:20261015T090000\nRRULE:FREQ=WEEKLY' \
  --message "Weekly engineering update" --to-role engineering --channel email

saas notifications schedules list
saas notifications schedules cancel <schedule-id>
```

Select the organization with the global `--org` option or your saved CLI
configuration. One-shot schedules take an ISO timestamp; recurring schedules
use the same recurrence format as collection recurrence fields.

REST accepts `audience` on `POST /v1/orgs/:orgId/notifications/queue` and
`POST /v1/orgs/:orgId/notifications/schedules`. MCP accepts it on
`notifications_queue`, `notification_schedules_create_once`, and
`notification_schedules_create_recurring`. These entry points share the same
audience resolution, authorization, and scheduling helpers.

## Destination permissions

Team sends use the existing organization Casbin policies, with `write` on
notification destinations. Grant a sender user or role access through the usual
permissions commands:

```sh
saas permissions grant --subject role:engineering-lead \
  --resource /notifications/roles/engineering --action write

saas permissions grant --subject user:<sender-id> \
  --resource /notifications/users/<recipient-id> --action write

saas permissions grant --subject role:announcer \
  --resource '/notifications/*' --action write
```

Authorization checks every resolved recipient: access to that user's destination
or any of their current role destinations permits the send. A role grant also
permits selecting one of its members directly by ID or email. Everyone requires
permission for each other human member; `/notifications/*` covers all of them.
Self needs no additional grant. Organization admin policies already cover these
resources. Conditional record and field grants do not apply to notifications.

Any invalid recipient, unknown role, or unauthorized destination rejects the
whole request. An existing role with no human members produces no deliveries.

## Delivery and ownership

Selected people are resolved to IDs when the request is accepted. Scheduled
everyone and role audiences resolve current membership for each occurrence,
including any backlog being processed. Selected
people who leave the organization are skipped at that stage. A revoked sender
grant cancels a team schedule when it next runs. A departed sender cancels
any owned schedule, including self reminders.

Each recipient gets an independent delivery row, with separate read state and
delivery retries. Once queued, the recipient list is fixed; pending team
deliveries recheck membership, sender permissions, current email address, and
preferences before dispatch. A delivery that is no longer authorized is
cancelled. A schedule's creator lists and cancels the schedule; each recipient
lists, reads, and deletes their own notifications. Cancelling a schedule stops
future occurrences; it does not retract notifications already queued.

For other recipients, in-app and email preferences constrain the sender's
requested channels. Self retains the explicitly requested delivery behavior.
`--channel email` requests email; schedules default to the console channel.
Recipients with no requested channel enabled are skipped. Queue responses
include `ids`, `recipient_count`, `queued_count`, and `skipped_count`; `id` is
`null` unless exactly one notification is queued, so read `ids` for team sends.
Counts include existing rows returned by a deduplicated retry. Use a stable
`dedupe_key` for immediate request retries; keys are scoped to the sender and
recipient within the organization, so other senders cannot collide with them.
Scheduled occurrences deduplicate by schedule, occurrence, and recipient.
Schedule responses include `audience`; `recipient` is the single destination
user ID, or `null` for role, everyone, and multi-person audiences.

Each occurrence locks its schedule, resolves its audience and rechecks current
owner authority in the same transaction as recipient rows, publication and cursor
advancement. After downtime recurring schedules publish once for missed work and
advance past the current time. Competing schedulers recheck the locked cursor.

## Delivery jobs

pg-boss or Bunqueue owns notification leases and retries. Notification rows retain
inbox/read state and per-channel results. Successful channels are skipped on retry;
a crash between sending and recording success can still redeliver. Queue completion
does not mark the inbox notification read. See [backend operations](job-backends.md).
