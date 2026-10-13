# Work queues

Queues hold schema-validated jobs for external workers. Each enqueue publishes
one job. Any human or service account with the queue's consumer permissions can
claim it; concurrent workers share the work. Producers can enqueue before a
worker connects. Creating an account or schedule does not start an agent runtime.

```sh
saas queues create jobs --schema '{"title":"string"}' --lease-seconds 60 --retry-delay-seconds 30
saas queues enqueue jobs --payload '{"title":"Index report"}' --idempotency-key report-42
saas --json queues claim jobs --limit 1
saas queues ack jobs <job-id> --lease-token <lease-token>
saas queues nack jobs <job-id> --lease-token <lease-token> --error 'Temporary failure'
saas queues extend jobs <job-id> --lease-token <lease-token>
saas queues jobs jobs --state dead
saas queues redrive jobs <job-id>
saas queues cancel jobs <job-id>
```

Use the same job ID from the enqueue receipt through claim, inspection and
settlement. `--token` authenticates the CLI; `--lease-token` identifies a claim.
Only claim responses include lease tokens. Ack after processing succeeds; no
command automatically acknowledges work.

## Permissions

| Operation                  | Required permission                     |
| -------------------------- | --------------------------------------- |
| Create queue               | `write` on `/queues`                    |
| Enqueue                    | `create` on `/queues/<name>`            |
| List jobs and payloads     | `read` on `/queues/<name>`              |
| Claim, ack, nack, extend   | `read` and `update` on `/queues/<name>` |
| Configure, cancel, redrive | `manage` on `/queues/<name>`            |
| Delete queue               | `delete` on `/queues/<name>`            |

Current organization membership and permissions are checked on each request.
Settlement also requires the current unexpired token and the account that claimed
the job. Tokens are random; hashes and backend credentials stay private.
Management authority alone does not expose payloads. Authorized consumers receive
whole payloads; use separate queues for different access boundaries. Record
access still requires collection permissions.

```sh
saas permissions grant --subject 'user:<worker-id>' --resource /queues/jobs --action read
saas permissions grant --subject 'user:<worker-id>' --resource /queues/jobs --action update
```

## Processing and retention

Queue settings control maximum attempts (default 3), exponential retry delay
(default 30 seconds), lease duration (default 60 seconds), and terminal retention
(default 7 days). Set them during creation or with `queues update`. Disabling a
queue blocks new publication and claims; existing claims can still be settled.
A schema change requires zero retained jobs. Queue deletion requires no pending
publication or unfinished jobs and the CLI requires `--confirm`.

Claims return `job_id`, `payload`, `schema_version`, `attempts`, `lease_token`,
and `lease_expires_at`. Extend before expiry while work continues. After losing
a lease, stop acting on the job. Expired work becomes eligible for another
attempt through the backend's supervisor. Poll with a delay when idle; an empty
claim does not prove that all delayed or leased work has finished.

Delivery is at least once. Workers must make external effects safe to retry.
Nack reports failure using the queue's retry policy; exhausted jobs become dead.
Redrive only accepts dead jobs and retains the job ID. Cancellation invalidates
an unfinished job's lease; it cannot retract an external effect. Bunqueue removes
cancelled jobs from inspection, while PostgreSQL retains their cancelled state.

Enqueue supports UTC `available_at`, per-queue `idempotency_key`, and atomic
batches of up to 100 entries. Reusing a retained key with changed payload or
availability is rejected. Keep keys free of credentials and sensitive content.
Ordinary job inspection and settlement never return lease credentials.
See [backend operations](job-backends.md) for retention and provider details.

## REST and MCP

Routes are under `/v1/orgs/:orgId`:

```text
POST /queues/:name/jobs                         {entries:[{payload,available_at?,idempotency_key?}]}
GET  /queues/:name/jobs?limit=&cursor=&where=&state=
POST /queues/:name/claim                        {limit?}
POST /queues/:name/jobs/:id/ack                  {token}
POST /queues/:name/jobs/:id/nack                 {token,error?}
POST /queues/:name/jobs/:id/extend               {token}
POST /queues/:name/jobs/:id/cancel               {}
POST /queues/:name/jobs/:id/redrive              {}
```

MCP exposes `queues_enqueue`, `queues_jobs`, `queues_claim`, `queues_ack`,
`queues_nack`, `queues_extend`, `queues_cancel`, and `queues_redrive`, plus queue
configuration tools. Claim takes `{queue,limit?}`; settlement takes
`{queue,job_id,token}`. Cancel/redrive take `{queue,job_id}`. Enqueue returns
`jobs`; settlement returns `job`; lists return `items` and `next_cursor`.

List filters accept the shared payload `where` grammar and a job `state`.
State filtering can produce an empty page with a continuation cursor. Continue
until `next_cursor` is null.

See [automation](automation.md) for schedules, record triggers and atomic writes.
