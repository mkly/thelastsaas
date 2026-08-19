# Monorepo Structure

```text
SKILL.md                              Agent operator guide embedded in the CLI
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
