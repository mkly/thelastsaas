import { invitationPermissionsSchema } from "../../invitation-permissions";
import { LastSaasError } from "@lastsaas/shared";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

import { addAuditLog } from "../../db/audit";
import { log } from "../../logger";
import {
  addPolicy,
  assignRole,
  hasPermission,
  checkPermission,
  removeMemberAccess,
  removePolicy,
  roleSubject,
  syncMemberRole,
  unassignRole,
} from "../../db/casbin";
import { createServiceAccountSchema } from "../../db/service-accounts";
import { issueServiceAccountTokenClaim } from "../../service-account-tokens";
import { requireOrganization, type McpToolContext } from "../context";

import { policyOptionsSchema } from "../../db/policy-options";

const policyActions = [
  "read",
  "create",
  "update",
  "write",
  "delete",
  "manage",
  "*",
] as const;
const memberRoles = ["admin", "member"] as const;
const roleName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function toolResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function success(data: Record<string, unknown>): CallToolResult {
  return toolResult(data);
}

function failure(error: unknown): CallToolResult {
  let code: string;
  let message: string;
  if (error instanceof ToolError || error instanceof LastSaasError) {
    code = error.code;
    message = error.message;
  } else {
    // Route handlers surface an unexpected fault as a bare 500; mirror that
    // here rather than echoing internal error text back to the MCP client.
    log.error("mcp", "access tool execution failed", error);
    code = "InternalError";
    message = "Tool execution failed";
  }
  return {
    ...toolResult({ status: "error", error: code, message }),
    isError: true,
  };
}

