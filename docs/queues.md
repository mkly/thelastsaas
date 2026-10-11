# Durable queue workers

PostgreSQL uses pg-boss; SQLite uses embedded Bunqueue. Queues contain immutable,
schema-validated messages. Each enabled subscription receives a copy, and workers
on that subscription share its work. New subscriptions receive future entries only.

```sh
saas queues create jobs --schema '{"job_id":"string","title":"string"}'
saas queues subscriptions create jobs indexing --lease-seconds 60 --retry-delay-seconds 30
saas queues enqueue jobs --payload '{"job_id":"job-42","title":"Index report"}' --idempotency-key job-42
saas --json queues claim jobs indexing --limit 1
# Process claims[].payload, then settle the returned delivery_id:
saas queues ack jobs <delivery-id> --lease-token <lease-token>
# On failure, or to keep a long job alive:
saas queues nack jobs <delivery-id> --lease-token <lease-token> --error 'Temporary failure'
saas queues extend jobs <delivery-id> --lease-token <lease-token>
saas queues deliveries jobs --subscription indexing --state dead
saas queues redrive jobs <dead-delivery-id>
saas queues cancel jobs <unfinished-delivery-id>
```

Select the organization with `saas orgs use <org-id>` or `--org`. Humans and
service accounts use the same commands. `--token` authenticates the account;
`--lease-token` identifies a native job claim. Do not log claim tokens.

## Permissions

Permissions apply to the organization, queue and subscription. An authorized
consumer receives the **whole payload of every job in its subscription**. Give
different job types separate queues when their access requirements differ.

| Operation                                | Required authority                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| Create queue                             | write `/queues`                                                                             |
| List/show and inspect entries/deliveries | read `/queues/<name>`                                                                       |
| Edit queue or administer subscriptions   | manage `/queues/<name>`                                                                     |
| Delete queue                             | delete `/queues/<name>`                                                                     |
| Publish                                  | create `/queues/<name>`                                                                     |
| Claim, acknowledge, fail, heartbeat      | read and update `/queues/<name>`, plus update `/queues/<name>/subscriptions/<subscription>` |
| Cancel or redrive                        | manage `/queues/<name>`                                                                     |

```sh
saas permissions grant --subject 'user:<worker-id>' --resource /queues/jobs --action read
saas permissions grant --subject 'user:<worker-id>' --resource /queues/jobs --action update
saas permissions grant --subject 'user:<worker-id>' --resource /queues/jobs/subscriptions/indexing --action update
```

Queue grants do not accept row conditions or field lists. Collection permissions
still support both. Membership and grants are checked on every claim and settlement.
Manage does not grant payload read. A payload reference grants no collection access.

## Delivery and retention

Delivery is at least once. Make external effects idempotent with a business key:
a worker can crash after its effect succeeds but before acknowledgement. Enqueue
idempotency does not deduplicate external effects.

Subscription defaults are 3 attempts, a 60-second lease, a 30-second retry delay
and 7-day retention. Configure `--max-attempts` (1..100), `--lease-seconds`
(10..3600), `--retry-delay-seconds` (0..3600), and `--retention-days` (1..365).
Libraries own retries, backoff, expiry and terminal retention. PostgreSQL jobs
capture these settings at publication; pg-boss has a maximum 24-hour execution
deadline even with heartbeats. Retry timing can vary by provider.

Claim returns `claims` and `has_more`. Each claim includes entry, delivery and
subscription IDs, payload, attempts, token and expiry. Poll with a delay when
idle. Extend heartbeats the claim using subscription settings. Revoked authority
or a stale claim prevents settlement. Disabling queues/subscriptions blocks new
claims; existing valid claims can settle.

Inspection reports native current state and attempt count. Redrive asks the
library to retry dead work: pg-boss adds one attempt; Bunqueue requeues its dead
letter job. Attempt counts follow the library. Application audit events remain.
Cancellation invalidates unfinished work; Bunqueue removes cancelled jobs, so
they subsequently disappear from delivery inspection. Queue/subscription deletion
rejects unfinished deliveries, including pending SQLite publication.

Application entry receipts expire after their deliveries are cleaned. Idempotency
keys therefore do not last indefinitely. Use database backups for runtime state.

## Requests

Names start with a letter, contain letters/digits/underscores, and have at most
64 characters. Schemas use collection field types, reject unknown payload fields,
and allow omitted/null values. Schema edits require zero retained entries.

CLI enqueue accepts exactly one of `--payload` and `--payload-file`. REST/MCP
accept 1..100 entries atomically, each at most 64 KiB. At least one enabled
subscription is required. `--available-at` accepts a UTC timestamp ending in Z.
Same-key retries return original receipts; conflicting content returns 409.

REST paths below are relative to `/v1/orgs/:orgId`:

```text
POST /queues/jobs/entries
{"entries":[{"payload":{"job_id":"job-42","title":"Index report"},"idempotency_key":"job-42"}]}
POST /queues/jobs/subscriptions/indexing/claim
{"limit":1}
POST /queues/jobs/deliveries/<delivery-id>/ack
{"token":"<lease-token>"}
```

MCP uses `queues_enqueue` with `{queue,entries}`, `queues_claim` with
`{queue,subscription,limit}`, and `queues_ack`/`queues_nack`/`queues_extend` with
`{queue,delivery,token}`. Nack also accepts a safe `error` summary.
Lists return `items` and `next_cursor`; pass limit (1..100) and cursor to continue.
Entry lists accept JSON `where`; delivery lists accept subscription and state.
State filtering can produce an empty page with a continuation cursor.

See [backend operations](job-backends.md), [automation](automation.md), and
[contracts](queues-design.md).
