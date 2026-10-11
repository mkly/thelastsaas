import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { QueueSchedule, ScheduleCreate } from "@lastsaas/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { loadConfig, type AppConfig } from "../src/config";
import { addPolicy } from "../src/db/casbin";
import { registerTools } from "../src/mcp/registry";
import {
  closeServices,
  createServices,
  type AppServices,
} from "../src/services";
import { testMigrationSql } from "./test-migrations";

const base = "/v1/orgs/org_one/schedules";
const sentinel = "private-schedule-literal-sentinel";
const rule: ScheduleCreate = {
  queue: "jobs",
  payload: { title: "scheduled" },
  timing: { kind: "once", at: "2030-01-01T00:00:00Z" },
  enabled: true,
};
const recurring: ScheduleCreate["timing"] = {
  kind: "recurring",
  recurrence:
    "DTSTART;TZID=America/New_York:20300310T090000\nRRULE:FREQ=DAILY;COUNT=3",
};
interface Body {
  status: string;
  error?: string;
  message?: string;
  schedule: QueueSchedule;
  items: QueueSchedule[];
  next_cursor: string | null;
}

describe("schedule REST and MCP transports", () => {
  let directory: string;
  let services: AppServices;
  let config: AppConfig;
  let app: ReturnType<typeof createApp>;
  const connections: Array<{ client: Client; server: McpServer }> = [];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "lastsaas-schedules-transports-"));
    config = loadConfig({
      NODE_ENV: "test",
      PORT: "0",
      DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
      STORAGE_PATH: join(directory, "files"),
    });
    services = await createServices(config);
    services.database!.exec(testMigrationSql);
    for (const orgId of ["org_one", "org_two"]) {
      await services.prisma.organization.create({
        data: { id: orgId, name: orgId, slug: orgId },
      });
      await services.prisma.queue.create({
        data: {
          id: `${orgId}-jobs`,
          orgId,
          name: "jobs",
          schema: { title: "string", private: "string", owner: "string" },
        },
      });
      await services.prisma.queueSubscription.create({
        data: {
          id: `${orgId}-workers`,
          queueId: `${orgId}-jobs`,
          name: "workers",
        },
      });
    }
    for (const userId of ["admin", "worker", "foreign"]) {
      await services.prisma.user.create({
        data: {
          id: userId,
          name: userId,
          email: `${userId}@example.com`,
          kind: userId === "worker" ? "serviceaccount" : "human",
        },
      });
      await services.prisma.member.create({
        data: {
          id: `member-${userId}`,
          userId,
          organizationId: userId === "foreign" ? "org_two" : "org_one",
        },
      });
    }
    await addPolicy(services.prisma, "org_one", "admin", "/*", "*");
    await addPolicy(services.prisma, "org_two", "foreign", "/*", "*");
    services.auth = {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const id = headers.get("x-test-user");
          return id
            ? { session: { id: `session-${id}` }, user: { id, name: id } }
            : null;
        },
        verifyApiKey: async ({ body }: { body: { key: string } }) => ({
          valid: true,
          key: {
            referenceId: body.key,
            metadata: { organizationId: "org_one" },
          },
        }),
      },
    } as unknown as AppServices["auth"];
    app = createApp({ config, services });
  });
  afterEach(async () => {
    for (const { client, server } of connections.splice(0))
      await Promise.allSettled([client.close(), server.close()]);
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  async function rest(
    method: string,
    path = "",
    input?: unknown,
    user = "admin",
  ) {
    const response = await app.request(`${base}${path}`, {
      method,
      headers: { "x-test-user": user, "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    return { status: response.status, body: (await response.json()) as Body };
  }
  async function connect(userId = "admin", orgId: string | null = "org_one") {
    const server = new McpServer({ name: "schedules-test", version: "1.0.0" });
    registerTools(server, { config, services, userId, orgId });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "schedules-client", version: "1.0.0" });
    await client.connect(clientTransport);
    connections.push({ client, server });
    return client;
  }
  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const result = await client.callTool({
      name: `schedules_${name}`,
      arguments: args,
    });
    const body = result.structuredContent as unknown as Body;
    expect(body).toBeDefined();
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(body) },
    ]);
    expect(result.isError === true).toBe(body.status === "error");
    return body;
  }
  function grant(resource: string, action: string, options = {}) {
    return addPolicy(
      services.prisma,
      "org_one",
      "worker",
      resource,
      action,
      options,
    );
  }
  async function creatorGrants() {
    await grant("/schedules", "write");
    await grant("/queues/jobs", "create");
  }

  test("REST/MCP share CRUD, timing and pause/resume DTOs", async () => {
    const client = await connect();
    const { enabled: _enabled, ...input } = rule;
    const created = await rest("POST", "", input);
    expect(created.status).toBe(201);
    const id = created.body.schedule.id;
    expect(created.body.schedule).toMatchObject({
      created_by: "admin",
      status: "active",
      pause_reason: null,
      next_occurrence_at: "2030-01-01T00:00:00.000Z",
      timezone: null,
    });
    expect(Object.keys(created.body.schedule).sort()).toEqual(
      [
        "id",
        "organization_id",
        "created_by",
        "queue_id",
        "queue",
        "payload",
        "timing",
        "timezone",
        "status",
        "pause_reason",
        "cursor_at",
        "next_occurrence_at",
        "created_at",
        "updated_at",
      ].sort(),
    );
    expect(await call(client, "show", { id })).toEqual(created.body);
    const paused = await call(client, "update", { id, enabled: false });
    expect(paused.schedule).toMatchObject({
      status: "paused",
      pause_reason: "disabled",
      next_occurrence_at: created.body.schedule.next_occurrence_at,
    });
    expect((await rest("GET", `/${id}`)).body).toEqual(paused);
    const resumed = await rest("PATCH", `/${id}`, { enabled: true });
    expect(resumed.body.schedule).toMatchObject({
      status: "active",
      pause_reason: null,
    });
    expect(await call(client, "show", { id })).toEqual(resumed.body);
    const second = await call(client, "create", { ...rule, timing: recurring });
    expect(second.schedule).toMatchObject({
      timezone: "America/New_York",
      next_occurrence_at: "2030-03-10T13:00:00.000Z",
      timing: recurring,
    });
    const updated = await call(client, "update", {
      id: second.schedule.id,
      payload: { title: "changed" },
      timing: rule.timing,
    });
    expect(updated.schedule).toMatchObject({
      payload: { title: "changed" },
      timezone: null,
      timing: { kind: "once", at: "2030-01-01T00:00:00.000Z" },
    });
    expect((await rest("GET")).body).toEqual(await call(client, "list"));
    expect(await call(client, "delete", { id })).toEqual({
      status: "ok",
    } as unknown as Body);
    expect((await rest("DELETE", `/${second.schedule.id}`)).body).toEqual({
      status: "ok",
    } as unknown as Body);
    expect((await rest("GET", `/${id}`)).status).toBe(404);
    expect((await call(client, "show", { id })).error).toBe(
      "AutomationNotFoundError",
    );
    expect(await services.prisma.queueEntry.count()).toBe(0);
  });

  test("HTTP service-account MCP calls keep safe envelopes, no-store and value-free errors/logs", async () => {
    await creatorGrants();
    app = createApp({ config, services, logRequests: true });
    const logs = [spyOn(console, "log"), spyOn(console, "error")];
    async function httpCall(
      name: string,
      args: Record<string, unknown>,
      user = "worker",
    ) {
      const response = await app.request(`/v1/mcp?private=${sentinel}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${user}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: `schedules_${name}`, arguments: args },
        }),
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      return { status: response.status, body: await response.json() };
    }
    try {
      const created = await httpCall("create", rule);
      expect(created.status).toBe(200);
      const id = created.body.result.structuredContent.schedule.id;
      await grant(`/schedules/${id}`, "read");
      const shown = await httpCall("show", { id });
      expect(shown.body.result.structuredContent).toEqual(
        (await rest("GET", `/${id}`, undefined, "worker")).body,
      );
      expect(
        (
          await httpCall("create", {
            ...rule,
            payload: { missing: sentinel },
          })
        ).body.result.structuredContent.error,
      ).toBe("SchemaValidationError");
      expect((await httpCall("show", { id }, "foreign")).status).toBe(403);
      const denied = await app.request(`${base}?private=${sentinel}`);
      expect(denied.status).toBe(401);
      expect(denied.headers.get("cache-control")).toBe("no-store");
      for (const log of logs)
        expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });
});
