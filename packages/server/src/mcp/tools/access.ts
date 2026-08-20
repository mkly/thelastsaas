import {
  CollectionNotFoundError,
  LastSaasError,
  isPlainObject,
  type Where,
} from "@lastsaas/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import { addAuditLog } from "../../db/audit";
import {
  addPolicy,
  assignRole,
  hasPermission,
  removeMemberAccess,
  removePolicy,
  roleSubject,
  syncMemberRole,
  unassignRole,
} from "../../db/casbin";
import { getCollection } from "../../db/collections";
import {
  deleteFieldFilter,
  listFieldFilters,
  setFieldFilter,
} from "../../db/fieldFilters";
import { whereSchema } from "../../db/query/validation";
import {
  deleteRowFilter,
  listRowFilters,
  setRowFilter,
} from "../../db/rowFilters";
import type { McpToolContext } from "../context";

const policyActions = ["read", "write", "delete", "manage", "*"] as const;
const filterActions = ["read", "write", "delete"] as const;
const memberRoles = ["admin", "member"] as const;
const roleName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const fieldName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/);

class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function success(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function failure(error: unknown): CallToolResult {
  const normalized =
    error instanceof ToolError || error instanceof LastSaasError
      ? {
          code: error instanceof ToolError ? error.code : error.code,
          message: error.message,
        }
      : {
          code: "InternalError",
          message:
            error instanceof Error ? error.message : "Unexpected tool failure",
        };
  const data = { error: normalized };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function run(handler: () => Promise<Record<string, unknown>>) {
  return async (): Promise<CallToolResult> => {
    try {
      return success(await handler());
    } catch (error) {
      return failure(error);
    }
  };
}

async function requirePermission(
  context: McpToolContext,
  resource: string,
): Promise<void> {
  if (
    !(await hasPermission(
      context.services.prisma,
      context.orgId,
      context.userId,
      resource,
      "manage",
    ))
  ) {
    throw new ToolError(
      "PermissionDenied",
      `User does not have manage permission on ${resource}`,
    );
  }
}

function audit(
  context: McpToolContext,
  action: string,
  resourceType: string,
  resourceId?: string | null,
  details?: Record<string, string>,
) {
  return addAuditLog(
    context.services.prisma,
    context.orgId,
    context.userId,
    action,
    resourceType,
    resourceId,
    details,
  );
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

async function requireOrgMember(
  reference: string,
  context: McpToolContext,
): Promise<string> {
  const userId = await resolveUserId(reference, context.services.prisma);
  if (!userId) throw new ToolError("NotFound", "User not found");
  const member = await context.services.prisma.member.findUnique({
    where: {
      organizationId_userId: {
        organizationId: context.orgId,
        userId,
      },
    },
    select: { id: true },
  });
  if (!member) {
    throw new ToolError(
      "Forbidden",
      "User is not a member of this organization",
    );
  }
  return userId;
}

async function expandSubject(
  subject: string,
  context: McpToolContext,
): Promise<string> {
  if (subject.startsWith("role:")) {
    const role = subject.slice("role:".length);
    if (!roleName.safeParse(role).success) {
      throw new ToolError(
        "InvalidRequest",
        "subject must be role:<name> or user:<id|email>",
      );
    }
    return roleSubject(context.orgId, role);
  }
  if (subject.startsWith("user:")) {
    return requireOrgMember(subject.slice("user:".length), context);
  }
  throw new ToolError(
    "InvalidRequest",
    "subject must be role:<name> or user:<id|email>",
  );
}

function contractSubject(subject: string, orgId: string): string {
  const prefix = roleSubject(orgId, "");
  return subject.startsWith(prefix)
    ? `role:${subject.slice(prefix.length)}`
    : `user:${subject}`;
}

async function authHeaders(context: McpToolContext): Promise<Headers> {
  const session = await context.services.prisma.session.findFirst({
    where: { userId: context.userId, expiresAt: { gt: new Date() } },
    orderBy: { updatedAt: "desc" },
    select: { token: true },
  });
  if (!session) {
    throw new ToolError(
      "Unauthorized",
      "No active authentication session is available for this MCP caller",
    );
  }
  return new Headers({ authorization: `Bearer ${session.token}` });
}

function registerPermissionTools(
  server: McpServer,
  context: McpToolContext,
): void {
  server.registerTool(
    "permissions_list",
    { description: "List policies and role assignments for the organization" },
    run(async () => {
      await requirePermission(context, "/permissions");
      const prisma = context.services.prisma;
      const [rules, members] = await Promise.all([
        prisma.casbinRule.findMany({
          where: { orgId: context.orgId, ptype: { in: ["p", "g"] } },
          orderBy: { id: "asc" },
          select: { ptype: true, v0: true, v1: true, v2: true },
        }),
        prisma.member.findMany({
          where: { organizationId: context.orgId },
          select: { userId: true },
        }),
      ]);
      const memberIds = new Set(members.map(({ userId }) => userId));
      const rolePrefix = roleSubject(context.orgId, "");
      return {
        status: "ok",
        policies: rules
          .filter(
            (rule) =>
              rule.ptype === "p" &&
              rule.v0 &&
              rule.v1 &&
              rule.v2 &&
              (rule.v0.startsWith(rolePrefix) || memberIds.has(rule.v0)),
          )
          .map((rule) => ({
            subject: contractSubject(rule.v0!, context.orgId),
            resource: rule.v1!,
            action: rule.v2!,
          })),
        role_assignments: rules
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
          })),
      };
    }),
  );

  const policySchema = {
    subject: z.string().min(1),
    resource: z.string().min(1).max(512).startsWith("/"),
    action: z.enum(policyActions),
  };
  server.registerTool(
    "permissions_grant",
    { description: "Add a policy rule", inputSchema: policySchema },
    (input) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        const subject = await expandSubject(input.subject, context);
        if (
          !(await addPolicy(
            context.services.prisma,
            context.orgId,
            subject,
            input.resource,
            input.action,
          ))
        ) {
          throw new ToolError("Conflict", "Policy already exists");
        }
        await audit(context, "add_policy", "permission", null, input);
        return { status: "ok", ...input };
      })(),
  );
  server.registerTool(
    "permissions_revoke",
    { description: "Remove a policy rule", inputSchema: policySchema },
    (input) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        const subject = await expandSubject(input.subject, context);
        if (
          !(await removePolicy(
            context.services.prisma,
            context.orgId,
            subject,
            input.resource,
            input.action,
          ))
        ) {
          throw new ToolError("NotFound", "Policy not found");
        }
        await audit(context, "remove_policy", "permission", null, input);
        return { status: "ok" };
      })(),
  );

  const assignmentSchema = { user_id: z.string().min(1), role: roleName };
  server.registerTool(
    "permissions_assign_role",
    {
      description: "Assign a user to a Casbin role",
      inputSchema: assignmentSchema,
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        const userId = await requireOrgMember(input.user_id, context);
        if (
          !(await assignRole(
            context.services.prisma,
            context.orgId,
            userId,
            input.role,
          ))
        ) {
          throw new ToolError("Conflict", "Role assignment already exists");
        }
        await audit(context, "assign_role", "permission", null, {
          user_id: userId,
          role: input.role,
        });
        return { status: "ok", user_id: userId, role: input.role };
      })(),
  );
  server.registerTool(
    "permissions_unassign_role",
    {
      description: "Remove a user from a Casbin role",
      inputSchema: assignmentSchema,
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        const userId = await requireOrgMember(input.user_id, context);
        if (
          !(await unassignRole(
            context.services.prisma,
            context.orgId,
            userId,
            input.role,
          ))
        ) {
          throw new ToolError("NotFound", "Role assignment not found");
        }
        await audit(context, "unassign_role", "permission", null, {
          user_id: userId,
          role: input.role,
        });
        return { status: "ok" };
      })(),
  );
  server.registerTool(
    "permissions_check",
    {
      description: "Check whether a user has a permission",
      inputSchema: {
        user_id: z.string().min(1),
        resource: policySchema.resource,
        action: policySchema.action,
      },
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        const userId = await requireOrgMember(input.user_id, context);
        return {
          status: "ok",
          allowed: await hasPermission(
            context.services.prisma,
            context.orgId,
            userId,
            input.resource,
            input.action,
          ),
          user_id: userId,
          resource: input.resource,
          action: input.action,
        };
      })(),
  );
}

