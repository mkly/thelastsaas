import type { Prisma, PrismaClient } from "@prisma/client";

interface Policy {
  ptype: "p" | "g";
  v0: string;
  v1: string;
  v2: string | null;
}

export async function bootstrapOrgPolicies(
  prisma: PrismaClient,
  orgId: string,
  adminUserId: string,
): Promise<void> {
  const role = `org:${orgId}:user:admin`;
  const policies: readonly Policy[] = [
    { ptype: "p", v0: role, v1: "/*", v2: "*" },
    { ptype: "g", v0: adminUserId, v1: role, v2: null },
  ];

  await prisma.$transaction(async (transaction: Prisma.TransactionClient) => {
    for (const policy of policies) {
      const existing = await transaction.casbinRule.findFirst({
        where: { orgId, ...policy },
        select: { id: true },
      });
      if (!existing) {
        await transaction.casbinRule.create({ data: { orgId, ...policy } });
      }
    }
  });
}
