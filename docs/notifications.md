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
saas notify --subject "Build ready" --message "Please review" \
  --to alice@example.com --to <user-id> --dedupe-key build-42

saas notify --at 2026-10-15T09:00:00Z \
  --subject "All hands" --to-all

saas notify \
  --recurrence $'DTSTART;TZID=UTC:20261015T090000\nRRULE:FREQ=WEEKLY' \
  --subject "Weekly engineering update" --to-role engineering

saas notifications schedules list
saas notifications schedules cancel <schedule-id>
```

Select the organization with the global `--org` option or your saved CLI
configuration. One-shot schedules take an ISO timestamp; recurring schedules
use the same recurrence format as collection recurrence fields.

REST uses `POST /v1/orgs/:orgId/notifications/notify`; MCP uses `notify`.
Both accept `{audience?,subject,message?,type?,data?,dedupe_key?,timing?}`.
Omit timing to send now; use `{kind:"once",at:"2030-01-01T09:00:00Z"}` or
`{kind:"recurring",recurrence:"DTSTART:20300101T090000Z\nRRULE:FREQ=WEEKLY"}`
to schedule. CLI `--at` and `--recurrence` are mutually exclusive.

Immediate responses have `kind: "immediate"`, notification `ids`, and
recipient/queued/skipped counts. Scheduled responses have `kind: "scheduled"`
and a `schedule` with its ID, subject and next occurrence. Acceptance means the
request is stored; external delivery happens in the background. A retry with
the same sender-scoped schedule key returns the same schedule. Reusing that key
with different content, timing or audience is rejected.

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
delivery retries. Once queued, the recipient list is fixed; pending
deliveries recheck membership, sender permissions, current email address, and
preferences before dispatch. A delivery that is no longer authorized is
cancelled. A schedule's creator lists and cancels the schedule; each recipient
lists, reads, and deletes their own notifications. Cancelling a schedule stops
future occurrences; it does not retract notifications already queued.

In-app and email preferences apply to every recipient, including yourself.
The server selects delivery channels; senders do not choose channel names.
Muted recipients are skipped. Preferences are checked again before delivery,
and successful external channels are skipped on retries. Delivery does not mark
a notification read. Console is the development delivery adapter when SMTP is
not configured.

Scheduled messages contain fixed content. They do not run an AI assistant.
For recurring research or analysis, use an assistant's scheduler or an external
worker, then call `notify` with the result. Notification processing uses private
backend queues; ordinary work-queue consumers cannot claim these deliveries.

```sh
saas notifications list --unread
saas notifications read <notification-id>
saas notifications preferences show
saas notifications preferences set-default --in-app on --email off
```