function registerFilterTools(server: McpServer, context: McpToolContext): void {
  server.registerTool(
    "row_filter_set",
    {
      description: "Create or replace a row-level permission filter",
      inputSchema: {
        collection: z.string().min(1),
        role: roleName,
        action: z.enum(filterActions),
        condition: whereSchema,
      },
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        const collection = await getCollection(
          context.services.prisma,
          context.orgId,
          input.collection,
        );
        const row = await setRowFilter(
          context.services.prisma,
          context.orgId,
          collection.id,
          input.role,
          input.action,
          input.condition as Where,
        );
        await audit(context, "set_row_filter", "permission", row.id, {
          collection: input.collection,
          role: input.role,
          action: input.action,
        });
        return { status: "ok", id: row.id };
      })(),
  );
  server.registerTool(
    "row_filter_list",
    {
      description: "List row-level permission filters",
      inputSchema: { collection: z.string().min(1).optional() },
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        let collectionId: string | undefined;
        if (input.collection) {
          try {
            collectionId = (
              await getCollection(
                context.services.prisma,
                context.orgId,
                input.collection,
              )
            ).id;
          } catch (error) {
            if (error instanceof CollectionNotFoundError) {
              return { status: "ok", row_filters: [] };
            }
            throw error;
          }
        }
        const rows = await listRowFilters(
          context.services.prisma,
          context.orgId,
          collectionId,
        );
        return {
          status: "ok",
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
        };
      })(),
  );
  server.registerTool(
    "row_filter_delete",
    {
      description: "Delete a row-level permission filter",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        if (
          !(await deleteRowFilter(context.services.prisma, context.orgId, id))
        ) {
          throw new ToolError("NotFound", "Row filter not found");
        }
        await audit(context, "delete_row_filter", "permission", id);
        return { status: "ok" };
      })(),
  );

  server.registerTool(
    "field_filter_set",
    {
      description: "Create or replace a field-level permission filter",
      inputSchema: {
        collection: z.string().min(1),
        role: roleName,
        action: z.enum(filterActions),
        readable_fields: z.array(fieldName).max(512),
        writable_fields: z.array(fieldName).max(512),
      },
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        const collection = await getCollection(
          context.services.prisma,
          context.orgId,
          input.collection,
        );
        const collectionSchema = collection.schema;
        if (!isPlainObject(collectionSchema)) {
          throw new ToolError("InvalidRequest", "Collection schema is corrupt");
        }
        const fields = new Set([
          ...input.readable_fields,
          ...input.writable_fields,
        ]);
        const unknown = [...fields].filter(
          (field) => !(field in collectionSchema),
        );
        if (unknown.length > 0) {
          throw new ToolError(
            "InvalidRequest",
            `Unknown collection field${unknown.length === 1 ? "" : "s"}: ${unknown
              .map((field) => `'${field}'`)
              .join(", ")}`,
          );
        }
        const row = await setFieldFilter(
          context.services.prisma,
          context.orgId,
          collection.id,
          input.role,
          input.action,
          [...new Set(input.readable_fields)],
          [...new Set(input.writable_fields)],
        );
        await audit(context, "set_field_filter", "permission", row.id, {
          collection: input.collection,
          role: input.role,
          action: input.action,
        });
        return { status: "ok", id: row.id };
      })(),
  );
  server.registerTool(
    "field_filter_list",
    {
      description: "List field-level permission filters",
      inputSchema: { collection: z.string().min(1).optional() },
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        let collectionId: string | undefined;
        if (input.collection) {
          try {
            collectionId = (
              await getCollection(
                context.services.prisma,
                context.orgId,
                input.collection,
              )
            ).id;
          } catch (error) {
            if (error instanceof CollectionNotFoundError) {
              return { status: "ok", field_filters: [] };
            }
            throw error;
          }
        }
        const rows = await listFieldFilters(
          context.services.prisma,
          context.orgId,
          collectionId,
        );
        return {
          status: "ok",
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
        };
      })(),
  );
  server.registerTool(
    "field_filter_delete",
    {
      description: "Delete a field-level permission filter",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        if (
          !(await deleteFieldFilter(context.services.prisma, context.orgId, id))
        ) {
          throw new ToolError("NotFound", "Field filter not found");
        }
        await audit(context, "delete_field_filter", "permission", id);
        return { status: "ok" };
      })(),
  );
}

