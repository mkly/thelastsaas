import { requireMcpAuth } from "@better-auth/mcp";
import { StreamableHTTPTransport } from "@hono/mcp";
import { API_VERSION } from "@lastsaas/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono, type Context } from "hono";

import { MCP_ACCOUNT_CLAIM, MCP_TOOLS_SCOPE, mcpResourceUrl } from "../auth";
import type { AppEnvironment } from "../env";
import {
  resolveMcpApiKeyPrincipal,
  resolveActiveOrganization,
} from "../mcp/context";
import { registerTools } from "../mcp/registry";

function mcpAuthError(
  context: Context<AppEnvironment>,
  message: string,
  code = -32001,
) {
  return context.json(
    {
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    },
    403,
  );
}

async function handleAuthenticatedMcpRequest(
  context: Context<AppEnvironment>,
  orgId: string,
  userId: string,
): Promise<Response> {
  const membership = await context.get("services").prisma.member.findUnique({
    where: {
      organizationId_userId: { organizationId: orgId, userId },
    },
    select: { id: true },
  });
  if (!membership) {
    return mcpAuthError(context, "Organization membership is required", -32003);
  }
  return handleMcpRequest(context, orgId, userId);
}

async function handleMcpRequest(
  context: Context<AppEnvironment>,
  orgId: string | null,
  userId: string,
  clientId?: string,
): Promise<Response> {
  const server = new McpServer({ name: "lastsaas", version: API_VERSION });
  const transport = new StreamableHTTPTransport({
    enableJsonResponse: true,
    sessionIdGenerator: undefined,
  });

  registerTools(server, {
    services: context.get("services"),
    config: context.get("config"),
    orgId,
    userId,
    clientId,
  });

  await server.connect(transport);
  try {
    return (await transport.handleRequest(context)) ?? context.body(null, 204);
  } finally {
    await server.close();
  }
}

export const mcpRouter = new Hono<AppEnvironment>().post(
  "/",
  async (context) => {
    const services = context.get("services");
    const apiKeyPrincipal = await resolveMcpApiKeyPrincipal(
      services,
      context.req.raw,
    );
    if (apiKeyPrincipal) {
      return handleAuthenticatedMcpRequest(
        context,
        apiKeyPrincipal.orgId,
        apiKeyPrincipal.userId,
      );
    }

    const protectedHandler = requireMcpAuth(
      services.auth,
      async (_request, claims) => {
        const userId = claims.sub;
        const clientId = claims.client_id;
        if (
          typeof userId !== "string" ||
          typeof clientId !== "string" ||
          claims[MCP_ACCOUNT_CLAIM] !== true
        ) {
          return mcpAuthError(
            context,
            "Reconnect your MCP client to authorize account access",
          );
        }
        const user = await services.prisma.user.findUnique({
          where: { id: userId },
          select: { kind: true },
        });
        if (!user || user.kind !== "human")
          return mcpAuthError(
            context,
            "Account access requires a user account",
          );
        const orgId = await resolveActiveOrganization(
          services,
          userId,
          clientId,
        );
        return handleMcpRequest(context, orgId, userId, clientId);
      },
      {
        resource: mcpResourceUrl(context.get("config")),
        requiredScopes: [MCP_TOOLS_SCOPE],
      },
    );

    return protectedHandler(context.req.raw);
  },
);
