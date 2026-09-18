import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  createOrganizationForUser,
  createOrganizationSchema,
  OrganizationSlugExistsError,
} from "../../organizations";
import type { McpToolContext } from "../context";

function result(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

export function registerOrganizationTools(
  server: McpServer,
  context: McpToolContext,
): void {
  server.registerTool(
    "organizations_list",
    {
      description:
        "List your organizations and the active organization. A sole organization is selected automatically. Selection is shared by conversations in this MCP client.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const memberships = await context.services.prisma.member.findMany({
        where: {
          userId: context.userId,
          ...(!context.clientId ? { organizationId: context.orgId ?? "" } : {}),
        },
        orderBy: { createdAt: "asc" },
        select: {
          role: true,
          organization: { select: { id: true, name: true, slug: true } },
        },
      });
      return result({
        organizations: memberships.map(({ role, organization }) => ({
          ...organization,
          role,
        })),
        activeOrganizationId: context.orgId,
      });
    },
  );

  async function select(orgId: string) {
    await context.services.prisma.mcpOrganization.upsert({
      where: {
        userId_clientId: {
          userId: context.userId,
          clientId: context.clientId!,
        },
      },
      create: { userId: context.userId, clientId: context.clientId!, orgId },
      update: { orgId },
    });
    context.orgId = orgId;
  }
  const restricted = () =>
    result(
      {
        error: "PermissionDenied",
        message:
          "This API key is restricted to its organization. Connect using account OAuth to create or switch organizations.",
      },
      true,
    );

  server.registerTool(
    "organizations_select",
    {
      description:
        "Select the active organization for subsequent calls from this MCP client, including its other conversations. You must be a member.",
      inputSchema: z.object({ organizationId: z.string().min(1) }).strict(),
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async ({ organizationId }) => {
      if (!context.clientId) return restricted();
      const member = await context.services.prisma.member.findUnique({
        where: {
          organizationId_userId: { organizationId, userId: context.userId },
        },
      });
      if (!member)
        return result(
          {
            error: "PermissionDenied",
            message: "You are not a member of that organization.",
          },
          true,
        );
      await select(organizationId);
      return result({ activeOrganizationId: organizationId });
    },
  );

  server.registerTool(
    "organizations_create",
    {
      description:
        "Create an organization and select it for subsequent calls from this MCP client. Ask the user for a name before creating it.",
      inputSchema: createOrganizationSchema,
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      if (!context.clientId) return restricted();
      try {
        const organization = await createOrganizationForUser(
          context.services,
          context.userId,
          input,
        );
        await select(organization.id);
        return result({
          organization: {
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
          },
          activeOrganizationId: organization.id,
        });
      } catch (error) {
        if (error instanceof OrganizationSlugExistsError)
          return result(
            { error: "OrganizationSlugExists", message: error.message },
            true,
          );
        throw error;
      }
    },
  );
}