function registerInvitationTools(
  server: McpServer,
  context: McpToolContext,
): void {
  server.registerTool(
    "invitations_create",
    {
      description: "Invite a user to the organization",
      inputSchema: {
        email: z.string().email(),
        role: z.enum(memberRoles).default("member"),
      },
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/members");
        const invitation = await context.services.auth.api.createInvitation({
          body: { ...input, organizationId: context.orgId },
          headers: await authHeaders(context),
        });
        await audit(
          context,
          "create_invitation",
          "invitation",
          invitation.id,
          input,
        );
        return {
          status: "ok",
          invitation_id: invitation.id,
          email: input.email,
          role: input.role,
        };
      })(),
  );
  server.registerTool(
    "invitations_list",
    { description: "List pending organization invitations" },
    run(async () => {
      await requirePermission(context, "/members");
      const invitations = await context.services.prisma.invitation.findMany({
        where: { organizationId: context.orgId, status: "pending" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      });
      return {
        status: "ok",
        invitations: invitations.map((invitation) => ({
          ...invitation,
          expiresAt: invitation.expiresAt.toISOString(),
          createdAt: invitation.createdAt.toISOString(),
        })),
      };
    }),
  );
  server.registerTool(
    "invitations_accept",
    {
      description:
        "Accept an invitation (the org-scoped MCP endpoint limits this to existing members)",
      inputSchema: { invitation_id: z.string().min(1) },
    },
    ({ invitation_id }) =>
      run(async () => {
        // The MCP endpoint authenticates organization membership before a tool
        // can run, so this intentionally cannot bootstrap a non-member.
        const invitation = await context.services.prisma.invitation.findUnique({
          where: { id: invitation_id },
          select: { organizationId: true, status: true },
        });
        if (
          !invitation ||
          invitation.organizationId !== context.orgId ||
          invitation.status !== "pending"
        ) {
          throw new ToolError("NotFound", "Invitation not found");
        }
        await context.services.auth.api.acceptInvitation({
          body: { invitationId: invitation_id },
          headers: await authHeaders(context),
        });
        return { status: "ok" };
      })(),
  );
  server.registerTool(
    "invitations_cancel",
    {
      description: "Cancel a pending organization invitation",
      inputSchema: { invitation_id: z.string().min(1) },
    },
    ({ invitation_id }) =>
      run(async () => {
        await requirePermission(context, "/members");
        const invitation = await context.services.prisma.invitation.findUnique({
          where: { id: invitation_id },
          select: { organizationId: true, status: true },
        });
        if (
          !invitation ||
          invitation.organizationId !== context.orgId ||
          invitation.status !== "pending"
        ) {
          throw new ToolError("NotFound", "Invitation not found");
        }
        await context.services.auth.api.cancelInvitation({
          body: { invitationId: invitation_id },
          headers: await authHeaders(context),
        });
        await audit(context, "cancel_invitation", "invitation", invitation_id);
        return { status: "ok" };
      })(),
  );
}

