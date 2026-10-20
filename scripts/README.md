# Repository scripts

Build, generation, and release scripts live here. Package runtime code belongs
under `packages/`.

The server and CLI have independent versions in `packages/server/package.json`
and `packages/client/package.json`. Commit the relevant version change, then
push `server-v<version>` or `cli-v<version>` to publish that component's binaries
and checksums. Server releases include SQLite and PostgreSQL binaries and report
the version of the CLI bundled for download. The API version is maintained
separately in `packages/shared/src/index.ts`.

## Built server and CLI smoke check

`bun run build:server:current` builds a SQLite server and CLI for the current
platform only, embedding just that CLI download. Release builds keep using
`build:server` or `build:server:postgres` to include every platform's CLI.
To build without Git metadata (for example, in a raw verification lease), set
`LASTSAAS_BUILD_COMMIT` to the full source commit SHA supplied by the checkout.
Without that variable the build reads `git rev-parse HEAD` as before.

Run the bounded public integration check with:

```sh
TEST_POSTGRES_URL=postgresql://… bun run smoke:built
```

It builds the current-platform CLI once, then generates the matching Prisma
client, applies SQLite migrations or the PostgreSQL schema, and builds/starts
the standalone server separately for each provider. It checks `/health`, signs
up and verifies a disposable human through the public auth endpoints using
console email, and runs the compiled CLI's `whoami`, organization creation,
queue creation, enqueue, claim and ack. A public API job list
confirms the successful settlement and cleared lease. It sends an immediate
notification, schedules a reminder, and cancels that reminder through the CLI.
It also compares the
embedded host CLI download's SHA-256 with the built CLI and checks that an
excluded platform returns 404. No source-mode server or
direct auth/database fixtures substitute for the compiled artifacts.

Use an isolated verification environment and a disposable PostgreSQL database
whose user can create/drop schemas (and create extensions for pg-boss). The
runner uses a random PostgreSQL schema and a temporary SQLite file/storage
directory, stops each server before switching providers, removes its fixtures,
restores the previous CLI config, and regenerates the SQLite client on exit.
Drop the disposable PostgreSQL database afterward to remove pg-boss's separate
`pgboss` schema as well; do not point this runner at a shared application database.
It leaves build artifacts in `dist/` and does not run the full test suite or
cross-platform builds. Do not run it concurrently with other provider checks or
CLI commands in the same environment. Install Bun, Node and locked dependencies
before running it.

## Prisma database providers

`packages/server/prisma/schema.prisma` is the only hand-edited Prisma schema
and targets SQLite. Generate the PostgreSQL variant with:

```sh
bun run scripts/generate-postgres-schema.ts
```

The generated `schema.postgres.prisma` selects the PostgreSQL datasource and
adds the Record JSONB GIN index (`records_data_gin_idx`). It is gitignored. Generate either client with `prisma:generate` or
`prisma:generate:postgres` from the server package.

SQLite migrations in `packages/server/prisma/migrations` are SQLite-only and
must never be replayed against PostgreSQL. PostgreSQL deployments should sync
from the generated schema using `prisma db push`, or produce provider-specific
SQL with `prisma migrate diff` against that generated schema.

## Backend contract tests

`TEST_POSTGRES_URL=postgresql://... bun run test:postgres` creates an isolated
schema, applies the PostgreSQL schema, and runs the query and notification
audience backend tests.
For queue enqueue, claim, settlement, maintenance and shared lifecycle contracts,
run `TEST_POSTGRES_URL=postgresql://... bun run test:postgres:queues`. This focused
mode includes real competing clients and transactions, PostgreSQL `SKIP LOCKED`,
idempotent fanout races, restart/expiry recovery and stale-token fencing. Queue
files run in separate processes so their fixed fixture IDs and permission caches
cannot interfere.

Both modes drop the temporary schema and restore the SQLite Prisma client on exit.
The database user must be able to create and drop schemas. The harness overrides
inherited backend fixture URLs to point at its isolated schema.
Run it separately from the regular SQLite suite. See
[database backends](../docs/database-backends.md).

For record/trigger/queue atomicity and transaction retry races, general schedule
occurrence races, and notification schedule fanout, run:

```sh
bun test packages/server/test/automation-integration.test.ts packages/server/test/schedule-materialize.test.ts packages/server/test/notification-occurrences.test.ts
TEST_POSTGRES_URL=postgresql://... bun run test:postgres:automation
```

The first command uses isolated SQLite files with the SQLite client generated.
The PostgreSQL runner selects the same focused files in separate sequential
processes, checks server types, creates/drops a random schema, and restores the
SQLite client even on failure. It overrides all three suites' fixture URLs.
Install dependencies and Node (for the package-installed Prisma launcher) before
running it. Never run provider-switching commands concurrently in one checkout.
