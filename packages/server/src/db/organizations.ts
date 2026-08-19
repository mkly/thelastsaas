import type { PrismaClient } from "@prisma/client";

import type { Auth } from "../auth";

interface OrganizationUser {
  id: string;
  name: string;
}

export async function ensurePersonalOrganization(
  prisma: PrismaClient,
  auth: Auth,
  user: OrganizationUser,
): Promise<{ created: boolean; orgId: string }> {
  const membership = await prisma.member.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { organizationId: true },
  });
  if (membership) {
    return { created: false, orgId: membership.organizationId };
  }

  const organization = await auth.api.createOrganization({
    body: {
      name: `${user.name}'s Org`,
      slug: `personal-${user.id}`,
      userId: user.id,
      keepCurrentActiveOrganization: true,
    },
  });

  return { created: true, orgId: organization.id };
}
