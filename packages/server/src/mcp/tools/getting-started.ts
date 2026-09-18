import { getGettingStartedGuide } from "@lastsaas/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerGettingStarted(server: McpServer): void {
  server.registerTool(
    "getting_started",
    {
      description:
        "Read the basics of Last SaaS with a reading list example and optional steps for files, reminders, invitations, agent service accounts, and the audit log. Use when someone asks what Last SaaS does or wants help getting started.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{ type: "text", text: getGettingStartedGuide("mcp") }],
    }),
  );
}
