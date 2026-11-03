import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";

import { loadConfig } from "../src/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/mcp/registry";
import { collectionsRouter } from "../src/routes/collections";
import { exportData } from "../src/db/export-import";
import type { AppEnvironment } from "../src/env";
import { permissionRouter } from "../src/routes/permissions";
import { recordsRouter } from "../src/routes/records";
import { closeServices, createServices } from "../src/services";
import { testMigrationSql } from "./test-migrations";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function jsonRequest(
  method: string,
  body: unknown,
  userId = "user_admin",
): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-user": userId,
    },
    body: JSON.stringify(body),
  };
}

async function createGrantApp() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-row-filters-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
  });
  const services = await createServices(config);
  if (!services.database) throw new Error("Expected SQLite database handle");
  services.database.exec(testMigrationSql);

  await services.prisma.user.createMany({
    data: [
      { id: "user_admin", email: "admin@example.com", name: "Admin" },
      { id: "user_reader", email: "reader@example.com", name: "Reader" },
      { id: "user_other", email: "other@example.com", name: "Other" },
    ],
  });
  await services.prisma.organization.create({
    data: { id: "org_test", name: "Test Org", slug: "test-org" },
  });
  await services.prisma.collection.create({
    data: {
      id: "collection_contacts",
      orgId: "org_test",
      name: "contacts",
      schema: {
        name: "string",
        amount: "number",
        owner_email: "string",
        org_key: "string",
      },
    },
  });
  await services.prisma.casbinRule.createMany({
    data: [
      {
        orgId: "org_test",
        ptype: "p",
        v0: "org:org_test:role:admin",
        v1: "/*",
        v2: "*",
        v3: "true",
        v4: "",
      },
      {
        orgId: "org_test",
        ptype: "g",
        v0: "user_admin",
        v1: "org:org_test:role:admin",
      },
      ...["read", "write", "delete"].map((action) => ({
        orgId: "org_test",
        ptype: "p",
        v0: "org:org_test:role:reader",
        v1: "/collections/contacts",
        v2: action,
        v3: "true",
        v4: "",
      })),
      {
        orgId: "org_test",
        ptype: "g",
        v0: "user_reader",
        v1: "org:org_test:role:reader",
      },
    ],
  });

  const now = new Date();
  await services.prisma.record.createMany({
    data: [
      {
        id: "record_own",
        orgId: "org_test",
        collectionId: "collection_contacts",
        data: {
          name: "Own",
          amount: 10,
          owner_email: "reader@example.com",
          org_key: "org_test",
        },
        createdBy: "user_reader",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "record_other",
        orgId: "org_test",
        collectionId: "collection_contacts",
        data: {
          name: "Other",
          amount: 90,
          owner_email: "other@example.com",
          org_key: "org_test",
        },
        createdBy: "user_other",
        createdAt: now,
        updatedAt: now,
      },
    ],
  });

  const app = new Hono<AppEnvironment>();
  app.use("/v1/orgs/:orgId/*", async (context, next) => {
    context.set("services", services);
    context.set("orgId", context.req.param("orgId")!);
    context.set("userId", context.req.header("x-test-user") ?? "user_admin");
    context.set("audit", async () => undefined);
    await next();
  });
  app.route("/v1/orgs/:orgId/permissions", permissionRouter);
  app.route("/v1/orgs/:orgId/collections/:name/records", recordsRouter);

  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  await services.prisma.casbinRule.deleteMany({
    where: {
      orgId: "org_test",
      ptype: "p",
      v0: "org:org_test:role:reader",
      v3: "true",
      v4: "",
    },
  });
  await services.prisma.member.createMany({
    data: ["user_admin", "user_reader", "user_other"].map((userId) => ({
      id: userId,
      userId,
      organizationId: "org_test",
      role: userId === "user_admin" ? "admin" : "member",
    })),
  });
  app.route("/v1/orgs/:orgId/collections", collectionsRouter);
  const connect = async (userId = "user_admin") => {
    const server = new McpServer({ name: "grant-test", version: "1" });
    registerTools(server, { services, config, orgId: "org_test", userId });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(ct);
    cleanups.unshift(async () => {
      await client.close();
      await server.close();
    });
    return client;
  };
  return { app, services, connect };
}

