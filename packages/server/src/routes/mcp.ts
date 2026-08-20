import { requireMcpAuth } from "@better-auth/mcp";
import { StreamableHTTPTransport } from "@hono/mcp";
import { API_VERSION } from "@lastsaas/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono, type Context } from "hono";

import {
  MCP_ORGANIZATION_CLAIM,
  MCP_TOOLS_SCOPE,
  mcpResourceUrl,
} from "../auth";
import type { AppEnvironment } from "../env";
import { registerTools } from "../mcp/registry";

async function handleMcpRequest(
  context: Context<AppEnvironment>,
  orgId: string,
  userId: string,
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
    const { auth, prisma } = context.get("services");
    const protectedHandler = requireMcpAuth(
      auth,
      async (_request, claims) => {
        const userId = claims.sub;
        const orgId = claims[MCP_ORGANIZATION_CLAIM];
        if (typeof userId !== "string" || typeof orgId !== "string") {
          return context.json(
            {
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message: "The access token is missing its organization grant",
              },
              id: null,
            },
            403,
          );
        }

        const membership = await prisma.member.findUnique({
          where: {
            organizationId_userId: { organizationId: orgId, userId },
          },
          select: { id: true },
        });
        if (!membership) {
          return context.json(
            {
              jsonrpc: "2.0",
              error: {
                code: -32003,
                message: "Organization membership is required",
              },
              id: null,
            },
            403,
          );
        }
        return handleMcpRequest(context, orgId, userId);
      },
      {
        resource: mcpResourceUrl(context.get("config")),
        requiredScopes: [MCP_TOOLS_SCOPE],
      },
    );

    return protectedHandler(context.req.raw);
  },
);