function registerMemberTools(server: McpServer, context: McpToolContext): void {
  server.registerTool(
    "members_list",
    {
      description: "List organization members",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
        role: z.enum(memberRoles).optional(),
        q: z.string().min(1).max(200).optional(),
      },
    },
    (input) =>
      run(async () => {
        const where = {
          organizationId: context.orgId,
          ...(input.role ? { role: input.role } : {}),
          ...(input.q
            ? {
                user: {
                  OR: [
                    { email: { contains: input.q } },
                    { name: { contains: input.q } },
                  ],
                },
              }
            : {}),
        };
        const [rows, total, groupingRules] = await Promise.all([
          context.services.prisma.member.findMany({
            where,
            include: {
              user: { select: { id: true, email: true, name: true } },
            },
            orderBy: { createdAt: "asc" },
            take: input.limit,
            skip: input.offset,
          }),
          context.services.prisma.member.count({ where }),
          context.services.prisma.casbinRule.findMany({
            where: { orgId: context.orgId, ptype: "g" },
            select: { v0: true, v1: true },
          }),
        ]);
        const prefix = roleSubject(context.orgId, "");
        const rolesByUser = new Map<string, string[]>();
        for (const rule of groupingRules) {
          if (!rule.v0 || !rule.v1?.startsWith(prefix)) continue;
          const roles = rolesByUser.get(rule.v0) ?? [];
          roles.push(rule.v1.slice(prefix.length));
          rolesByUser.set(rule.v0, roles);
        }
        return {
          status: "ok",
          members: rows.map((member) => ({
            member_id: member.id,
            user_id: member.user.id,
            email: member.user.email,
            name: member.user.name,
            member_role: member.role,
            casbin_roles: rolesByUser.get(member.user.id) ?? [],
            joined_at: member.createdAt.toISOString(),
          })),
          total,
          limit: input.limit,
          offset: input.offset,
        };
      })(),
  );
  server.registerTool(
    "members_change_role",
    {
      description: "Change an organization member's role",
      inputSchema: {
        member_id: z.string().min(1),
        role: z.enum(memberRoles),
      },
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/members");
        const member = await context.services.prisma.member.findFirst({
          where: { id: input.member_id, organizationId: context.orgId },
          select: { id: true, userId: true, role: true },
        });
        if (!member) throw new ToolError("NotFound", "Member not found");
        await context.services.auth.api.updateMemberRole({
          body: {
            memberId: member.id,
            organizationId: context.orgId,
            role: input.role,
          },
          headers: await authHeaders(context),
        });
        await syncMemberRole(
          context.services.prisma,
          context.orgId,
          member.userId,
          member.role,
          input.role,
        );
        await audit(context, "update_member_role", "member", member.id, {
          user_id: member.userId,
          previous_role: member.role,
          role: input.role,
        });
        return { status: "ok", user_id: member.userId, role: input.role };
      })(),
  );
  server.registerTool(
    "members_remove",
    {
      description: "Remove a member from the organization",
      inputSchema: { member_id: z.string().min(1) },
    },
    ({ member_id }) =>
      run(async () => {
        await requirePermission(context, "/members");
        const member = await context.services.prisma.member.findFirst({
          where: { id: member_id, organizationId: context.orgId },
          select: { id: true, userId: true },
        });
        if (!member) throw new ToolError("NotFound", "Member not found");
        await context.services.auth.api.removeMember({
          body: {
            memberIdOrEmail: member.id,
            organizationId: context.orgId,
          },
          headers: await authHeaders(context),
        });
        await removeMemberAccess(
          context.services.prisma,
          context.orgId,
          member.userId,
        );
        await audit(context, "remove_member", "member", member.id, {
          user_id: member.userId,
        });
        return { status: "ok" };
      })(),
  );
}

export function registerAccessTools(
  server: McpServer,
  context: McpToolContext,
): void {
  registerPermissionTools(server, context);
  registerFilterTools(server, context);
  registerInvitationTools(server, context);
  registerMemberTools(server, context);
}
