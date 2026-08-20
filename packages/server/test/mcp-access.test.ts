import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, type AppConfig } from "../src/config";
import { roleSubject } from "../src/db/casbin";
import { registerAccessTools } from "../src/mcp/tools/access";
import {
  closeServices,
  createServices,
  type AppServices,
} from "../src/services";

const toolNames = [
  "permissions_list",
  "permissions_grant",
  "permissions_revoke",
  "permissions_assign_role",
  "permissions_unassign_role",
  "permissions_check",
  "row_filter_set",
  "row_filter_list",
  "row_filter_delete",
  "field_filter_set",
  "field_filter_list",
  "field_filter_delete",
  "invitations_create",
  "invitations_list",
  "invitations_accept",
  "invitations_cancel",
  "members_list",
  "members_change_role",
  "members_remove",
] as const;
const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260819015000_init/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

async function connect(
  services: AppServices,
  config: AppConfig,
  userId: string,
) {
  const server = new McpServer({ name: "access-test", version: "1.0.0" });
  registerAccessTools(server, {
    services,
    config,
    orgId: "org_test",
    userId,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "access-test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

describe("MCP access tools", () => {
  let config: AppConfig;
  let services: AppServices;
  let directory: string;
  const connections: Array<{ close(): Promise<void> }> = [];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "lastsaas-mcp-access-"));
    config = loadConfig({
      PORT: "0",
      DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
    });
    services = await createServices(config);
    services.database!.exec(migration);
    await services.prisma.user.createMany({
      data: [
        {
          id: "user_admin",
          email: "admin@example.com",
          name: "Admin",
          emailVerified: true,
        },
        {
          id: "user_reader",
          email: "reader@example.com",
          name: "Reader",
          emailVerified: true,
        },
      ],
    });
    await services.prisma.organization.create({
      data: { id: "org_test", name: "Test Org", slug: "test-org" },
    });
    await services.prisma.member.createMany({
      data: [
        {
          id: "member_admin",
          organizationId: "org_test",
          userId: "user_admin",
          role: "admin",
        },
        {
          id: "member_reader",
          organizationId: "org_test",
          userId: "user_reader",
          role: "member",
        },
      ],
    });
    await services.prisma.session.create({
      data: {
        id: "session_admin",
        userId: "user_admin",
        token: "admin-token",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await services.prisma.casbinRule.createMany({
      data: [
        {
          orgId: "org_test",
          ptype: "p",
          v0: roleSubject("org_test", "admin"),
          v1: "/*",
          v2: "*",
        },
        {
          orgId: "org_test",
          ptype: "g",
          v0: "user_admin",
          v1: roleSubject("org_test", "admin"),
          v2: null,
        },
      ],
    });
    await services.prisma.collection.create({
      data: {
        id: "collection_tasks",
        orgId: "org_test",
        name: "tasks",
        schema: { title: "string" },
      },
    });
  });

  afterEach(async () => {
    await Promise.all(connections.splice(0).map(({ close }) => close()));
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });

  async function clientFor(userId: string) {
    const connection = await connect(services, config, userId);
    connections.push(connection);
    return connection.client;
  }

  test("registers the complete CLI-parity access tool surface", async () => {
    const client = await clientFor("user_admin");
    const result = await client.listTools();
    expect(result.tools.map(({ name }) => name).sort()).toEqual(
      [...toolNames].sort(),
    );
  });

  test("permissions tools return success and structured permission errors", async () => {
    const admin = await clientFor("user_admin");
    const reader = await clientFor("user_reader");

    const listed = await admin.callTool({
      name: "permissions_list",
      arguments: {},
    });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      status: "ok",
      role_assignments: [{ user_id: "user_admin", role: "admin" }],
    });

    const denied = await reader.callTool({
      name: "permissions_list",
      arguments: {},
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toEqual({
      error: {
        code: "PermissionDenied",
        message: "User does not have manage permission on /permissions",
      },
    });
  });

  test("filter tools return success and structured permission errors", async () => {
    const admin = await clientFor("user_admin");
    const reader = await clientFor("user_reader");

    const created = await admin.callTool({
      name: "row_filter_set",
      arguments: {
        collection: "tasks",
        role: "member",
        action: "read",
        condition: {},
      },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({ status: "ok" });

    const denied = await reader.callTool({
      name: "row_filter_list",
      arguments: {},
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      error: { code: "PermissionDenied" },
    });
  });

  test("invitation tools return success and structured permission errors", async () => {
    const admin = await clientFor("user_admin");
    const reader = await clientFor("user_reader");

    const created = await admin.callTool({
      name: "invitations_create",
      arguments: { email: "invitee@example.com", role: "member" },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({
      status: "ok",
      email: "invitee@example.com",
      role: "member",
    });

    const denied = await reader.callTool({
      name: "invitations_list",
      arguments: {},
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      error: { code: "PermissionDenied" },
    });
  });

  test("member tools preserve open listing and protect mutations", async () => {
    const reader = await clientFor("user_reader");
    const listed = await reader.callTool({
      name: "members_list",
      arguments: {},
    });
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      status: "ok",
      total: 2,
    });

    const denied = await reader.callTool({
      name: "members_change_role",
      arguments: { member_id: "member_reader", role: "admin" },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      error: { code: "PermissionDenied" },
    });
  });
});
