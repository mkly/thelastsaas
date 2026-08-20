import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../src/config";
import type { McpToolContext } from "../src/mcp/context";
import { registerDataTools } from "../src/mcp/tools/data";
import { closeServices, createServices } from "../src/services";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260819015000_init/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-mcp-data-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
  });
  const services = await createServices(config);
  if (!services.database) throw new Error("Expected SQLite database handle");
  services.database.exec(migration);

  await services.prisma.user.createMany({
    data: [
      { id: "user_admin", email: "admin@example.com", name: "Admin" },
      { id: "user_reader", email: "reader@example.com", name: "Reader" },
      { id: "user_denied", email: "denied@example.com", name: "Denied" },
      { id: "user_other", email: "other@example.com", name: "Other" },
    ],
  });
  await services.prisma.organization.create({
    data: { id: "org_test", name: "Test Org", slug: "test-org" },
  });
  await services.prisma.collection.create({
    data: {
      id: "collection_entries",
      orgId: "org_test",
      name: "entries",
      description: "Filtered entries",
      schema: { title: "string", secret: "string" },
    },
  });
  await services.prisma.casbinRule.createMany({
    data: [
      {
        orgId: "org_test",
        ptype: "p",
        v0: "org:org_test:user:admin",
        v1: "/*",
        v2: "*",
      },
      {
        orgId: "org_test",
        ptype: "g",
        v0: "user_admin",
        v1: "org:org_test:user:admin",
      },
      {
        orgId: "org_test",
        ptype: "p",
        v0: "org:org_test:user:reader",
        v1: "/collections/entries",
        v2: "read",
      },
      {
        orgId: "org_test",
        ptype: "g",
        v0: "user_reader",
        v1: "org:org_test:user:reader",
      },
    ],
  });
  await services.prisma.rowFilter.create({
    data: {
      id: "row_filter_reader",
      orgId: "org_test",
      collectionId: "collection_entries",
      role: "reader",
      action: "read",
      condition: { created_by: "$user.id" },
    },
  });
  await services.prisma.fieldFilter.create({
    data: {
      id: "field_filter_reader",
      orgId: "org_test",
      collectionId: "collection_entries",
      role: "reader",
      action: "read",
      readableFields: ["title"],
      writableFields: [],
    },
  });
  const now = new Date();
  await services.prisma.record.createMany({
    data: [
      {
        id: "record_own",
        orgId: "org_test",
        collectionId: "collection_entries",
        data: { title: "Visible", secret: "hidden" },
        createdBy: "user_reader",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "record_other",
        orgId: "org_test",
        collectionId: "collection_entries",
        data: { title: "Other", secret: "also hidden" },
        createdBy: "user_other",
        createdAt: now,
        updatedAt: now,
      },
    ],
  });

  const connections: Array<{ client: Client; server: McpServer }> = [];
  cleanups.push(async () => {
    for (const { client, server } of connections) {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });

  async function createClient(userId: string): Promise<Client> {
    const context: McpToolContext = {
      services,
      config,
      orgId: "org_test",
      userId,
    };
    const server = new McpServer({ name: "lastsaas-test", version: "1" });
    registerDataTools(server, context);
    const client = new Client({ name: "lastsaas-test-client", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connections.push({ client, server });
    return client;
  }

  return { createClient };
}

function resultShape(result: unknown): {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
} {
  return result as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
}

describe("MCP data tools", () => {
  test("registers every collection and record command", async () => {
    const { createClient } = await createHarness();
    const client = await createClient("user_admin");

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name).sort()).toEqual([
      "collections_create",
      "collections_delete",
      "collections_describe",
      "collections_list",
      "collections_update_schema",
      "records_aggregate",
      "records_batch",
      "records_count",
      "records_delete",
      "records_get",
      "records_insert",
      "records_query",
      "records_update",
    ]);
  });

  test("returns collection successes and permission failures as MCP results", async () => {
    const { createClient } = await createHarness();
    const admin = await createClient("user_admin");
    const denied = await createClient("user_denied");

    const visible = resultShape(
      await admin.callTool({ name: "collections_list", arguments: {} }),
    );
    expect(visible.isError).toBeUndefined();
    expect(visible.structuredContent).toMatchObject({
      status: "ok",
      collections: [{ name: "entries", description: "Filtered entries" }],
    });

    const forbidden = resultShape(
      await denied.callTool({
        name: "collections_create",
        arguments: { name: "blocked", schema: { title: "string" } },
      }),
    );
    expect(forbidden.isError).toBe(true);
    expect(forbidden.structuredContent).toEqual({
      status: "error",
      error: "PermissionDenied",
      message: "User does not have write permission on /collections",
    });
  });

  test("applies row and field filters and returns record permission failures", async () => {
    const { createClient } = await createHarness();
    const reader = await createClient("user_reader");
    const denied = await createClient("user_denied");

    const query = resultShape(
      await reader.callTool({
        name: "records_query",
        arguments: { collection: "entries" },
      }),
    );
    expect(query.isError).toBeUndefined();
    expect(query.structuredContent).toMatchObject({
      status: "ok",
      total: 1,
      records: [
        {
          id: "record_own",
          created_by: "user_reader",
          data: { title: "Visible" },
        },
      ],
    });

    const forbidden = resultShape(
      await denied.callTool({
        name: "records_get",
        arguments: { collection: "entries", id: "record_own" },
      }),
    );
    expect(forbidden.isError).toBe(true);
    expect(forbidden.structuredContent).toEqual({
      status: "error",
      error: "PermissionDenied",
      message: "User does not have read permission on /collections/entries",
    });
  });
});
