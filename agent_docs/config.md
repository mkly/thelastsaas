# Configuration

| Variable               | Default                               | Purpose                                            |
| ---------------------- | ------------------------------------- | -------------------------------------------------- |
| `NODE_ENV`             | `development`                         | `development`, `test`, or `production`             |
| `PORT`                 | `8787`                                | HTTP listen port                                   |
| `DATABASE_URL`         | `file:./data/lastsaas.db`             | SQLite file or PostgreSQL connection URL           |
| `BETTER_AUTH_SECRET`   | development-only value                | BetterAuth signing secret; required in production  |
| `BETTER_AUTH_URL`      | `http://localhost:$PORT`              | Public origin; required in production              |
| `GOOGLE_CLIENT_ID`     | empty                                 | Optional Google OAuth client; pair with its secret |
| `GOOGLE_CLIENT_SECRET` | empty                                 | Optional Google OAuth secret                       |
| `SMTP_HOST`            | empty                                 | SMTP host; empty uses console delivery             |
| `SMTP_PORT`            | `587`                                 | SMTP port                                          |
| `SMTP_USER`            | empty                                 | SMTP username; pair with password                  |
| `SMTP_PASS`            | empty                                 | SMTP password                                      |
| `SMTP_FROM`            | `Last SaaS <notifications@localhost>` | Sender address                                     |
| `STORAGE_TYPE`         | `local`                               | `local` or `s3`                                    |
| `STORAGE_PATH`         | `./data/files`                        | Local file root                                    |
| `MAX_UPLOAD_SIZE`      | `52428800`                            | Maximum streamed upload bytes                      |
| `S3_ENDPOINT`          | empty                                 | Optional S3-compatible endpoint                    |
| `S3_REGION`            | `us-east-1`                           | S3 region                                          |
| `S3_BUCKET`            | empty                                 | Required for S3 storage                            |
| `S3_ACCESS_KEY`        | empty                                 | Optional explicit S3 credential; pair with secret  |
| `S3_SECRET_KEY`        | empty                                 | Optional explicit S3 credential                    |
| `S3_FORCE_PATH_STYLE`  | `false`                               | Use path-style S3 URLs                             |

The CLI stores `server`, `session_token`, and optional default `org` in
`~/.lastsaas/config.json`. `--org` overrides the saved organization for one
command. Production should use HTTPS so BetterAuth can issue secure cookies.
