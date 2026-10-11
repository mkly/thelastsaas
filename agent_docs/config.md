# Configuration

For local development, copy the server example from the repository root:

```sh
cp packages/server/.env.example packages/server/.env
```

`bun run dev` runs from `packages/server`, where Bun automatically loads this
file. Replace secrets and public URLs before using the configuration in
production.

| Variable                     | Default                                   | Purpose                                               |
| ---------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| `NODE_ENV`                   | `development`                             | `development`, `test`, or `production`                |
| `PORT`                       | `8787`                                    | HTTP listen port                                      |
| `DATABASE_URL`               | `file:./data/lastsaas.db`                 | SQLite file or PostgreSQL connection URL              |
| `CACHE_MAX_BYTES`            | `33554432` (32 MiB)                     | Metadata cache budget; `0` disables caching           |
| `CACHE_TTL_SECONDS`          | `3600` (one hour)                       | Metadata cache entry lifetime                        |
| `BETTER_AUTH_SECRET`         | development-only value                    | BetterAuth signing secret; required in production     |
| `BETTER_AUTH_URL`            | `http://localhost:$PORT`                  | Public origin; required in production                 |
| `GOOGLE_CLIENT_ID`           | empty                                     | Optional Google OAuth client; pair with its secret    |
| `GOOGLE_CLIENT_SECRET`       | empty                                     | Optional Google OAuth secret                          |
| `SMTP_HOST`                  | empty                                     | SMTP host; empty uses console delivery                |
| `SMTP_PORT`                  | `587`                                     | SMTP port                                             |
| `SMTP_USER`                  | empty                                     | SMTP username; pair with password                     |
| `SMTP_PASS`                  | empty                                     | SMTP password                                         |
| `SMTP_FROM`                  | `The Last SaaS <notifications@localhost>` | Sender address                                        |
| `STORAGE_TYPE`               | `local`                                   | `local` or `s3`                                       |
| `STORAGE_PATH`               | `./data/files`                            | Local file root                                       |
| `MAX_UPLOAD_SIZE`            | `52428800`                                | Maximum streamed upload bytes                         |
| `S3_ENDPOINT`                | empty                                     | Optional S3-compatible endpoint                       |
| `S3_REGION`                  | `us-east-1`                               | S3 region                                             |
| `S3_BUCKET`                  | empty                                     | Required for S3 storage                               |
| `S3_ACCESS_KEY`              | empty                                     | Optional explicit S3 credential; pair with secret     |
| `S3_SECRET_KEY`              | empty                                     | Optional explicit S3 credential                       |
| `SECRETS_ACTIVE_KEY_VERSION` | absent                                    | Active configured encryption key version              |
| `SECRETS_KEYRING`            | absent                                    | JSON version-to-base64 map of 32-byte encryption keys |
| `S3_FORCE_PATH_STYLE`        | `false`                                   | Use path-style S3 URLs                                |

## PostgreSQL

Setting `DATABASE_URL` to a `postgres://` URL switches the database provider,
the BetterAuth adapter dialect, and the background scheduler (croner in-process
polling becomes a pg-boss worker). The canonical Prisma schema is SQLite;
`schema.postgres.prisma` is generated from it and is not checked in.

To apply the schema to a PostgreSQL database:

```sh
DATABASE_URL=postgres://… bun run --cwd packages/server prisma:push:postgres
```

Re-run it after pulling schema changes. To build a server binary for a
PostgreSQL deployment, use `bun run build:server:postgres` (the Prisma client's
provider is fixed when it is generated, so a binary built with the default
`build:server` only works with SQLite).

The CLI stores `server`, `session_token`, and optional default `org` in
`~/.lastsaas/config.json`. `--org` overrides the saved organization for one
command. Production should use HTTPS so BetterAuth can issue secure cookies.

## Metadata cache

MCP and CLI/API requests share an in-memory cache of collection definitions and
organization permission rules. Records, query results, membership checks,
active-organization selections, and row/field filters are read from the database.

The cache retains at most 10,000 entries within `CACHE_MAX_BYTES`, evicting least
recently used entries and skipping values larger than the budget. This budget
estimates retained cache data, not total process memory. Entries expire after
`CACHE_TTL_SECONDS`.

Collection, schema, permission, and role changes invalidate affected entries
after writes settle, including entries being loaded concurrently. Direct database
edits become visible when entries expire.

For multiple server processes sharing a database, set `CACHE_MAX_BYTES=0`:
invalidation is local to each process, so another process could retain revoked
permissions until expiry. No shared cache backend is implemented.

## Secret encryption

Secrets are optional. Leave both `SECRETS_ACTIVE_KEY_VERSION` and
`SECRETS_KEYRING` absent to start without encryption keys. Set the active version
and a JSON object mapping versions to canonical base64 encodings of exactly 32
random bytes. Partial or malformed configuration stops startup without printing
key material. The parsed keyring is available as `AppConfig.secretKeyring`.
Keep old versions for decryption after rotation and back up keys separately from
the database. Never use ephemeral keys. See [the secrets contract](../docs/queues-design.md#secrets-notification-integration-and-portability).

Explicit encrypted organization backups require all source key versions on the
destination and re-encrypt restored values with its active key. Back up keys
separately; see [encrypted secret backup and restore](../docs/secrets-backup.md).

## Background work and upgrades

SQLite background work polls every 10 seconds; PostgreSQL pg-boss polls every
minute. Public queue consumers poll independently and recover expired leases
on claim. Backlog/retry/polling add delay beyond `available_at`; these are not
hard delivery deadlines. Keep the generated client aligned with the database
provider. Run only one provider's checks at a time in a checkout.

Use Bun 1.4 or later. SQLite runs one application process owning its Bunqueue file
(`${DATABASE_URL}` path plus `.jobs`). Back up both files. PostgreSQL backups must
include the pg-boss schema. See [backend operations](../docs/job-backends.md).
