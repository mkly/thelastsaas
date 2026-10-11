import { API_VERSION } from "@lastsaas/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildInfo } from "../build-info";

import type { McpToolContext } from "./context";
import { registerAccessTools } from "./tools/access";
import { registerDataTools } from "./tools/data";
import { registerGettingStarted } from "./tools/getting-started";
import { registerOrganizationTools } from "./tools/organizations";
import { registerOperationsTools } from "./tools/operations";
import { registerQueueDeliveryTools } from "./tools/queue-deliveries";
import { registerQueueTools } from "./tools/queues";
import { registerSecretTools } from "./tools/secrets";
import { registerTransactionTools } from "./tools/transactions";
import { registerScheduleTools } from "./tools/schedules";
import { registerTriggerTools } from "./tools/triggers";

type ToolRegistrar = (server: McpServer, context: McpToolContext) => void;

const registerServerInfo: ToolRegistrar = (server, context) => {
  server.registerTool(
    "server_info",
    {
      description:
        "Return the Last SaaS server, bundled CLI, and API versions, build commit, build and process start times, and authenticated request identity. Use this to identify the deployed server revision.",
      outputSchema: {
        version: z.literal(buildInfo.version),
        bundledCliVersion: z.literal(buildInfo.bundledCliVersion),
        apiVersion: z.literal(API_VERSION),
        commit: z.string().nullable(),
        builtAt: z.string().nullable(),
        startedAt: z.string(),
        orgId: z.string().nullable(),
        userId: z.string(),
      },
    },
    async () => {
      const info = {
        apiVersion: API_VERSION,
        ...buildInfo,
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
  registerGettingStarted,
  registerOrganizationTools,
  registerServerInfo,
  registerDataTools,
  registerAccessTools,
  registerOperationsTools,
  registerSecretTools,
  registerQueueTools,
  registerQueueDeliveryTools,
  registerTransactionTools,
  registerTriggerTools,
  registerScheduleTools,
];

export function registerTools(
  server: McpServer,
  context: McpToolContext,
): void {
  for (const registerTool of toolRegistrars) {
    registerTool(server, context);
  }
}
