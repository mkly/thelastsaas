import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "./context";

type ToolRegistrar = (server: McpServer, context: McpToolContext) => void;

const toolRegistrars: readonly ToolRegistrar[] = [];

export function registerTools(
  server: McpServer,
  context: McpToolContext,
): void {
  for (const registerTool of toolRegistrars) {
    registerTool(server, context);
  }
}
