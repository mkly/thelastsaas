import {
  CollectionNotFoundError,
  errorResponse,
  isPlainObject,
} from "@lastsaas/shared";
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
import { getCollection } from "../db/collections";
import {
  deleteFieldFilter,
  listFieldFilters,
  setFieldFilter,
} from "../db/fieldFilters";
import {
  deleteRowFilter,
  listRowFilters,
  setRowFilter,
} from "../db/rowFilters";
import { whereSchema } from "../db/query/validation";
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
const rowFilterSchema = z
  .object({
    collection: z.string().min(1),
    role: roleSchema.shape.role,
    action: z.enum(["read", "write", "delete"]),
    condition: whereSchema,
  })
  .strict();
const fieldNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/);
const fieldFilterSchema = z
  .object({
    collection: z.string().min(1),
    role: roleSchema.shape.role,
    action: z.enum(["read", "write", "delete"]),
    readable_fields: z.array(fieldNameSchema).max(512),
    writable_fields: z.array(fieldNameSchema).max(512),
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
    await context.get("audit")("add_policy", "permission", null, {
      subject,
      resource,
      action,
    });
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
    await context.get("audit")("remove_policy", "permission", null, {
      subject,
      resource,
      action,
    });
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

    await context.get("audit")("assign_role", "permission", null, {
      user_id: userId,
      role: parsed.data.role,
    });
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
    await context.get("audit")("unassign_role", "permission", null, {
      user_id: userId,
      role: parsed.data.role,
    });
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
  })
  .get("/row-filters", managePermissions, async (context) => {
    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    const collectionName = context.req.query("collection");
    let collectionId: string | undefined;

    if (collectionName) {
      try {
        collectionId = (await getCollection(prisma, orgId, collectionName)).id;
      } catch (error) {
        if (error instanceof CollectionNotFoundError) {
          return context.json({ status: "ok" as const, row_filters: [] });
        }
        throw error;
      }
    }

    const rows = await listRowFilters(prisma, orgId, collectionId);
    return context.json({
      status: "ok" as const,
      row_filters: rows.map((row) => ({
        id: row.id,
        collection: row.collection.name,
        collection_id: row.collectionId,
        role: row.role,
        action: row.action,
        condition: row.condition,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      })),
    });
  })
  .post("/row-filters", managePermissions, async (context) => {
    const parsed = rowFilterSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(invalidRequest(validationMessage(parsed.error)), 400);
    }

    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    try {
      const collection = await getCollection(
        prisma,
        orgId,
        parsed.data.collection,
      );
      const row = await setRowFilter(
        prisma,
        orgId,
        collection.id,
        parsed.data.role,
        parsed.data.action,
        parsed.data.condition,
      );
      await context.get("audit")("set_row_filter", "permission", row.id, {
        collection: parsed.data.collection,
        role: parsed.data.role,
        action: parsed.data.action,
      });
      return context.json({ status: "ok" as const, id: row.id });
    } catch (error) {
      if (error instanceof CollectionNotFoundError) {
        return context.json(error.toResponse(), 404);
      }
      throw error;
    }
  })
  .delete("/row-filters/:id", managePermissions, async (context) => {
    const id = context.req.param("id");
    const orgId = context.get("orgId");
    if (!(await deleteRowFilter(context.get("services").prisma, orgId, id))) {
      return context.json(
        errorResponse("NotFound", "Row filter not found"),
        404,
      );
    }
    await context.get("audit")("delete_row_filter", "permission", id, {});
    return context.json({ status: "ok" as const });
  })
  .get("/field-filters", managePermissions, async (context) => {
    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    const collectionName = context.req.query("collection");
    let collectionId: string | undefined;

    if (collectionName) {
      try {
        collectionId = (await getCollection(prisma, orgId, collectionName)).id;
      } catch (error) {
        if (error instanceof CollectionNotFoundError) {
          return context.json({ status: "ok" as const, field_filters: [] });
        }
        throw error;
      }
    }

    const rows = await listFieldFilters(prisma, orgId, collectionId);
    return context.json({
      status: "ok" as const,
      field_filters: rows.map((row) => ({
        id: row.id,
        collection: row.collection.name,
        collection_id: row.collectionId,
        role: row.role,
        action: row.action,
        readable_fields: row.readableFields,
        writable_fields: row.writableFields,
        created_at: row.createdAt.toISOString(),
        updated_at: row.updatedAt.toISOString(),
      })),
    });
  })
  .post("/field-filters", managePermissions, async (context) => {
    const parsed = fieldFilterSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(invalidRequest(validationMessage(parsed.error)), 400);
    }

    const orgId = context.get("orgId");
    const prisma = context.get("services").prisma;
    try {
      const collection = await getCollection(
        prisma,
        orgId,
        parsed.data.collection,
      );
      const collectionSchema = collection.schema;
      if (!isPlainObject(collectionSchema)) {
        return context.json(
          invalidRequest("Collection schema is corrupt"),
          400,
        );
      }
      const configuredFields = new Set([
        ...parsed.data.readable_fields,
        ...parsed.data.writable_fields,
      ]);
      const unknownFields = [...configuredFields].filter(
        (field) => !(field in collectionSchema),
      );
      if (unknownFields.length > 0) {
        return context.json(
          invalidRequest(
            `Unknown collection field${unknownFields.length === 1 ? "" : "s"}: ${unknownFields
              .map((field) => `'${field}'`)
              .join(", ")}`,
          ),
          400,
        );
      }
      const row = await setFieldFilter(
        prisma,
        orgId,
        collection.id,
        parsed.data.role,
        parsed.data.action,
        [...new Set(parsed.data.readable_fields)],
        [...new Set(parsed.data.writable_fields)],
      );
      await context.get("audit")("set_field_filter", "permission", row.id, {
        collection: parsed.data.collection,
        role: parsed.data.role,
        action: parsed.data.action,
      });
      return context.json({ status: "ok" as const, id: row.id });
    } catch (error) {
      if (error instanceof CollectionNotFoundError) {
        return context.json(error.toResponse(), 404);
      }
      throw error;
    }
  })
  .delete("/field-filters/:id", managePermissions, async (context) => {
    const id = context.req.param("id");
    const orgId = context.get("orgId");
    if (!(await deleteFieldFilter(context.get("services").prisma, orgId, id))) {
      return context.json(
        errorResponse("NotFound", "Field filter not found"),
        404,
      );
    }
    await context.get("audit")("delete_field_filter", "permission", id, {});
    return context.json({ status: "ok" as const });
  });