const records = "/v1/orgs/org_test/collections/contacts/records";
const policies = "/v1/orgs/org_test/permissions/policies";
const base = { subject: "user:user_reader", resource: "/collections/contacts" };
const own = "r.obj.data.owner_email == r.usr.email";
async function grant(app: Hono<AppEnvironment>, options: object) {
  const response = await app.request(
    policies,
    jsonRequest("POST", { ...base, ...options }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
}
async function field(app: Hono<AppEnvironment>, name: string, action: string) {
  await grant(app, { resource: `${base.resource}/fields/${name}`, action });
}
test("ownership and changed-field policies apply independently; denies carry configured messages", async () => {
  const { app, services } = await createGrantApp();
  await grant(app, {
    action: "update",
    cond: own + " && r.next.data.owner_email == r.usr.email",
    msg: "Only your contacts can be edited.",
  });
  await grant(app, {
    action: "delete",
    cond: own,
    msg: "Only your contacts can be deleted.",
  });
  await field(app, "name", "update");
  const update = (id: string, data: object, user = "user_reader") =>
    app.request(`${records}/${id}`, jsonRequest("PATCH", { data }, user));
  expect((await update("record_own", { name: "Changed" })).status).toBe(200);
  const denied = await update("record_other", { name: "No" });
  expect(denied.status).toBe(403);
  expect(await denied.text()).toContain("Only your contacts can be edited.");
  expect((await update("record_own", { amount: 99 })).status).toBe(403);
  expect(
    (await update("record_own", { owner_email: "other@example.com" })).status,
  ).toBe(403);
  expect(
    (await update("record_other", { amount: 99 }, "user_admin")).status,
  ).toBe(200);
  expect(
    (
      await app.request(
        `${records}/record_other`,
        jsonRequest("DELETE", {}, "user_reader"),
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(
        `${records}/record_own`,
        jsonRequest("DELETE", {}, "user_reader"),
      )
    ).status,
  ).toBe(200);
  expect(await services.prisma.record.count()).toBe(1);
});
test("conditional reads scope pagination, counts, aggregates and export; fields reject hidden queries", async () => {
  const { app, services } = await createGrantApp();
  await grant(app, { action: "read", cond: own });
  await field(app, "name", "read");
  await field(app, "amount", "read");
  const query = async (suffix: string, body: object) => {
    const res = await app.request(
      `${records}/${suffix}`,
      jsonRequest("POST", body, "user_reader"),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    return res.json();
  };
  expect(await query("query", { limit: 1 })).toMatchObject({
    total: 1,
    records: [{ id: "record_own", data: { name: "Own", amount: 10 } }],
  });
  expect(await query("count", {})).toMatchObject({ count: 1 });
  expect(
    await query("aggregate", {
      metrics: [{ op: "sum", field: "amount", as: "total" }],
    }),
  ).toMatchObject({ rows: [{ total: 10 }] });
  for (const body of [
    { where: { owner_email: "reader@example.com" } },
    { order_by: "owner_email" },
  ])
    expect(
      (
        await app.request(
          `${records}/query`,
          jsonRequest("POST", body, "user_reader"),
        )
      ).status,
    ).toBe(400);
  const description = await app.request(
    "/v1/orgs/org_test/collections/contacts",
    { headers: { "x-test-user": "user_reader" } },
  );
  expect(await description.json()).toMatchObject({
    policies: expect.arrayContaining([
      expect.objectContaining({ cond: own, action: "read" }),
    ]),
  });
  const exported = await exportData(services.prisma, "org_test");
  expect(exported.policies).toContainEqual({
    ...base,
    action: "read",
    cond: own,
    msg: "",
  });
  const scopedExport = await exportData(
    services.prisma,
    "org_test",
    "user_reader",
  );
  expect(scopedExport.collections[0]?.records).toMatchObject([
    { id: "record_own", data: { name: "Own", amount: 10 } },
  ]);
  expect(scopedExport.collections[0]?.records).toHaveLength(1);
  expect(scopedExport.collections[0]?.records[0]?.data).not.toHaveProperty(
    "owner_email",
  );
});
test("create/batch conditions inspect proposed data and rollback permission failures", async () => {
  const { app, services } = await createGrantApp();
  await grant(app, {
    action: "create",
    cond: "r.next.data.owner_email == r.usr.email",
    msg: "Assign yourself.",
  });
  await field(app, "*", "create");
  const valid = { name: "New", owner_email: "reader@example.com" };
  expect(
    (
      await app.request(
        records,
        jsonRequest("POST", { data: valid }, "user_reader"),
      )
    ).status,
  ).toBe(200);
  const before = await services.prisma.record.count();
  expect(
    (
      await app.request(
        `${records}/batch`,
        jsonRequest(
          "POST",
          { records: [valid, { ...valid, owner_email: "other@example.com" }] },
          "user_reader",
        ),
      )
    ).status,
  ).toBe(403);
  expect(await services.prisma.record.count()).toBe(before);
});
test("MCP grants, lists and revokes exact conditions and rejects row-dependent field policies", async () => {
  const { app, connect } = await createGrantApp();
  const admin = await connect();
  const reader = await connect("user_reader");
  const input = {
    ...base,
    action: "update",
    cond: own,
    msg: "Only your contacts.",
  };
  expect(
    (await admin.callTool({ name: "permissions_grant", arguments: input }))
      .isError,
  ).not.toBe(true);
  await field(app, "name", "update");
  expect(
    (await admin.callTool({ name: "permissions_list", arguments: {} }))
      .structuredContent,
  ).toMatchObject({ policies: expect.arrayContaining([input]) });
  expect(
    (
      await reader.callTool({
        name: "records_update",
        arguments: {
          collection: "contacts",
          id: "record_own",
          data: { name: "MCP" },
        },
      })
    ).isError,
  ).not.toBe(true);
  expect(
    (await admin.callTool({ name: "permissions_revoke", arguments: input }))
      .isError,
  ).not.toBe(true);
  expect(
    (
      await reader.callTool({
        name: "records_update",
        arguments: {
          collection: "contacts",
          id: "record_own",
          data: { name: "Denied" },
        },
      })
    ).isError,
  ).toBe(true);
  for (const options of [
    { cond: "r.next.data." },
    { resource: `${base.resource}/fields/name`, cond: own },
  ])
    expect(
      (
        await app.request(
          policies,
          jsonRequest("POST", { ...base, action: "update", ...options }),
        )
      ).status,
    ).toBe(400);
});
