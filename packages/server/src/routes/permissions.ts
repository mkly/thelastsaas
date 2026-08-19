import { errorResponse } from "@lastsaas/shared";
import type { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";

import {
  addPolicy,
  assignRole,
  hasPermission,
  removePolicy,
  roleSubject,
  unassignRole,
} from "../db/casbin";
import type { AppEnvironment } from "../env";
import { requirePermission } from "../middleware/permission";

const permissionActions = ["read", "write", "delete", "manage", "*"] as const;
const policySchema = z
  .object({
    subject: z.string().min(1),
    resource: z.string().min(1).max(512).startsWith("/"),
    action: z.enum(permissionActions),
  })
  .strict();
const roleSchema = z
  .object({
    user_id: z.string().min(1),
    role: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  })
  .strict();
const checkSchema = z
  .object({
    user_id: z.string().min(1),
    resource: z.string().min(1).max(512).startsWith("/"),
    action: z.enum(permissionActions),
  })
  .strict();

function invalidRequest(message: string) {
  return errorResponse("InvalidRequest", message);
}

function validationMessage(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ");
}

async function resolveUserId(
  reference: string,
  prisma: PrismaClient,
): Promise<string | null> {
  if (!reference.includes("@")) return reference;
  const user = await prisma.user.findUnique({
    where: { email: reference },
    select: { id: true },
  });
  return user?.id ?? null;
}

async function isOrgMember(
  userId: string,
  orgId: string,
  prisma: PrismaClient,
): Promise<boolean> {
  const member = await prisma.member.findUnique({
    where: {
      organizationId_userId: { organizationId: orgId, userId },
    },
    select: { id: true },
  });
  return member !== null;
}

async function expandSubject(
  subject: string,
  orgId: string,
  prisma: PrismaClient,
): Promise<{ id: string; isUser: boolean } | null> {
  if (subject.startsWith("role:")) {
    const role = subject.slice("role:".length);
    if (!roleSchema.shape.role.safeParse(role).success) return null;
    return { id: roleSubject(orgId, role), isUser: false };
  }
  if (subject.startsWith("user:")) {
    const id = await resolveUserId(subject.slice("user:".length), prisma);
    return id ? { id, isUser: true } : null;
  }
  return null;
}

function contractSubject(subject: string, orgId: string): string {
  const prefix = roleSubject(orgId, "");
  return subject.startsWith(prefix)
    ? `role:${subject.slice(prefix.length)}`
    : `user:${subject}`;
}

const managePermissions = requirePermission("manage", () => "/permissions");

export const permissionRouter = new Hono<AppEnvironment>()
  .get("/", managePermissions, async (context) => {
    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    const [rules, members] = await Promise.all([
      prisma.casbinRule.findMany({
        where: { orgId, ptype: { in: ["p", "g"] } },
        orderBy: { id: "asc" },
        select: { ptype: true, v0: true, v1: true, v2: true },
      }),
      prisma.member.findMany({
        where: { organizationId: orgId },
        select: { userId: true },
      }),
    ]);
    const memberIds = new Set(members.map(({ userId }) => userId));
    const rolePrefix = roleSubject(orgId, "");

    const policies = rules
      .filter(
        (rule) =>
          rule.ptype === "p" &&
          rule.v0 &&
          rule.v1 &&
          rule.v2 &&
          (rule.v0.startsWith(rolePrefix) || memberIds.has(rule.v0)),
      )
      .map((rule) => ({
        subject: contractSubject(rule.v0!, orgId),
        resource: rule.v1!,
        action: rule.v2!,
      }));
    const role_assignments = rules
      .filter(
        (rule) =>
          rule.ptype === "g" &&
          rule.v0 &&
          memberIds.has(rule.v0) &&
          rule.v1?.startsWith(rolePrefix),
      )
      .map((rule) => ({
        user_id: rule.v0!,
        role: rule.v1!.slice(rolePrefix.length),
      }));

    return context.json({ status: "ok" as const, policies, role_assignments });
  })
  .post("/policies", managePermissions, async (context) => {
    const parsed = policySchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(invalidRequest(validationMessage(parsed.error)), 400);
    }

    const { subject, resource, action } = parsed.data;
    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    const expanded = await expandSubject(subject, orgId, prisma);
    if (!expanded) {
      return context.json(
        invalidRequest("subject must be role:<name> or user:<id|email>"),
        400,
      );
    }
    if (expanded.isUser && !(await isOrgMember(expanded.id, orgId, prisma))) {
      return context.json(
        errorResponse("Forbidden", "User is not a member of this organization"),
        403,
      );
    }

    if (!(await addPolicy(prisma, orgId, expanded.id, resource, action))) {
      return context.json(
        errorResponse("Conflict", "Policy already exists"),
        409,
      );
    }
    return context.json(
      { status: "ok" as const, subject, resource, action },
      201,
    );
  })
  .delete("/policies", managePermissions, async (context) => {
    const parsed = policySchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(invalidRequest(validationMessage(parsed.error)), 400);
    }

    const { subject, resource, action } = parsed.data;
    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    const expanded = await expandSubject(subject, orgId, prisma);
    if (!expanded) {
      return context.json(
        invalidRequest("subject must be role:<name> or user:<id|email>"),
        400,
      );
    }
    if (expanded.isUser && !(await isOrgMember(expanded.id, orgId, prisma))) {
      return context.json(
        errorResponse("Forbidden", "User is not a member of this organization"),
        403,
      );
    }

    if (!(await removePolicy(prisma, orgId, expanded.id, resource, action))) {
      return context.json(errorResponse("NotFound", "Policy not found"), 404);
    }
    return context.json({ status: "ok" as const });
  })
  .post("/roles", managePermissions, async (context) => {
    const parsed = roleSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(invalidRequest(validationMessage(parsed.error)), 400);
    }

    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    const userId = await resolveUserId(parsed.data.user_id, prisma);
    if (!userId) {
      return context.json(errorResponse("NotFound", "User not found"), 404);
    }
    if (!(await isOrgMember(userId, orgId, prisma))) {
      return context.json(
        errorResponse("Forbidden", "User is not a member of this organization"),
        403,
      );
    }
    if (!(await assignRole(prisma, orgId, userId, parsed.data.role))) {
      return context.json(
        errorResponse("Conflict", "Role assignment already exists"),
        409,
      );
    }

    return context.json(
      {
        status: "ok" as const,
        user_id: userId,
        role: parsed.data.role,
      },
      201,
    );
  })
  .delete("/roles", managePermissions, async (context) => {
    const parsed = roleSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(invalidRequest(validationMessage(parsed.error)), 400);
    }

    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    const userId = await resolveUserId(parsed.data.user_id, prisma);
    if (!userId) {
      return context.json(errorResponse("NotFound", "User not found"), 404);
    }
    if (!(await isOrgMember(userId, orgId, prisma))) {
      return context.json(
        errorResponse("Forbidden", "User is not a member of this organization"),
        403,
      );
    }
    if (!(await unassignRole(prisma, orgId, userId, parsed.data.role))) {
      return context.json(
        errorResponse("NotFound", "Role assignment not found"),
        404,
      );
    }
    return context.json({ status: "ok" as const });
  })
  .post("/check", managePermissions, async (context) => {
    const parsed = checkSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(invalidRequest(validationMessage(parsed.error)), 400);
    }

    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    const userId = await resolveUserId(parsed.data.user_id, prisma);
    if (!userId) {
      return context.json(errorResponse("NotFound", "User not found"), 404);
    }
    if (!(await isOrgMember(userId, orgId, prisma))) {
      return context.json(
        errorResponse("Forbidden", "User is not a member of this organization"),
        403,
      );
    }

    const allowed = await hasPermission(
      prisma,
      orgId,
      userId,
      parsed.data.resource,
      parsed.data.action,
    );
    return context.json({
      status: "ok" as const,
      allowed,
      user_id: userId,
      resource: parsed.data.resource,
      action: parsed.data.action,
    });
  });
