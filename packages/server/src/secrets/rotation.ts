import {
  AutomationConflictError,
  AutomationUnavailableError,
  SchemaValidationError,
  genId,
  secretRotationSchema,
  type SecretKeyring,
  type SecretRotation,
  type SecretRotationResult,
} from "@lastsaas/shared";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "./crypto";

const cursorSchema = z.strictObject({
  resource: z.literal("secret-rotation:v1"),
  orgId: z.string(),
  keyVersion: z.string(),
  id: z.string().min(1).max(128),
});

function decodeCursor(cursor: string, orgId: string, keyVersion: string) {
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error();
    const position = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (position.orgId !== orgId || position.keyVersion !== keyVersion)
      throw new Error();
    return position.id;
  } catch {
    throw new SchemaValidationError(["Invalid secret rotation cursor"]);
  }
}

/** One atomic batch. Retrying a batch skips entries already at the target version. */
export async function rotateSecretBatch(
  prisma: PrismaClient,
  keyring: SecretKeyring | null,
  orgId: string,
  input: SecretRotation,
): Promise<SecretRotationResult> {
  const parsed = secretRotationSchema.safeParse(input);
  if (!parsed.success)
    throw new SchemaValidationError(["Invalid secret rotation request"]);
  const { key_version: keyVersion, limit, cursor } = parsed.data;
  const position = cursor ? decodeCursor(cursor, orgId, keyVersion) : null;
  const targetKey = keyring?.keys.get(keyVersion);
  if (!targetKey || targetKey.byteLength !== 32)
    throw new AutomationUnavailableError(
      "Secret encryption key is unavailable",
    );

  return prisma.$transaction(
    async (db) => {
      const candidates = await db.secret.findMany({
        where: {
          orgId,
          keyVersion: { not: keyVersion },
          ...(position ? { id: { gt: position } } : {}),
        },
        orderBy: { id: "asc" },
        take: limit + 1,
      });
      const batch = candidates.slice(0, limit);
      for (const row of batch) {
        const encrypted = encryptSecret(
          keyring,
          row,
          decryptSecret(keyring, row, row),
          keyVersion,
        );
        // Include every envelope field, not just the version/timestamp: a replacement
        // can use the same key and timestamp as the snapshot. Never overwrite it.
        const updated = await db.secret.updateMany({
          where: {
            id: row.id,
            orgId: row.orgId,
            name: row.name,
            keyVersion: row.keyVersion,
            ciphertext: row.ciphertext,
            nonce: row.nonce,
            authTag: row.authTag,
            updatedAt: row.updatedAt,
          },
          data: encrypted,
        });
        if (updated.count !== 1)
          throw new AutomationConflictError(
            "Secret changed during rotation; retry the batch",
          );
        await db.auditLog.create({
          data: {
            id: genId(),
            orgId,
            action: "rotate_secret",
            resourceType: "secret",
            resourceId: row.id,
            details: {
              operator: "local",
              from_version: row.keyVersion,
              to_version: keyVersion,
            },
          },
        });
      }
      return {
        rotated: batch.length,
        next_cursor:
          candidates.length > limit
            ? Buffer.from(
                JSON.stringify({
                  resource: "secret-rotation:v1",
                  orgId,
                  keyVersion,
                  id: batch[batch.length - 1]!.id,
                }),
              ).toString("base64url")
            : null,
      };
    },
    // Up to 100 re-encryptions plus audits can exceed Prisma's 5s default.
    { timeout: 30_000 },
  );
}
