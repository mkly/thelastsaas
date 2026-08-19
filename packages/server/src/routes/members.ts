import { errorResponse } from "@lastsaas/shared";
import { Hono } from "hono";
import { z } from "zod";

import { removeMemberAccess, syncMemberRole } from "../db/casbin";
import type { AppEnvironment } from "../env";
import { requirePermission } from "../middleware/permission";

const memberRoleSchema = z.enum(["owner", "admin", "member"]);
const managedMemberRoleSchema = z.enum(["admin", "member"]);
const listMembersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  role: memberRoleSchema.optional(),
  q: z.string().min(1).max(200).optional(),
});
const updateMemberRoleSchema = z
  .object({ role: managedMemberRoleSchema })
  .strict();

function invalidRequest(message: string) {
  return errorResponse("InvalidRequest", message);
}

function validationMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const readMembers = requirePermission("read", () => "/members");
const manageMembers = requirePermission("manage", () => "/members");

export const memberRouter = new Hono<AppEnvironment>()
  .get("/", readMembers, async (context) => {
    const parsed = listMembersSchema.safeParse(context.req.query());
    if (!parsed.success) {
      return context.json(invalidRequest(validationMessage(parsed.error)), 400);
    }

    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    const { limit, offset, role, q } = parsed.data;
    const where = {
      organizationId: orgId,
      ...(role ? { role } : {}),
      ...(q
        ? {
            user: {
              OR: [{ email: { contains: q } }, { name: { contains: q } }],
            },
          }
        : {}),
    };

    const [rows, total, groupingRules] = await Promise.all([
      prisma.member.findMany({
        where,
        include: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { createdAt: "asc" },
        take: limit,
        skip: offset,
      }),
      prisma.member.count({ where }),
      prisma.casbinRule.findMany({
        where: { orgId, ptype: "g" },
        select: { v0: true, v1: true },
      }),
    ]);

    const rolePrefix = `org:${orgId}:user:`;
    const rolesByUser = new Map<string, string[]>();
    for (const rule of groupingRules) {
      if (!rule.v0 || !rule.v1?.startsWith(rolePrefix)) continue;
      const roles = rolesByUser.get(rule.v0) ?? [];
      roles.push(rule.v1.slice(rolePrefix.length));
      rolesByUser.set(rule.v0, roles);
    }

    return context.json({
      status: "ok" as const,
      members: rows.map((member) => ({
        member_id: member.id,
        user_id: member.user.id,
        email: member.user.email,
        name: member.user.name,
        member_role: member.role,
        casbin_roles: rolesByUser.get(member.user.id) ?? [],
        joined_at: member.createdAt,
      })),
      total,
      limit,
      offset,
    });
  })
  .patch("/:memberId/role", manageMembers, async (context) => {
    const parsed = updateMemberRoleSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(invalidRequest(validationMessage(parsed.error)), 400);
    }

    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    const member = await prisma.member.findFirst({
      where: { id: context.req.param("memberId"), organizationId: orgId },
      select: { id: true, userId: true, role: true },
    });
    if (!member) {
      return context.json(errorResponse("NotFound", "Member not found"), 404);
    }
    const previousRole = member.role;

    try {
      await context.get("services").auth.api.updateMemberRole({
        body: {
          memberId: member.id,
          organizationId: orgId,
          role: parsed.data.role,
        },
        headers: context.req.raw.headers,
      });
      await syncMemberRole(
        prisma,
        orgId,
        member.userId,
        previousRole,
        parsed.data.role,
      );
    } catch (error) {
      return context.json(
        errorResponse(
          "InvalidRequest",
          failureMessage(error, "Failed to update member role"),
        ),
        400,
      );
    }

    return context.json({
      status: "ok" as const,
      user_id: member.userId,
      role: parsed.data.role,
    });
  })
  .delete("/:memberId", manageMembers, async (context) => {
    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    const member = await prisma.member.findFirst({
      where: { id: context.req.param("memberId"), organizationId: orgId },
      select: { id: true, userId: true },
    });
    if (!member) {
      return context.json(errorResponse("NotFound", "Member not found"), 404);
    }

    try {
      await context.get("services").auth.api.removeMember({
        body: { memberIdOrEmail: member.id, organizationId: orgId },
        headers: context.req.raw.headers,
      });
      await removeMemberAccess(prisma, orgId, member.userId);
    } catch (error) {
      return context.json(
        errorResponse(
          "InvalidRequest",
          failureMessage(error, "Failed to remove member"),
        ),
        400,
      );
    }

    return context.json({ status: "ok" as const });
  });
