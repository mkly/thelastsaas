# The Last SaaS

**Your assistant is the interface.** The Last SaaS is a server that holds
your work, and it has no screens of its own. Your Claude, your ChatGPT, or
any agent connects to it over MCP, and the conversation is the interface.

Every SaaS you subscribe to is a database with a translation layer on top:
forms going in, dashboards coming out. That layer is exactly the work a
model does well, so this project keeps the part that matters. One server
holds records, files, people, permissions, reminders, and history. Your
assistant assembles whichever app you ask for: an applicant tracker today,
a client base tomorrow, without a new subscription for either.

There's a hosted version, free while in beta, at
[thelastsaas.com](https://thelastsaas.com). Or run it yourself; that's what
the rest of this README is for.

## What's in the box

- **Records.** Organizations own collections with dynamic schemas, and
  every record is validated against them.
- **Permissions.** Access is controlled per member with row- and
  field-level filters. The bookkeeper reads every invoice and never opens
  payroll.
- **Files.** File storage attached to the records it belongs to
  (S3-compatible backends supported).
- **Reminders.** Scheduled notifications, recurring or one-off, delivered
  by email.
- **History.** Audit logging of every change, who made it and when,
  whether it was a person or an agent.
- **Agent access.** An MCP endpoint with OAuth, plus a typed CLI that
  embeds an operator guide for agents.

Single TypeScript monorepo running on [Bun](https://bun.sh). SQLite by
default, PostgreSQL supported. The server compiles to one self-contained
binary that also serves the CLI binaries for download.

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

## Connect an assistant

Agents use the API through the MCP endpoint at `/v1/mcp`, authorized via
OAuth. Connecting is one paste: add your server's MCP address to your
assistant's connector settings (Claude, ChatGPT, Cursor, or your own
agent) and approve the sign-in. From there, setup is a conversation:

> "We're hiring a designer. Set up applicant tracking. Sarah screens
> candidates, but salary notes stay between us."

The CLI embeds an operator guide for agents (`saas skills`).

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

## License and leaving

Open source. Your data exports with one command, and the server is yours
to run yourself, now or if you ever decide to leave. There is no pricing
page here either.
