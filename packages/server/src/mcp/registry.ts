import { API_VERSION } from "@lastsaas/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { McpToolContext } from "./context";
import { registerAccessTools } from "./tools/access";
import { registerDataTools } from "./tools/data";
import { registerOperationsTools } from "./tools/operations";

type ToolRegistrar = (server: McpServer, context: McpToolContext) => void;

const registerServerInfo: ToolRegistrar = (server, context) => {
  server.registerTool(
    "server_info",
    {
      description:
        "Return the Last SaaS API version and authenticated request identity.",
      outputSchema: {
        apiVersion: z.literal(API_VERSION),
        orgId: z.string(),
        userId: z.string(),
      },
    },
    async () => {
      const info = {
        apiVersion: API_VERSION,
        orgId: context.orgId,
        userId: context.userId,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(info) }],
        structuredContent: info,
      };
    },
  );
};

const toolRegistrars: readonly ToolRegistrar[] = [
  registerServerInfo,
  registerDataTools,
  registerAccessTools,
  registerOperationsTools,
];

export function registerTools(
  server: McpServer,
  context: McpToolContext,
): void {
  for (const registerTool of toolRegistrars) {
    registerTool(server, context);
  }
}
