import type { PrismaClient } from "@prisma/client";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { checkPermission, roleSubject } from "./db/casbin";
import { invalidateMetadata, policyCacheKey } from "./db/cache";
import { getCollection } from "./db/collections";
import {
  encodeGrantOptions,
  grantOptionSchema,
  validateGrantOptions,
} from "./db/grant-options";

export const invitationPermissionsSchema = z
  .array(
    z
      .object({
        resource: z.string().min(1).max(512).startsWith("/"),
        action: z.enum([
          "read",
          "create",
          "update",
          "write",
          "delete",
          "manage",
          "*",
        ]),
        ...grantOptionSchema,
      })
      .strict(),
  )
  .max(100);

export async function validateInvitationPermissions(
  prisma: PrismaClient,
  orgId: string,
  inviterId: string,
  input: unknown,
) {
  const parsed = invitationPermissionsSchema.safeParse(input);
  if (!parsed.success)
    throw new APIError("BAD_REQUEST", {
      message: "Invalid invitation permissions",
    });
  if (
    parsed.data.length &&
    !(await checkPermission(prisma, orgId, inviterId, "/permissions", "manage"))
      .allowed
  )
    throw new APIError("FORBIDDEN", { message: "Cannot manage permissions" });
  for (const grant of parsed.data) {
    if (/^\/collections\/[^/*]+$/.test(grant.resource))
      await getCollection(
        prisma,
        orgId,
        grant.resource.slice("/collections/".length),
      );
    await validateGrantOptions(
      prisma,
      orgId,
      grant.resource,
      grant.action,
      grant,
    );
  }
  return parsed.data;
}

export async function applyInvitationPermissions(
  prisma: PrismaClient,
  invitation: { id: string; organizationId: string; permissions: unknown },
  member: { id: string; userId: string; role: string },
) {
  const orgId = invitation.organizationId;
  try {
    const grants = invitationPermissionsSchema.parse(invitation.permissions);
    await prisma.$transaction(async (tx) => {
      const rules = [
        {
          ptype: "g",
          v0: member.userId,
          v1: roleSubject(orgId, member.role),
          v2: null,
          v3: null,
        },
        ...grants.map((grant) => ({
          ptype: "p",
          v0: member.userId,
          v1: grant.resource,
          v2: grant.action,
          v3: encodeGrantOptions(grant),
        })),
      ];
      for (const rule of rules) {
        if (!(await tx.casbinRule.findFirst({ where: { orgId, ...rule } })))
          await tx.casbinRule.create({ data: { orgId, ...rule } });
      }
    });
  } catch (error) {
    // Better Auth calls this hook after committing membership. Make a failed
    // permission setup retryable instead of leaving a partially joined user.
    await prisma.$transaction(async (tx) => {
      await tx.member.delete({ where: { id: member.id } });
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: "pending" },
      });
    });
    throw error;
  } finally {
    await invalidateMetadata(prisma, policyCacheKey(orgId));
  }
}
