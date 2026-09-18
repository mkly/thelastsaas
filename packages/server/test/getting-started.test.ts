import { expect, test } from "bun:test";
import { getGettingStartedGuide } from "@lastsaas/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGettingStarted } from "../src/mcp/tools/getting-started";

test("MCP serves the shared tutorial with MCP-specific organization setup", async () => {
  const server = new McpServer({ name: "tutorial-test", version: "1" });
  const client = new Client({ name: "tutorial-test", version: "1" });
  registerGettingStarted(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "getting_started",
      arguments: {},
    });
    expect(response.isError).not.toBe(true);
    expect(response.content).toEqual([
      { type: "text", text: getGettingStartedGuide("mcp") },
    ]);
    const guide = getGettingStartedGuide("mcp");
    expect(guide).toContain("organizations_create");
    expect(guide).not.toContain("saas orgs");
  } finally {
    await client.close();
    await server.close();
  }
});
