# Configuration

For local development, copy the server example from the repository root:

```sh
cp packages/server/.env.example packages/server/.env
```

`bun run dev` runs from `packages/server`, where Bun automatically loads this
file. Replace secrets and public URLs before using the configuration in
production.

| Variable               | Default                                   | Purpose                                            |
| ---------------------- | ----------------------------------------- | -------------------------------------------------- |
| `NODE_ENV`             | `development`                             | `development`, `test`, or `production`             |
| `PORT`                 | `8787`                                    | HTTP listen port                                   |
| `DATABASE_URL`         | `file:./data/lastsaas.db`                 | SQLite file or PostgreSQL connection URL           |
| `BETTER_AUTH_SECRET`   | development-only value                    | BetterAuth signing secret; required in production  |
| `BETTER_AUTH_URL`      | `http://localhost:$PORT`                  | Public origin; required in production              |
| `GOOGLE_CLIENT_ID`     | empty                                     | Optional Google OAuth client; pair with its secret |
| `GOOGLE_CLIENT_SECRET` | empty                                     | Optional Google OAuth secret                       |
| `SMTP_HOST`            | empty                                     | SMTP host; empty uses console delivery             |
| `SMTP_PORT`            | `587`                                     | SMTP port                                          |
| `SMTP_USER`            | empty                                     | SMTP username; pair with password                  |
| `SMTP_PASS`            | empty                                     | SMTP password                                      |
| `SMTP_FROM`            | `The Last SaaS <notifications@localhost>` | Sender address                                     |
| `STORAGE_TYPE`         | `local`                                   | `local` or `s3`                                    |
| `STORAGE_PATH`         | `./data/files`                            | Local file root                                    |
| `MAX_UPLOAD_SIZE`      | `52428800`                                | Maximum streamed upload bytes                      |
| `S3_ENDPOINT`          | empty                                     | Optional S3-compatible endpoint                    |
| `S3_REGION`            | `us-east-1`                               | S3 region                                          |
| `S3_BUCKET`            | empty                                     | Required for S3 storage                            |
| `S3_ACCESS_KEY`        | empty                                     | Optional explicit S3 credential; pair with secret  |
| `S3_SECRET_KEY`        | empty                                     | Optional explicit S3 credential                    |
| `S3_FORCE_PATH_STYLE`  | `false`                                   | Use path-style S3 URLs                             |

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
