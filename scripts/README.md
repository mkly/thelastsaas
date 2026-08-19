# Repository scripts

Build, generation, and release scripts live here. Package runtime code belongs
under `packages/`.

## Prisma database providers

`packages/server/prisma/schema.prisma` is the only hand-edited Prisma schema
and targets SQLite. Generate the PostgreSQL variant with:

```sh
bun run scripts/generate-postgres-schema.ts
```

The generated `schema.postgres.prisma` differs only in the datasource provider
and is gitignored. Generate either client with `prisma:generate` or
`prisma:generate:postgres` from the server package.

SQLite migrations in `packages/server/prisma/migrations` are SQLite-only and
must never be replayed against PostgreSQL. PostgreSQL deployments should sync
from the generated schema using `prisma db push`, or produce provider-specific
SQL with `prisma migrate diff` against that generated schema.
