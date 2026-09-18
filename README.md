# The Last SaaS

The Last SaaS is a TypeScript backend for records, files, team permissions,
notifications, and audit logs, accessed through an HTTP API, MCP, or CLI.
It runs on Bun and supports SQLite(mostly for dev and evaluation) and
PostgreSQL(preferred).

## Local development

Requires [Bun](https://bun.sh) 1.2 or later. From the repository root:

```sh
bun install
cd packages/server
cp .env.example .env
mkdir -p data
DATABASE_URL=file:../data/lastsaas.db bunx prisma migrate deploy
bun run prisma:generate
bun run dev
```

The server runs with file watching at http://localhost:8787. Sign up at
`/auth/signup`; the MCP endpoint is `/v1/mcp`. On subsequent runs, start it
from the repository root with `bun run dev`.

Bun loads `packages/server/.env` when starting the server. The example uses
SQLite, local file storage, and console output for email. See the
[configuration reference](agent_docs/config.md) for environment variables.
The migration command uses a path relative to the Prisma schema directory;
the runtime SQLite path is relative to `packages/server`.

## Disable password authentication

Set `PASSWORD_AUTH_ENABLED=false` in the server environment and restart to disable
password signup, login, reset, and password changes. Password forms are hidden;
Google (when configured) and magic-link authentication remain available. Existing
accounts, passwords, sessions, and API keys are retained. The default is `true`;
set it back to `true` and restart to re-enable password authentication.

## Repository layout

- `packages/server/` — HTTP API, MCP, authentication, storage, and background jobs.
- `packages/client/` — the `saas` CLI.
- `packages/shared/` — shared types, validation, and errors.
- `packages/server/prisma/` — database schema and SQLite migrations.
- `scripts/` — build, generation, and backend test scripts.
- `skills/lastsaas/` — operator guide embedded in the CLI.
- `agent_docs/` and `docs/` — implementation and behavior references.

## Checks

Run from the repository root:

```sh
bun run test               # shared, server, and client tests
bun run typecheck
bun run lint
bun run format:check
```

Use `bun run test:shared`, `bun run test:server`, or `bun run test:client`
to run one package's tests. Use `bun run format` to apply formatting.

## Working with the CLI

`saas login` defaults to `https://app.thelastsaas.com` when no server is saved.
Use `--server` to select a local or self-hosted deployment.

With the development server running, build and log in from another terminal:

```sh
bun run build:client       # produces dist/saas
dist/saas login --server http://localhost:8787
```

See the [CLI command reference](agent_docs/lastsaas-cli-commands.md).
The embedded operator guide is available through `dist/saas skills`.

## Database development

`packages/server/prisma/schema.prisma` is the canonical SQLite schema.
After pulling SQLite migrations, apply them and regenerate the client:

```sh
cd packages/server
DATABASE_URL=file:../data/lastsaas.db bunx prisma migrate deploy
bun run prisma:generate
```

For PostgreSQL development, set `DATABASE_URL` in `packages/server/.env`
to your development database URL, then run from the repository root:

```sh
bun run --cwd packages/server prisma:push:postgres
bun run --cwd packages/server prisma:generate:postgres
bun run dev
```

These scripts generate `schema.postgres.prisma` from the canonical schema.
Re-run them after schema changes; do not apply SQLite migrations to PostgreSQL.
Regenerate the SQLite client with `prisma:generate` when switching back.

Run PostgreSQL backend contract tests separately from the regular test suite:

```sh
TEST_POSTGRES_URL=postgresql://user:password@localhost:5432/lastsaas_test bun run test:postgres
```

The test script creates and drops an isolated schema and restores the SQLite
Prisma client on exit. See [database backends](docs/database-backends.md) and
[repository scripts](scripts/README.md) for details.

## Builds

```sh
bun run build:client           # dist/saas for the current platform
bun run build:client:all       # CLI binaries for all supported platforms
bun run build:server           # dist/saas-server with a SQLite Prisma client
bun run build:server:postgres  # dist/saas-server with a PostgreSQL Prisma client
```

Server builds embed the CLI binaries for download. The database provider is
fixed when the Prisma client is generated, so choose the matching server build.

## Implementation references

- [Architecture](agent_docs/architecture.md)
- [Monorepo structure](agent_docs/monorepo-structure.md)
- [Key patterns](agent_docs/key-patterns.md)
- [API endpoints](agent_docs/api-endpoints.md)
- [MCP](docs/mcp.md)
- [Organization access](docs/organization-access.md)

## Server metadata cache

MCP and CLI/API requests share a bounded in-memory cache of collection definitions
and organization permission rules. Records, query results, membership checks,
and active-organization selections are not cached. Casbin enforcers are built
from cached rule data, not stored as shared mutable objects.

`CACHE_MAX_BYTES` defaults to `33554432` (32 MiB); set it to `0` to disable the
cache. Entries expire after `CACHE_TTL_SECONDS` (default `3600`, one hour). The cache also
limits itself to 10,000 entries, evicts least recently used entries when full,
and skips entries larger than its byte budget. Accounting includes serialized
values, keys, and an allowance for overhead; this bounds retained cache data,
not total process memory or temporary allocations while loading a value.

Schema changes, collection creation/deletion, and permission/role changes
invalidate affected entries after database writes settle. An older in-flight
read cannot repopulate an invalidated entry. Direct database edits become visible
when entries expire. Row and field filters continue to be read from the database.

The memory backend is for a single server process. With multiple processes sharing
one database, set `CACHE_MAX_BYTES=0` until a shared backend is configured; local
invalidation cannot immediately revoke cached permissions in another process.
The asynchronous `Cache` interface in `packages/server/src/cache/index.ts` uses
JSON-serializable values and can be injected into `createServices`. A future Redis
adapter must provide shared invalidation (including in-flight reads) and a key
namespace for each deployment. Redis is not required or implemented today.
