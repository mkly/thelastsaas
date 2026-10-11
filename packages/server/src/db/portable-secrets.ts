import {
  AutomationConflictError,
  AutomationUnavailableError,
  SchemaValidationError,
  genId,
  type EncryptedSecret,
  type SecretKeyring,
} from "@lastsaas/shared";
import type { Prisma } from "@prisma/client";
import { decryptSecret, encryptSecret } from "../secrets/crypto";

export async function exportSecrets(
  db: Prisma.TransactionClient,
  orgId: string,
  keyring: SecretKeyring | null,
): Promise<EncryptedSecret[]> {
  if (!keyring)
    throw new AutomationUnavailableError(
      "Secret encryption key is unavailable",
    );
  const rows = await db.secret.findMany({
    where: { orgId },
    orderBy: { name: "asc" },
  });
  return rows.map((row) => {
    // Verify key availability and authentication before emitting a restorable dump.
    decryptSecret(keyring, row, row);
    return {
      id: row.id,
      organization_id: row.orgId,
      name: row.name,
      key_version: row.keyVersion,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      auth_tag: row.authTag,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  });
}

export async function importSecrets(
  db: Prisma.TransactionClient,
  orgId: string,
  secrets: EncryptedSecret[],
  keyring: SecretKeyring | null,
): Promise<number> {
  const names = new Set<string>();
  const identities = new Set<string>();
  for (const secret of secrets) {
    const identity = JSON.stringify([secret.organization_id, secret.id]);
    if (names.has(secret.name) || identities.has(identity))
      throw new SchemaValidationError(["Duplicate encrypted secret"]);
    names.add(secret.name);
    identities.add(identity);
    if (
      await db.secret.findUnique({
        where: { orgId_name: { orgId, name: secret.name } },
        select: { id: true },
      })
    )
      throw new AutomationConflictError("Secret name already exists");
    const id = (await db.secret.findUnique({
      where: { id: secret.id },
      select: { id: true },
    }))
      ? genId()
      : secret.id;
    const value = decryptSecret(
      keyring,
      { orgId: secret.organization_id, id: secret.id },
      {
        keyVersion: secret.key_version,
        ciphertext: secret.ciphertext,
        nonce: secret.nonce,
        authTag: secret.auth_tag,
      },
    );
    // Organization and ID are authenticated: never copy source ciphertext onto
    // a new identity. Re-encrypt with the destination's active key and fresh nonce.
    await db.secret.create({
      data: {
        id,
        orgId,
        name: secret.name,
        ...encryptSecret(keyring, { orgId, id }, value),
        createdAt: new Date(secret.created_at),
        updatedAt: new Date(secret.updated_at),
      },
    });
  }
  return secrets.length;
}
