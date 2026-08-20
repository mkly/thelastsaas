import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../src/config";
import type { McpToolContext } from "../src/mcp/context";
import { registerOperationsTools } from "../src/mcp/tools/operations";
import type { AppServices } from "../src/services";

const EXPECTED_TOOLS = [
  "audit_log",
  "files_delete",
  "files_download",
  "files_get",
  "files_list",
  "files_upload",
  "notification_preferences_set",
  "notification_preferences_show",
  "notification_schedules_cancel",
  "notification_schedules_create_once",
  "notification_schedules_create_recurring",
  "notification_schedules_list",
  "notifications_delete",
  "notifications_list",
  "notifications_queue",
  "notifications_read",
  "notifications_unread",
  "org_export",
  "org_import",
  "stats",
] as const;

interface TestPair {
  client: Client;
  server: McpServer;
}

const pairs: TestPair[] = [];

afterEach(async () => {
  await Promise.all(
    pairs.splice(0).map(async ({ client, server }) => {
      await client.close();
      await server.close();
    }),
  );
});

function permissionRules(resources: readonly string[]) {
  const role = "org:org_1:user:test-role";
  return [
    { ptype: "g", v0: "user_1", v1: role, v2: null },
    ...resources.map((resource) => ({
      ptype: "p",
      v0: role,
      v1: resource,
      v2: "read",
    })),
  ];
}

function contextWith(
  options: {
    permissions?: readonly string[];
    maxUploadSize?: number;
    notifications?: unknown[];
    files?: unknown[];
    stats?: {
      collections: number;
      records: number;
      files: number;
      storageBytes: number;
    };
  } = {},
): McpToolContext {
  const stats = options.stats ?? {
    collections: 2,
    records: 3,
    files: 1,
    storageBytes: 12,
  };
  const prisma = {
    casbinRule: {
      findMany: async () => permissionRules(options.permissions ?? []),
    },
    file: {
      findMany: async () => options.files ?? [],
      count: async () => stats.files,
      aggregate: async () => ({ _sum: { sizeBytes: stats.storageBytes } }),
    },
    notification: {
      findMany: async () => options.notifications ?? [],
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
    collection: { count: async () => stats.collections },
    record: { count: async () => stats.records },
  };
  const services = {
    prisma,
    storage: {
      write: async () => undefined,
      read: async () => null,
      delete: async () => undefined,
    },
  } as unknown as AppServices;
  const config = loadConfig({
    PORT: "0",
    DATABASE_URL: "file::memory:",
    MAX_UPLOAD_SIZE: String(options.maxUploadSize ?? 1024),
  });
  return { services, config, orgId: "org_1", userId: "user_1" };
}

async function connect(context: McpToolContext): Promise<TestPair> {
  const server = new McpServer({ name: "operations-test", version: "1.0.0" });
  registerOperationsTools(server, context);
  const client = new Client({ name: "operations-client", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const pair = { client, server };
  pairs.push(pair);
  return pair;
}

function structured(result: unknown) {
  return (result as { structuredContent?: unknown })
    .structuredContent as Record<string, unknown>;
}

describe("MCP operations tools", () => {
  test("registers every files, notifications, schedules, preferences, and system tool", async () => {
    const { client } = await connect(contextWith());
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      ...EXPECTED_TOOLS,
    ]);
  });

  test("returns file-list data for an authorized caller", async () => {
    const file = {
      id: "file_1",
      orgId: "org_1",
      path: "reports/report.txt",
      filename: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      collectionId: null,
      recordId: null,
      uploadedBy: "user_1",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const { client } = await connect(
      contextWith({ permissions: ["/files"], files: [file] }),
    );
    const result = await client.callTool({
      name: "files_list",
      arguments: { prefix: "reports/" },
    });

    expect(result.isError).not.toBe(true);
    expect(structured(result)).toMatchObject({
      status: "ok",
      files: [{ id: "file_1", path: "reports/report.txt" }],
    });
  });

  test("returns a structured permission error for the files family", async () => {
    const { client } = await connect(contextWith());
    const result = await client.callTool({
      name: "files_list",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(structured(result)).toEqual({
      status: "error",
      error: "PermissionDenied",
      message: "User does not have read permission on /files",
    });
  });

  test("rejects oversized base64 upload content as a structured MCP error", async () => {
    const role = "org:org_1:user:test-role";
    const context = contextWith({ maxUploadSize: 2 });
    const prisma = context.services.prisma as unknown as {
      casbinRule: { findMany(): Promise<unknown[]> };
    };
    prisma.casbinRule.findMany = async () => [
      { ptype: "g", v0: "user_1", v1: role, v2: null },
      { ptype: "p", v0: role, v1: "/files", v2: "write" },
    ];
    const { client } = await connect(context);
    const result = await client.callTool({
      name: "files_upload",
      arguments: {
        filename: "too-large.txt",
        content_base64: Buffer.from("abc").toString("base64"),
      },
    });

    expect(result.isError).toBe(true);
    expect(structured(result)).toMatchObject({
      status: "error",
      error: "PayloadTooLarge",
      max_bytes: 2,
    });
  });

  test("lists personal notifications in-process without an HTTP endpoint", async () => {
    const notification = {
      id: "notification_1",
      type: "invitation",
      message: "You were invited",
      data: null,
      read: false,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    };
    const { client } = await connect(
      contextWith({ notifications: [notification] }),
    );
    const result = await client.callTool({
      name: "notifications_list",
      arguments: { unread: true },
    });

    expect(result.isError).not.toBe(true);
    expect(structured(result)).toMatchObject({
      status: "ok",
      notifications: [
        { id: "notification_1", message: "You were invited", read: false },
      ],
    });
  });

  test("returns a structured not-found error from a personal notification mutation", async () => {
    const { client } = await connect(contextWith());
    const result = await client.callTool({
      name: "notifications_read",
      arguments: { id: "missing" },
    });

    expect(result.isError).toBe(true);
    expect(structured(result)).toEqual({
      status: "error",
      error: "NotFound",
      message: "Notification not found",
    });
  });

  test("returns organization stats for an authorized caller", async () => {
    const { client } = await connect(
      contextWith({ permissions: ["/system/stats"] }),
    );
    const result = await client.callTool({ name: "stats" });

    expect(result.isError).not.toBe(true);
    expect(structured(result)).toEqual({
      status: "ok",
      collections: 2,
      records: 3,
      files: 1,
      storage_bytes: 12,
    });
  });

  test("returns a structured permission error for the system family", async () => {
    const { client } = await connect(contextWith());
    const result = await client.callTool({ name: "stats" });

    expect(result.isError).toBe(true);
    expect(structured(result)).toEqual({
      status: "error",
      error: "PermissionDenied",
      message: "User does not have read permission on /system/stats",
    });
  });
});