// The members/invitations routes translate a better-auth API rejection into a
// 400 InvalidRequest carrying its message; keep the same contract for tools.
async function callAuthApi<T>(
  operation: () => Promise<T>,
  fallback: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ToolError(
      "InvalidRequest",
      error instanceof Error ? error.message : fallback,
    );
  }
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
      requireOrganization(context),
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
    requireOrganization(context),
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
        organizationId: requireOrganization(context),
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
    return roleSubject(requireOrganization(context), role);
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
          where: {
            orgId: requireOrganization(context),
            ptype: { in: ["p", "g"] },
          },
          orderBy: { id: "asc" },
          select: {
            ptype: true,
            v0: true,
            v1: true,
            v2: true,
            v3: true,
            v4: true,
          },
        }),
        prisma.member.findMany({
          where: { organizationId: requireOrganization(context) },
          select: { userId: true },
        }),
      ]);
      const memberIds = new Set(members.map(({ userId }) => userId));
      const rolePrefix = roleSubject(requireOrganization(context), "");
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
            subject: contractSubject(rule.v0!, requireOrganization(context)),
            resource: rule.v1!,
            action: rule.v2!,
            cond: rule.v3!,
            msg: rule.v4!,
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
    ...policyOptionsSchema,
  };
  server.registerTool(
    "permissions_grant",
    {
      description:
        "Grant a resource/action with an optional Casbin condition and denial message. Fields use /collections/<name>/fields/<field> policies.",
      inputSchema: policySchema,
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        const subject = await expandSubject(input.subject, context);
        if (
          !(await addPolicy(
            context.services.prisma,
            requireOrganization(context),
            subject,
            input.resource,
            input.action,
            { cond: input.cond, msg: input.msg },
          ))
        ) {
          throw new ToolError("Conflict", "Policy already exists");
        }
        await audit(
          context,
          "add_policy",
          "permission",
          null,
          JSON.parse(JSON.stringify(input)),
        );
        return { status: "ok", ...input };
      })(),
  );
  server.registerTool(
    "permissions_revoke",
    {
      description:
        "Remove the exact policy, including its condition and message.",
      inputSchema: policySchema,
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/permissions");
        const subject = await expandSubject(input.subject, context);
        if (
          !(await removePolicy(
            context.services.prisma,
            requireOrganization(context),
            subject,
            input.resource,
            input.action,
            { cond: input.cond, msg: input.msg },
          ))
        ) {
          throw new ToolError("NotFound", "Policy not found");
        }
        await audit(
          context,
          "remove_policy",
          "permission",
          null,
          JSON.parse(JSON.stringify(input)),
        );
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
            requireOrganization(context),
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
            requireOrganization(context),
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
      description:
        "Check resource-level permission. conditional: true means row/field conditions still apply; this is not authorization for a particular record.",
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
          ...(await checkPermission(
            context.services.prisma,
            requireOrganization(context),
            userId,
            input.resource,
            input.action,
          )),
          user_id: userId,
          resource: input.resource,
          action: input.action,
        };
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
      description:
        "Invite a user with optional permissions, applied automatically when they accept. Members have no collection access by default.",
      inputSchema: {
        email: z.string().email(),
        permissions: invitationPermissionsSchema.optional(),
        role: z.enum(memberRoles).default("member"),
      },
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/members");
        const headers = await authHeaders(context);
        const invitation = await callAuthApi(
          () =>
            context.services.auth.api.createInvitation({
              body: {
                ...input,
                permissions: JSON.stringify(input.permissions ?? []),
                organizationId: requireOrganization(context),
              },
              headers,
            }),
          "Failed to create invitation",
        );
        await audit(context, "create_invitation", "invitation", invitation.id, {
          email: input.email,
          role: input.role,
          permissions: JSON.stringify(input.permissions ?? []),
        });
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
        where: {
          organizationId: requireOrganization(context),
          status: "pending",
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          email: true,
          role: true,
          permissions: true,
          status: true,
          expiresAt: true,
          createdAt: true,
        },
      });
      return {
        status: "ok",
        invitations: invitations.map((invitation) => ({
          ...invitation,
          permissions: JSON.parse(invitation.permissions),
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
        "Accept an invitation for the active organization (requires existing membership)",
      inputSchema: { invitation_id: z.string().min(1) },
    },
    ({ invitation_id }) =>
      run(async () => {
        // The active organization has already passed a membership check.
        // This tool only accepts invitations for that organization.
        const invitation = await context.services.prisma.invitation.findUnique({
          where: { id: invitation_id },
          select: { organizationId: true, status: true },
        });
        if (
          !invitation ||
          invitation.organizationId !== requireOrganization(context) ||
          invitation.status !== "pending"
        ) {
          throw new ToolError("NotFound", "Invitation not found");
        }
        const headers = await authHeaders(context);
        await callAuthApi(
          () =>
            context.services.auth.api.acceptInvitation({
              body: { invitationId: invitation_id },
              headers,
            }),
          "Failed to accept invitation",
        );
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
          invitation.organizationId !== requireOrganization(context) ||
          invitation.status !== "pending"
        ) {
          throw new ToolError("NotFound", "Invitation not found");
        }
        const headers = await authHeaders(context);
        await callAuthApi(
          () =>
            context.services.auth.api.cancelInvitation({
              body: { invitationId: invitation_id },
              headers,
            }),
          "Failed to cancel invitation",
        );
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
          organizationId: requireOrganization(context),
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
              user: {
                select: { id: true, email: true, name: true, kind: true },
              },
            },
            orderBy: { createdAt: "asc" },
            take: input.limit,
            skip: input.offset,
          }),
          context.services.prisma.member.count({ where }),
          context.services.prisma.casbinRule.findMany({
            where: { orgId: requireOrganization(context), ptype: "g" },
            select: { v0: true, v1: true },
          }),
        ]);
        const prefix = roleSubject(requireOrganization(context), "");
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
            kind: member.user.kind,
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
          where: {
            id: input.member_id,
            organizationId: requireOrganization(context),
          },
          select: { id: true, userId: true, role: true },
        });
        if (!member) throw new ToolError("NotFound", "Member not found");
        const headers = await authHeaders(context);
        await callAuthApi(
          () =>
            context.services.auth.api.updateMemberRole({
              body: {
                memberId: member.id,
                organizationId: requireOrganization(context),
                role: input.role,
              },
              headers,
            }),
          "Failed to update member role",
        );
        await syncMemberRole(
          context.services.prisma,
          requireOrganization(context),
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
          where: {
            id: member_id,
            organizationId: requireOrganization(context),
          },
          select: { id: true, userId: true },
        });
        if (!member) throw new ToolError("NotFound", "Member not found");
        const headers = await authHeaders(context);
        await callAuthApi(
          () =>
            context.services.auth.api.removeMember({
              body: {
                memberIdOrEmail: member.id,
                organizationId: requireOrganization(context),
              },
              headers,
            }),
          "Failed to remove member",
        );
        await removeMemberAccess(
          context.services.prisma,
          requireOrganization(context),
          member.userId,
        );
        await audit(context, "remove_member", "member", member.id, {
          user_id: member.userId,
        });
        return { status: "ok" };
      })(),
  );
}

function registerServiceAccountTools(
  server: McpServer,
  context: McpToolContext,
): void {
  server.registerTool(
    "service_accounts_create",
    {
      description:
        "Create a service account and return a short-lived, one-time token claim URL",
      inputSchema: createServiceAccountSchema.shape,
    },
    (input) =>
      run(async () => {
        await requirePermission(context, "/members");
        const issued = await issueServiceAccountTokenClaim(
          context.services,
          context.config,
          requireOrganization(context),
          input,
        );
        await audit(
          context,
          "create_service_account",
          "service_account",
          issued.serviceAccount.user.id,
          {
            role: issued.serviceAccount.member.role,
            api_key_id: issued.apiKeyId,
          },
        );
        return {
          status: "ok",
          service_account_id: issued.serviceAccount.user.id,
          member_id: issued.serviceAccount.member.id,
          role: issued.serviceAccount.member.role,
          claim_url: issued.claimUrl,
          claim_expires_at: issued.expiresAt.toISOString(),
        };
      })(),
  );
}

export function registerAccessTools(
  server: McpServer,
  context: McpToolContext,
): void {
  registerPermissionTools(server, context);
  registerInvitationTools(server, context);
  registerMemberTools(server, context);
  registerServiceAccountTools(server, context);
}
