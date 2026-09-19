import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "../src/mcp/context";
import { registerTools } from "../src/mcp/registry";
import { buildInfo } from "../src/build-info";

// Advertised tool schemas are serialized into every MCP client's model
// context, so an oversized schema breaks clients before any call is made
// (a hand-unrolled recursive schema once ballooned row_filter_set to ~10MB).
const MAX_SCHEMA_CHARS = 10_000;

describe("MCP tool schema size", () => {
  test("every advertised input schema stays small", async () => {
    const server = new McpServer({ name: "schema-size", version: "1.0.0" });
    // Listing schemas and reading server_info require no backing services.
    registerTools(server, {
      orgId: null,
      userId: "build-info-test",
    } as McpToolContext);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "schema-size-client", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        const size = JSON.stringify(tool.inputSchema ?? {}).length;
        expect(size, `${tool.name} input schema is ${size} chars`).toBeLessThan(
          MAX_SCHEMA_CHARS,
        );
      }
      const info = await client.callTool({
        name: "server_info",
        arguments: {},
      });
      expect(info.isError).not.toBe(true);
      expect(info.structuredContent).toEqual({
        apiVersion: "v1",
        orgId: null,
        userId: "build-info-test",
        ...buildInfo,
      });
      expect(buildInfo.commit).toBeNull();
      expect(buildInfo.builtAt).toBeNull();
      expect(Date.parse(buildInfo.startedAt)).toBeLessThanOrEqual(Date.now());
      const again = await client.callTool({
        name: "server_info",
        arguments: {},
      });
      expect(again.structuredContent).toEqual(info.structuredContent);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
