import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { closeServices, createServices } from "../src/services";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260819015000_init/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const protocolVersion = "2025-11-25";
const cleanups: Array<() => Promise<void>> = [];

const expectedTools = [
  "audit_log",
  "collections_create",
  "collections_delete",
  "collections_describe",
  "collections_list",
  "collections_update_schema",
  "field_filter_delete",
  "field_filter_list",
  "field_filter_set",
  "files_delete",
  "files_download",
  "files_get",
  "files_list",
  "files_upload",
  "invitations_accept",
  "invitations_cancel",
  "invitations_create",
  "invitations_list",
  "members_change_role",
  "members_list",
  "members_remove",
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
  "permissions_assign_role",
  "permissions_check",
  "permissions_grant",
  "permissions_list",
  "permissions_revoke",
  "permissions_unassign_role",
  "records_aggregate",
  "records_batch",
  "records_count",
  "records_delete",
  "records_get",
  "records_insert",
  "records_query",
  "records_update",
  "row_filter_delete",
  "row_filter_list",
  "row_filter_set",
  "server_info",
  "stats",
] as const;

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-mcp-e2e-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
    STORAGE_PATH: join(directory, "storage"),
  });
  const services = await createServices(config);
  if (!services.database) throw new Error("Expected SQLite database handle");
  services.database.exec(migration);
  const app = createApp({ config, services });
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });

  const signUp = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "mcp-admin@example.com",
      name: "MCP Admin",
      password: "mcp-e2e-password",
    }),
  });
  expect(signUp.status).toBe(200);
  const token = signUp.headers.get("set-auth-token");
  if (!token) throw new Error("Sign-up did not return a bearer token");

  const organization = await app.request("/v1/orgs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "MCP E2E Org", slug: "mcp-e2e-org" }),
  });
  expect(organization.status).toBe(201);
  const organizationBody = (await organization.json()) as {
    organization: { id: string };
  };
  const user = await services.prisma.user.findUnique({
    where: { email: "mcp-admin@example.com" },
  });
  if (!user) throw new Error("Expected MCP admin user");

  return {
    app,
    endpoint: `/v1/orgs/${organizationBody.organization.id}/mcp`,
    token,
    userId: user.id,
  };
}

function mcpRequest(token: string, id: number, method: string, params = {}) {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  };
}

type McpResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  tools?: Array<{ name: string }>;
};

async function callTool(
  app: Awaited<ReturnType<typeof createHarness>>["app"],
  endpoint: string,
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await app.request(
    endpoint,
    mcpRequest(token, id, "tools/call", { name, arguments: args }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    error?: unknown;
    result?: McpResult;
  };
  expect(body.error).toBeUndefined();
  expect(body.result?.isError).not.toBe(true);
  if (!body.result?.structuredContent) {
    throw new Error(`${name} did not return structured content`);
  }
  return body.result.structuredContent;
}

describe("MCP end-to-end walkthrough", () => {
  test("lists the complete tool surface and runs a representative workflow", async () => {
    const { app, endpoint, token, userId } = await createHarness();

    const listed = await app.request(
      endpoint,
      mcpRequest(token, 1, "tools/list"),
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { result: McpResult };
    const names = listedBody.result.tools?.map((tool) => tool.name) ?? [];
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...expectedTools].sort());

    const created = await callTool(
      app,
      endpoint,
      token,
      2,
      "collections_create",
      {
        name: "mcp_events",
        description: "Created by the MCP walkthrough",
        schema: { title: "string", priority: "number" },
      },
    );
    expect(created).toMatchObject({ status: "ok", name: "mcp_events" });

    const inserted = await callTool(app, endpoint, token, 3, "records_insert", {
      collection: "mcp_events",
      data: { title: "Ship MCP", priority: 1 },
    });
    expect(inserted).toMatchObject({
      status: "ok",
      data: { title: "Ship MCP", priority: 1 },
    });

    const queried = await callTool(app, endpoint, token, 4, "records_query", {
      collection: "mcp_events",
      where: { priority: 1 },
    });
    expect(queried).toMatchObject({
      status: "ok",
      records: [{ data: { title: "Ship MCP", priority: 1 } }],
    });

    const granted = await callTool(
      app,
      endpoint,
      token,
      5,
      "permissions_grant",
      {
        subject: `user:${userId}`,
        resource: "/collections/mcp_events/archive",
        action: "read",
      },
    );
    expect(granted).toMatchObject({ status: "ok", subject: `user:${userId}` });

    const uploaded = await callTool(app, endpoint, token, 6, "files_upload", {
      filename: "mcp.txt",
      path: "walkthrough/mcp.txt",
      mime_type: "text/plain",
      content_base64: Buffer.from("MCP over HTTP").toString("base64"),
    });
    expect(uploaded).toMatchObject({
      status: "ok",
      file: { path: "walkthrough/mcp.txt", filename: "mcp.txt" },
    });

    const files = await callTool(app, endpoint, token, 7, "files_list", {
      prefix: "walkthrough",
    });
    expect(files).toMatchObject({
      status: "ok",
      files: [{ path: "walkthrough/mcp.txt" }],
    });

    const queued = await callTool(
      app,
      endpoint,
      token,
      8,
      "notifications_queue",
      {
        subject: "MCP walkthrough",
        message: "The MCP workflow completed",
        in_app: true,
      },
    );
    expect(queued).toMatchObject({
      status: "ok",
      message: "Notification queued",
    });

    const stats = await callTool(app, endpoint, token, 9, "stats", {});
    expect(stats).toMatchObject({
      status: "ok",
      collections: 1,
      records: 1,
      files: 1,
      storage_bytes: 13,
    });

    const audit = await callTool(app, endpoint, token, 10, "audit_log", {
      limit: 100,
    });
    const actions = (audit.entries as Array<{ action: string }>).map(
      (entry) => entry.action,
    );
    expect(actions).toContain("create_collection");
    expect(actions).toContain("insert_record");
    expect(actions).toContain("add_policy");
    expect(actions).toContain("upload_file");
    expect(actions).toContain("queue_notification");
  });
});
