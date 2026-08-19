import type { PrismaClient } from "@prisma/client";

export async function getStats(prisma: PrismaClient, orgId: string) {
  const [collections, records, files, storage] = await Promise.all([
    prisma.collection.count({ where: { orgId } }),
    prisma.record.count({ where: { orgId } }),
    prisma.file.count({ where: { orgId } }),
    prisma.file.aggregate({
      where: { orgId },
      _sum: { sizeBytes: true },
    }),
  ]);

  return {
    collections,
    records,
    files,
    storage_bytes: storage._sum.sizeBytes ?? 0,
  };
}
