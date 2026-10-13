# Work queues and notifications

Work queues distribute jobs to external workers. Notifications deliver messages
to people. Both use durable backend jobs, with separate permissions and delivery
rules.

| Capability      | Work queues                                       | Notifications                                  |
| --------------- | ------------------------------------------------- | ---------------------------------------------- |
| Destination     | A named queue                                     | Yourself, selected members, roles, or everyone |
| Processing      | An authorized worker claims a job                 | The server delivers to each recipient          |
| Timing          | Immediate, delayed, scheduled, or triggered       | Immediate, one-time, or recurring              |
| Delivery policy | Queue retry, lease, and retention settings        | Recipient preferences and channel results      |
| Completion      | The claiming account explicitly acknowledges work | The server records delivery outcomes           |

## Work queues

Each publication creates one job with a stable ID. Authorized workers compete
for available work. Claims grant temporary leases and return an opaque token;
acknowledgement, failure, and extension require that token, the claiming account,
and current queue permissions. Processing is at least once, so external effects
must be safe to retry.

Queue definitions hold schemas and processing settings. Application records hold
immutable payloads and claim credentials. PostgreSQL uses pg-boss and SQLite uses
Bunqueue for job state, attempts, leases, and retries. Publication participates in
the source transaction through the PostgreSQL adapter or SQLite outbox.

Schedules and collection triggers publish ordinary jobs. Their creators' access
is checked when they execute. Invalid authority or payload schemas pause the
producer; persistence failures roll back publication with the source operation.

See [queue commands and permissions](queues.md), [automation](automation.md), and
[backend operations](job-backends.md).

## Notifications

The `notify` operation accepts content, an audience, and optional timing. The
server resolves recipients and applies their channel preferences, including for
self notifications. Each recipient has their own inbox entry, read state, and
delivery outcomes. Successful channels are skipped during retries.

Selected users are stored as IDs. Scheduled role and organization audiences use
current membership at each occurrence. Delivery rechecks sender authority,
recipient membership, addresses, and preferences. Notification processing uses
private backend queues.

Scheduled sends preserve their subject and message. Sender-scoped deduplication
keys identify retried requests. Schedule creators can list and cancel their
schedules; recipients manage their own inboxes. Scheduled content is fixed;
external assistants can call `notify` with newly generated results.

See [notification commands, audiences, and permissions](notifications.md).
