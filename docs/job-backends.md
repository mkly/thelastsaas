# Job backends

Requires Bun 1.4 or newer. Server dependencies pin pg-boss 12.37.1 and
Bunqueue 2.9.13. PostgreSQL is the primary deployment; SQLite is the
single-server fallback. These adapters target a new installation, without a
legacy queue migration or dual-write path.

`src/jobs/types.ts` defines the small delivery port. PostgreSQL uses pg-boss
queues, one per application subscription. `send` uses pg-boss's `fromPrisma`
adapter to insert on the caller's transaction. Its raw-query adapter is covered
by the integration test against the project's Prisma 6.19 client; no Prisma
upgrade is necessary for this operation. Queue provisioning is independent of
publication, so an unused empty queue may survive a rolled-back transaction.

SQLite uses the exported `bunqueue/queue` QueueManager inside the server, with
a separate durable SQLite file. The application transaction inserts a
`job_outbox` message. After commit, a bounded drain persists it in Bunqueue and
then deletes the outbox row. Stable IDs and a retained-job lookup prevent replay
of a completed job during a repeated handoff. A single server process owns each
Bunqueue file. Back up both the application and queue databases.

The libraries own claims, retry counts, retry backoff and stale-claim fencing.
Delivery remains at least once; external effects need consumer idempotency.
Use subscription settings for lease duration and exponential retry delay.
PostgreSQL heartbeats require at least 10 seconds and pg-boss enforces a
24-hour maximum execution time even when heartbeats continue. Retention and
supervisor polling also follow the selected library; expiry is not an exact
wall-clock delivery guarantee.

Run `bun test packages/server/test/job-backends.test.ts` with a SQLite-generated
Prisma client. For PostgreSQL, generate/push the PostgreSQL Prisma schema into a
disposable database, then run the same test with `JOBS_TEST_DATABASE_URL` set.
The PostgreSQL test creates and drops its own pg-boss schema. Tests cover atomic
publication/rollback, competing consumers, retries, stale claims, and SQLite
outbox restart/replay.

`bun run test:postgres` runs the provider suites in a disposable schema and restores
the SQLite Prisma client afterward. Set `TEST_POSTGRES_URL` to a test database.
When a PostgreSQL URL specifies a Prisma `schema`, native jobs use `<schema>_jobs`;
otherwise they use `pgboss`. Include that native schema in backups.
