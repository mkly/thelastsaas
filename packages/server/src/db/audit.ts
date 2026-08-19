import { genId } from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";

export type AuditDetails = Prisma.InputJsonObject;

export type AuditWriter = (
  action: string,
  resourceType: string,
  resourceId?: string | null,
  details?: AuditDetails | null,
) => Promise<void>;

export async function addAuditLog(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
  action: string,
  resourceType: string,
  resourceId?: string | null,
  details?: AuditDetails | null,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      id: genId(),
      orgId,
      userId,
      action,
      resourceType,
      resourceId: resourceId ?? null,
      details: details ?? Prisma.DbNull,
    },
  });
}

export function createAuditWriter(
  prisma: PrismaClient,
  orgId: string,
  userId: string,
): AuditWriter {
  return (action, resourceType, resourceId, details) =>
    addAuditLog(
      prisma,
      orgId,
      userId,
      action,
      resourceType,
      resourceId,
      details,
    );
}

export async function getAuditLog(
  prisma: PrismaClient,
  orgId: string,
  limit = 50,
  action?: string,
  resourceType?: string,
) {
  const where: Prisma.AuditLogWhereInput = { orgId };
  if (action) where.action = action;
  if (resourceType) where.resourceType = resourceType;

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return rows.map((row) => ({
    id: row.id,
    user_id: row.userId,
    action: row.action,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    details: row.details,
    created_at: row.createdAt,
  }));
}
