# Encrypted secret backup and restore

Ordinary organization exports omit secrets entirely. To include the stored
ciphertext and secret metadata, request an encrypted backup explicitly:

```sh
saas --org source export --include-encrypted-secrets --output backup.json
saas --org destination import backup.json
```

The REST equivalent is `POST /v1/orgs/:orgId/export?include_encrypted_secrets=true`.
MCP uses `org_export` with `{ "include_encrypted_secrets": true }`;
`org_import` takes `{ "data": <dump>, "confirm": true }`. REST import accepts
the dump directly at `POST /v1/orgs/:orgId/import`. Export/import keep their
existing `manage` gates on `/system/export` and `/system/import`.

The optional version-1 `encrypted_secrets` array contains source organization
and secret IDs, names, key versions, ciphertext, nonces, authentication tags and
timestamps. It contains no plaintext values or encryption keys. Protect this
file as a sensitive backup; metadata remains readable. Export authenticates
each entry with its configured key before returning a backup.

Back up the server's `SECRETS_KEYRING` separately and securely. A backup alone
cannot recover a secret if its encryption key is lost. On the destination,
configure the same key bytes for every key version in the dump, plus a valid
`SECRETS_ACTIVE_KEY_VERSION`. Matching version names with different key bytes
are insufficient. Keep old key versions until all live data and retained
backups that use them have expired or have been migrated.

Restore authenticates each entry using its original organization ID, secret ID
and key version. If an ID is already in use, restore generates a new one. It
then re-encrypts the value with a fresh nonce, the destination organization and
secret IDs, and the destination's active key version. Existing secrets with the
same name cause a conflict; restore never overwrites them. Missing/wrong keys,
tampered ciphertext or authenticated identity metadata, duplicate names and
other import failures roll back the entire import. No partial secret restore is
committed. Exports without secrets can be imported without encryption keys.

An imported secret remains subject to the usual separate metadata and reveal
permissions: `read /secrets/<name>` does not grant
`read /secrets/<name>/value`. Export and import responses use `Cache-Control:
no-store`; logs and audits exclude secret values and ciphertext.

## Rotate server encryption keys

Encryption keys are distinct from service-account API tokens and queue lease
tokens. Configure `SECRETS_KEYRING` as a JSON map of version names to canonical
base64 encodings of exactly 32 random bytes, and `SECRETS_ACTIVE_KEY_VERSION` as
one configured version. Both absent permits startup without secret writes/reveal;
partial or malformed configuration fails startup without exposing keys.

Add a new persistent key version while retaining old keys on every server.
Switch the active version so new writes use it. From the repository root, with
`DATABASE_URL`, the complete keyring and a matching generated Prisma client,
run the local operator (no HTTP, MCP or `saas secrets rotate` endpoint exists):

```sh
bun run --cwd packages/server secrets:rotate \
  --org <org-id> --key-version <new-version> --limit 100
# Continue with the returned next_cursor until it is null:
bun run --cwd packages/server secrets:rotate \
  --org <org-id> --key-version <new-version> \
  --limit 100 --cursor '<next-cursor>'
```

The local operator uses database and keyring access directly. Each rotated secret
records an audit event with local-operator attribution. Batches contain 1..100
secrets and are resumable; fix configuration and retry the same cursor on error.
The command never deletes old versions. Retain them until live ciphertext and
all retained backups using them are migrated or expired. A new version name
must represent new key bytes; replacing old bytes under the same name breaks
existing ciphertext. Keep database and key backups separately protected.
