# Monorepo Structure

```text
skills/lastsaas/SKILL.md              Agent operator guide embedded in the CLI
agent_docs/                           Concise implementation references
scripts/
├── embed-skill.ts                    Generates client skill.generated.ts
└── generate-postgres-schema.ts       Generates the PostgreSQL Prisma schema
packages/
├── shared/
│   └── src/
│       ├── types.ts                  Wire and domain types
│       ├── validation.ts             Dynamic schema and record validation
│       └── errors.ts                 Shared error hierarchy
├── server/
│   ├── prisma/
│   │   ├── schema.prisma             Hand-edited SQLite schema
│   │   └── migrations/               SQLite migrations
│   └── src/
│       ├── app.ts                    Hono composition and ApiType
│       ├── auth.ts                   BetterAuth and rolling sessions
│       ├── config.ts                 Environment parsing and storage creation
│       ├── queues/                    Enqueue, claim, settlement, grants, maintenance
│       ├── schedules/                 Producer CRUD and durable occurrences
│       ├── triggers/                  Mapped publication inside record writes
│       ├── transactions/              Bounded atomic operations and idempotency
│       ├── secrets/                   Encryption, metadata/reveal, operator rotation
│       ├── services.ts               Prisma, SQLite, auth, queue, scheduler
│       ├── db/                        Collection, record, filter, audit, and export logic
│       ├── lib/recurrence.ts          Timezone-aware bounded expansion
│       ├── middleware/                Auth, organization, policy, row/field filters
│       ├── notifications/             Queue, channels, preferences
│       ├── scheduler/                 One-shot and recurring delivery planning
│       ├── routes/                    Hono route families
│       └── storage/                   Local and S3 streaming implementations
└── client/
    └── src/
        ├── index.ts                  Commander entry point and global options
        ├── api-client.ts             Typed Hono client and response handling
        ├── auth.ts                   Device PKCE login
        ├── config.ts                 Local server/session/org configuration
        ├── skill.generated.ts        Generated embedded guide
        └── commands/                 CLI command families, including skills.ts
```

The server exports `ApiType` from the fully chained Hono application. The client
imports it as a type-only dependency, preserving end-to-end request and response
inference without bundling server runtime code.

Automation DTOs and validators live in shared `automation.ts`, `queue.ts`,
`schedules.ts`, `triggers.ts`, `transactions.ts` and `secrets.ts`. Routes and MCP
tools invoke domain services. CLI `queue-jobs.ts` handles worker commands;
`schedules.ts`, `triggers.ts`, `transactions.ts` and `secrets.ts` handle the other
families. Registration is in client `src/commands.ts` and server `src/app.ts` /
`src/mcp/registry.ts`. `scripts/rotate-secrets.ts` is local operator tooling.
After editing `skills/lastsaas/SKILL.md`, run `bun run embed:skill` in the host
worktree; never hand-edit client `skill.generated.ts`.

Record history DTOs live in shared `record-history.ts`. Server
`db/record-history-storage.ts` appends and expires snapshots; `db/record-history.ts`
authorizes and projects queries. `routes/record-history.ts`, MCP `records_history`,
and CLI `records history` use the same query service and shared schema.
