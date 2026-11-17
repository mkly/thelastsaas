# Authentication

Browser authentication uses Better Auth's vanilla JavaScript client and the
HTTP handler mounted at `/api/auth/*`. Hono renders the pages; the shared
`packages/server/src/browser/auth.ts` module submits sign-in, signup, password
recovery, Google sign-in, sign-out, device approval, MCP consent, and invitation
acceptance through the official client and its plugins. Server-side `auth.api`
reads are used to render pages. Application operations such as organization
creation retain their domain services and permission checks.

The old `/auth/*` authentication POST wrappers are removed. `/auth/*` GET routes
render the UI and require JavaScript for authentication. Sign-out is a POST via
the client. The form displays CAPTCHA errors, rate limits, and magic-link send
failures reported by Better Auth. Password signup and password reset can return
success even when the email sender fails. Check the server logs for those
failures. A successful form submission does not confirm inbox delivery.

Ordinary MCP connections support magic links, including links opened in a fresh
browser. When an MCP client sends `prompt=login` or `max_age=0`, use Google
or password sign-in. Better Auth can finish those requests during sign-in.
Opening an email link returns to the authorization endpoint, where those
parameters request another login. An email-only installation can complete
ordinary MCP connections and explains the limitation for those two requests.

The browser bundle is built on first request in source mode and cached until
restart. `scripts/build-server.ts` builds and embeds the same bundle into the
standalone binary; deployment needs no Node modules or separate frontend build.

## Optional Turnstile

Create a Cloudflare Turnstile widget for the public application's hostname, then
configure both values and restart:

```dotenv
TURNSTILE_SITE_KEY=your-public-site-key
TURNSTILE_SECRET_KEY=your-private-secret-key
```

Leaving both empty disables CAPTCHA for self-hosted installations. Supplying
only one fails startup. Only the site key is rendered into HTML. The widget
uses action `auth`; Better Auth checks the token, action, and hostname against
`BETTER_AUTH_URL` before processing the request. Failed verification or a
provider outage rejects the request without sending email.

The CAPTCHA plugin covers `/sign-in/magic-link`, `/sign-in/email`,
`/sign-up/email`, `/request-password-reset`, and `/send-verification-email`.
Tokens travel in `x-captcha-response`. Email link verification, Google OAuth,
CLI polling, and MCP authorization/token exchange do not require CAPTCHA.
A custom frontend using these protected email endpoints must send the token too.

## Authentication rate limits and proxies

Better Auth's own rate limiter is enabled in production and disabled in local
and test environments. `AUTH_RATE_LIMIT_ENABLED=true` enables it explicitly.
Its magic-link plugin limits requests to five per IP per minute; other endpoints
use Better Auth's built-in rules. This is separate from the authenticated `/v1`
API guard configured by `RATE_LIMIT_*`.

By default the Bun entrypoint supplies the socket's remote address in an
internal header, overwriting any caller-supplied value. For deployments behind
a reverse proxy, configure the one header that your trusted proxy overwrites
with the actual client IP, for example:

```dotenv
AUTH_TRUSTED_IP_HEADER=X-Forwarded-For
```

Only use this when clients cannot reach the origin directly and the proxy
removes untrusted incoming values. A single-IP header is simplest; do not pass
an arbitrary forwarding chain. With no proxy configuration, all traffic through
one reverse proxy shares that proxy's rate limit. Cloudflare deployments can
use `CF-Connecting-IP` when the origin accepts requests only from Cloudflare.
The default limiter is in memory per server process and resets on restart;
multi-process installations should configure shared storage through Better Auth.

## Existing installations

### Upgrading from Better Auth 1.7.1 to 1.7.25

Back up the database and apply the account schema change before starting the
upgraded server. Better Auth identifies a linked account by `providerId` and
`accountId`. The migration makes the old `issuer` column optional and removes
its unique index. Existing rows retain their issuer, credential data
and user IDs. Users keep their passwords, organization memberships and
permissions. Keep the signing secret and public origin stable across the upgrade.

Check existing account keys before the upgrade. If this query returns rows,
resolve the conflicting provider identities before upgrading. Better Auth rejects
ambiguous account lookups. [Better Auth upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide#check-for-duplicate-account-keys)

```sql
SELECT "providerId", "accountId", COUNT(*)
FROM "account"
GROUP BY "providerId", "accountId"
HAVING COUNT(*) > 1;
```

Run the applicable command from `packages/server` with `DATABASE_URL` set for
that installation.

- **SQLite with Prisma migration history** — run `bunx prisma migrate deploy`.
- **SQLite previously provisioned with `db push`** — apply the [SQLite upgrade](../packages/server/prisma/migrations/20261117000000_better_auth_account_identity/migration.sql) once with `bunx prisma db execute --schema prisma/schema.prisma --file prisma/migrations/20261117000000_better_auth_account_identity/migration.sql`.
- **PostgreSQL** — run `bun ../../scripts/generate-postgres-schema.ts`, then apply the [PostgreSQL upgrade](../packages/server/prisma/upgrades/postgresql/20261117000000_better_auth_account_identity.sql) once with `bunx prisma db execute --schema prisma/schema.postgres.prisma --file prisma/upgrades/postgresql/20261117000000_better_auth_account_identity.sql`.

Fresh installations use the current Prisma schema directly.

References: [Hono integration](https://better-auth.com/docs/integrations/hono),
[client](https://better-auth.com/docs/concepts/client),
[CAPTCHA](https://better-auth.com/docs/plugins/captcha),
[rate limits](https://better-auth.com/docs/concepts/rate-limit).
