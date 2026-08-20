# The Last SaaS

A self-hostable backend for structured data: organizations own collections with
dynamic schemas, records are validated against them, and access is controlled
per member with row- and field-level filters. Includes file storage, scheduled
notifications, audit logging, a typed CLI, and an MCP endpoint for agents.

Single TypeScript monorepo running on [Bun](https://bun.sh). SQLite by default,
PostgreSQL supported. The server compiles to one self-contained binary that
also serves the CLI binaries for download.

## Requirements

- Bun 1.2+

## Quick start

```sh
bun install
cd packages/server
cp .env.example .env
DATABASE_URL=file:../data/lastsaas.db bunx prisma migrate deploy
bun run prisma:generate
bun run dev
```

The server listens on http://localhost:8787. Sign up at `/auth/signup`.

## CLI

```sh
bun run build:client        # produces dist/saas
dist/saas login --server http://localhost:8787
dist/saas orgs create "My Org"
dist/saas collections create tasks --schema '{"title": {"type": "string"}}'
dist/saas records insert tasks --data '{"title": "First task"}'
```

A running server also serves prebuilt CLI binaries and an installer at
`/auth/install`. See [agent_docs/lastsaas-cli-commands.md](agent_docs/lastsaas-cli-commands.md)
for the full command reference.

## MCP

Agents can use the API through the MCP endpoint at `/v1/mcp`, authorized via
OAuth. The CLI embeds an operator guide for agents (`saas skills`).

## Configuration

Everything is configured through environment variables; see
[agent_docs/config.md](agent_docs/config.md). Notable options: SMTP for email
notifications, Google OAuth, S3-compatible file storage, and rate limiting.

### PostgreSQL

Point `DATABASE_URL` at a `postgres://` URL, apply the schema with
`bun run --cwd packages/server prisma:push:postgres`, and build with
`bun run build:server:postgres`. Details in
[agent_docs/config.md](agent_docs/config.md).

## Production build

```sh
bun run build:server        # dist/saas-server, a single self-contained binary
```

The binary embeds the CLI builds for all supported platforms. Copy it to a
server, set the environment variables, and run it.

## Development

```sh
bun test                    # all packages
bun run typecheck
bun run lint
```

Implementation notes live in [agent_docs/](agent_docs/).
