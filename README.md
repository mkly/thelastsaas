# The Last SaaS

The Last SaaS is a server that holds records and files, 
tracks who is on the team and what each person can
see, sends notifications, and logs the changes. It does not provide a
user interface on its own; an assistant — Claude, ChatGPT, or any MCP
client — connects over MCP and operates it.


Most SaaS is built from the same parts: data, files, users, permissions,
and notifications, with a user interface on top. That interface is a
large part of what a SaaS app is, and it is work a model
does well, so this server keeps the parts underneath. The assistant
handles setup from of fields, permissions, and notifications via
the MCP or CLI.

- **Records.** Structured lists of anything from gear to invoices.
  Organizations own collections with dynamic schemas, and every record
  is validated against them.
- **Files.** Receipts and contracts, attached to the records they
  belong to (S3-compatible backends supported).
- **People.** Teammates join by invitation and work from the same
  records, each with their own assistant or none at all.
- **Permissions.** Rules apply down to the row and the field. The
  bookkeeper reads every invoice and cannot open payroll.
- **Notifications.** Due-date reminders and weekly digests, recurring
  or one-off, delivered by email.
- **Audit logs.** Changes are recorded with who made them and when,
  whether it was a person or an assistant.

---

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

Assistants connect through the MCP endpoint at `/v1/mcp`, authorized
via OAuth.

**Claude** (claude.ai or the desktop app): Settings → Connectors →
Add custom connector. Paste your server's MCP address
(`https://your-server/v1/mcp`), click Add, and approve the sign-in when
Claude asks. New chats can use it right away; if you don't see it, enable
it in the tools menu under the message box.

**Claude Code**:

```sh
claude mcp add --transport http lastsaas https://your-server/v1/mcp
```

**Cursor and other MCP clients**: add the same address wherever the
client takes an MCP server URL, and approve the sign-in.

**ChatGPT**: in the desktop app, add a custom connector with the same
address and approve the sign-in. On the web, custom MCP connectors
currently require a Business, Enterprise, or Edu workspace, where an
admin adds the connector under workspace settings. A listing in the
ChatGPT apps directory is planned.

From there:

> "Set up gear tracking for the studio. Anyone on the team can check
> equipment out, but purchase prices stay between us."

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
