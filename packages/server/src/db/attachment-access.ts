import {
  extractFieldType,
  FileMissingError,
  PermissionDeniedError,
  type AttachmentDestination,
  type Schema,
} from "@lastsaas/shared";
import type { File, Prisma } from "@prisma/client";
import { hasPermission } from "./casbin";
import {
  evaluateGrants,
  resolveRecordGrants,
  assertGrantedWrite,
} from "./record-grants";
import type { DbProvider, Principal } from "./query/compile";
import { canReadHistoryFile } from "./record-history";

export async function canReadFile(
  db: Prisma.TransactionClient,
  provider: DbProvider,
  principal: Principal,
  file: File,
): Promise<boolean> {
  if (file.orgId !== principal.orgId) return false;
  if (
    file.standalone &&
    (await hasPermission(
      db,
      principal.orgId,
      principal.userId,
      "/files",
      "read",
    ))
  )
    return true;
  const links = await db.recordAttachment.findMany({
    where: { orgId: principal.orgId, fileId: file.id },
    include: { record: { include: { collection: true } } },
  });
  for (const link of links) {
    const row = link.record;
    const schema = row.collection.schema as Schema;
    if (extractFieldType(schema[link.field]!) !== "attachments") continue;
    const grants = await resolveRecordGrants(
      db,
      principal,
      row.collectionId,
      `/collections/${row.collection.name}`,
      "read",
    );
    const matches = await evaluateGrants(db, grants, row, schema, provider);
    if (
      grants.some(
        (grant, i) =>
          matches[i] &&
          (grant.readable === undefined || grant.readable.includes(link.field)),
      )
    )
      return true;
  }
  return canReadHistoryFile(db, provider, principal, file.id);
}

export async function authorizeFileRead(
  db: Prisma.TransactionClient,
  provider: DbProvider,
  principal: Principal,
  fileId: string,
) {
  const member = await db.member.findUnique({
    where: {
      organizationId_userId: {
        organizationId: principal.orgId,
        userId: principal.userId,
      },
    },
  });
  if (!member) throw new PermissionDeniedError();
  const file = await db.file.findFirst({
    where: { orgId: principal.orgId, id: fileId },
  });
  if (!file || !(await canReadFile(db, provider, principal, file)))
    throw new FileMissingError(fileId);
  return file;
}

export async function attachmentDestination(
  db: Prisma.TransactionClient,
  provider: DbProvider,
  principal: Principal,
  destination: AttachmentDestination,
) {
  const record = await db.record.findFirst({
    where: {
      orgId: principal.orgId,
      id: destination.record_id,
      collection: { name: destination.collection },
    },
    include: { collection: true },
  });
  if (
    !record ||
    extractFieldType(
      (record.collection.schema as Schema)[destination.field]!,
    ) !== "attachments"
  )
    throw new PermissionDeniedError("Attachment destination is unavailable");
  const grants = await resolveRecordGrants(
    db,
    principal,
    record.collectionId,
    `/collections/${destination.collection}`,
    "update",
  );
  const matches = await evaluateGrants(
    db,
    grants,
    record,
    record.collection.schema as Schema,
    provider,
  );
  assertGrantedWrite(grants, matches, matches, [destination.field]);
  return { record, grants };
}
