import { isDeepStrictEqual } from "node:util";
import {
  extractFieldType,
  isMultipleReference,
  SchemaValidationError,
  type Schema,
} from "@lastsaas/shared";
import type { Prisma } from "@prisma/client";
import type { UnitOfWork } from "./unit-of-work";
import { evaluateGrants, resolveRecordGrants } from "./record-grants";
import { canReadFile } from "./attachment-access";

export async function recordPrincipal(
  db: Prisma.TransactionClient,
  orgId: string,
  userId: string,
) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return { orgId, userId, userEmail: user?.email ?? "" };
}

export function linkIds(value: unknown): string[] {
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string")
      : [];
}

/** JSON and indexed links commit together. Composite foreign keys enforce tenant and deletion integrity. */
export async function synchronizeRecordLinks(
  unit: UnitOfWork,
  orgId: string,
  recordId: string,
  schema: Schema,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  actorId: string,
  validateOnly = false,
) {
  const { db, provider } = unit;
  const principal = await recordPrincipal(db, orgId, actorId);
  for (const [field, definition] of Object.entries(schema)) {
    const type = extractFieldType(definition)!;
    if (!type.startsWith("ref:") && type !== "attachments") continue;
    if (before && isDeepStrictEqual(before[field], after[field])) continue;
    const ids = linkIds(after[field]);
    const previous = new Set(linkIds(before?.[field]));
    const assigned = ids.filter((id) => !previous.has(id));
    if (type.startsWith("ref:")) {
      const target = await db.collection.findUnique({
        where: { orgId_name: { orgId, name: type.slice(4) } },
      });
      if (!target && ids.length)
        throw new SchemaValidationError([
          `Field '${field}': reference target is unavailable`,
        ]);
      if (target && assigned.length) {
        const rows = await db.record.findMany({
          where: { orgId, collectionId: target.id, id: { in: assigned } },
        });
        if (rows.length !== assigned.length)
          throw new SchemaValidationError([
            `Field '${field}': reference target is unavailable`,
          ]);
        if (actorId !== "system") {
          const grants = await resolveRecordGrants(
            db,
            principal,
            target.id,
            `/collections/${target.name}`,
            "read",
          );
          for (const row of rows) {
            if (
              !(
                await evaluateGrants(
                  db,
                  grants,
                  row,
                  target.schema as Schema,
                  provider,
                )
              ).some(Boolean)
            )
              throw new SchemaValidationError([
                `Field '${field}': reference target is unavailable`,
              ]);
          }
        }
      }
      if (validateOnly) continue;
      await db.recordReference.deleteMany({
        where: { orgId, sourceId: recordId, field },
      });
      if (ids.length)
        await db.recordReference.createMany({
          data: ids.map((targetId, position) => ({
            orgId,
            sourceId: recordId,
            field,
            targetId,
            position,
          })),
        });
    } else {
      for (const fileId of assigned) {
        const file = await db.file.findFirst({ where: { orgId, id: fileId } });
        if (
          !file ||
          (actorId !== "system" &&
            unit.attachmentUploadId !== fileId &&
            !(await canReadFile(db, provider, principal, file)))
        )
          throw new SchemaValidationError([
            `Field '${field}': attachment is unavailable`,
          ]);
      }
      if (validateOnly) continue;
      await db.recordAttachment.deleteMany({
        where: { orgId, recordId, field },
      });
      if (ids.length)
        await db.recordAttachment.createMany({
          data: ids.map((fileId, position) => ({
            orgId,
            recordId,
            field,
            fileId,
            position,
          })),
        });
    }
  }
}

export function referenceDefinitions(schema: Schema) {
  return Object.entries(schema).flatMap(([field, definition]) => {
    const type = extractFieldType(definition);
    return type?.startsWith("ref:")
      ? [
          {
            field,
            collection: type.slice(4),
            multiple: isMultipleReference(definition),
          },
        ]
      : [];
  });
}
