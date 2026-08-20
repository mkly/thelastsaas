import { StreamableHTTPTransport } from "@hono/mcp";
import { API_VERSION } from "@lastsaas/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";

import type { AppEnvironment } from "../env";
import { registerTools } from "../mcp/registry";

export const mcpRouter = new Hono<AppEnvironment>().post(
  "/",
  async (context) => {
    const server = new McpServer({ name: "lastsaas", version: API_VERSION });
    const transport = new StreamableHTTPTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined,
    });

    registerTools(server, {
      services: context.get("services"),
      config: context.get("config"),
      orgId: context.get("orgId"),
      userId: context.get("userId"),
    });

    await server.connect(transport);
    try {
      return (
        (await transport.handleRequest(context)) ?? context.body(null, 204)
      );
    } finally {
      await server.close();
    }
  },
);
