import { genId, type RecordMutationEvent } from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { MutationSnapshots } from "./record-mutations";
import type { GrantRecord } from "./record-grants";
import type { UnitOfWork } from "./unit-of-work";

export const RECORD_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function snapshot(row: GrantRecord | null) {
  return row === null
    ? Prisma.DbNull
    : (JSON.parse(
        JSON.stringify({
          data: row.data,
          created_by: row.createdBy,
          created_at: row.createdAt.toISOString(),
          updated_at: row.updatedAt.toISOString(),
        }),
      ) as Prisma.InputJsonObject);
}

/** Internal snapshots and metadata commit with the mutation, before any projection. */
export async function appendRecordHistory(
  unit: UnitOfWork,
  orgId: string,
  collectionId: string,
  recordId: string,
  actorId: string,
  operation: RecordMutationEvent["event"],
  snapshots: MutationSnapshots,
): Promise<void> {
  unit.changeSetId ??= genId();
  await unit.db.recordHistory.create({
    data: {
      id: genId(),
      orgId,
      collectionId,
      recordId,
      actorId,
      operation,
      changeSetId: unit.changeSetId,
      before: snapshot(snapshots.before),
      after: snapshot(snapshots.after),
    },
  });
}

/** One bounded batch per scheduler tick; reads also enforce the retention cutoff. */
export async function pruneRecordHistory(
  prisma: PrismaClient,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - RECORD_HISTORY_RETENTION_MS);
  const rows = await prisma.recordHistory.findMany({
    where: { createdAt: { lte: cutoff } },
    orderBy: [{ createdAt: "asc" }, { position: "asc" }],
    take: 500,
    select: { position: true },
  });
  if (!rows.length) return 0;
  const removed = await prisma.recordHistory.deleteMany({
    where: {
      position: { in: rows.map((row) => row.position) },
      createdAt: { lte: cutoff },
    },
  });
  return removed.count;
}
