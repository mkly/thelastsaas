import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpToolContext } from "../src/mcp/context";
import { registerTools } from "../src/mcp/registry";

// Advertised tool schemas are serialized into every MCP client's model
// context, so an oversized schema breaks clients before any call is made
// (a hand-unrolled recursive schema once ballooned row_filter_set to ~10MB).
const MAX_SCHEMA_CHARS = 10_000;

describe("MCP tool schema size", () => {
  test("every advertised input schema stays small", async () => {
    const server = new McpServer({ name: "schema-size", version: "1.0.0" });
    // Handlers are never invoked by tools/list, so a stub context suffices.
    registerTools(server, {} as McpToolContext);
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
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });
});
