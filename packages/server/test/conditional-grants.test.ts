import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";

import { loadConfig } from "../src/config";
import { addPolicy, removePolicy } from "../src/db/casbin";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../src/mcp/registry";
import { collectionsRouter } from "../src/routes/collections";
import { exportData, importData } from "../src/db/export-import";
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
      ...["read", "write", "delete"].map((action) => ({
        orgId: "org_test",
        ptype: "p",
        v0: "org:org_test:user:reader",
        v1: "/collections/contacts",
        v2: action,
      })),
      {
        orgId: "org_test",
        ptype: "g",
        v0: "user_reader",
        v1: "org:org_test:user:reader",
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
    where: { orgId: "org_test", ptype: "p", v0: "org:org_test:user:reader" },
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
const own = { created_by: "$user.id" };
const base = { subject: "user:user_reader", resource: "/collections/contacts" };

async function grant(app: Hono<AppEnvironment>, options: object) {
  const response = await app.request(
    policies,
    jsonRequest("POST", { ...base, ...options }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
}

describe("conditional additive grants", () => {
  test("direct account updates/deletes only its own rows; admin remains unrestricted", async () => {
    const { app } = await createGrantApp();
    await grant(app, { action: "update", where: own, fields: ["name"] });
    await grant(app, { action: "delete", where: own });
    const update = (id: string, data: object, user = "user_reader") =>
      app.request(`${records}/${id}`, jsonRequest("PATCH", { data }, user));
    expect((await update("record_own", { name: "Changed" })).status).toBe(200);
    expect((await update("record_other", { name: "Changed" })).status).toBe(
      404,
    );
    expect((await update("record_own", { amount: 99 })).status).toBe(403);
    expect(
      (await update("record_own", { name: "No", amount: 99 })).status,
    ).toBe(403);
    expect(
      (
        await update(
          "record_other",
          { name: "Admin", amount: 99 },
          "user_admin",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          records,
          jsonRequest("POST", { data: { name: "No create" } }, "user_reader"),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          `${records}/record_other`,
          jsonRequest("DELETE", {}, "user_reader"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `${records}/record_own`,
          jsonRequest("DELETE", {}, "user_reader"),
        )
      ).status,
    ).toBe(200);
    // A second member has not inherited the direct grant.
    expect(
      (await update("record_other", { name: "No" }, "user_other")).status,
    ).toBe(403);
  });

  test("matching grants union fields without crossing row conditions; broad grant adds access", async () => {
    const { app } = await createGrantApp();
    await grant(app, { action: "update", where: own, fields: ["name"] });
    await grant(app, { action: "update", fields: ["amount"] });
    const update = (id: string, data: object) =>
      app.request(
        `${records}/${id}`,
        jsonRequest("PATCH", { data }, "user_reader"),
      );
    expect(
      (await update("record_own", { name: "Changed", amount: 11 })).status,
    ).toBe(200);
    expect((await update("record_other", { amount: 91 })).status).toBe(200);
    expect(
      (await update("record_other", { name: "No", amount: 92 })).status,
    ).toBe(403);
    await grant(app, { action: "update" });
    expect((await update("record_other", { name: "Now allowed" })).status).toBe(
      200,
    );
    expect(
      (
        await app.request(
          policies,
          jsonRequest("DELETE", { ...base, action: "update" }),
        )
      ).status,
    ).toBe(200);
    expect((await update("record_other", { name: "No again" })).status).toBe(
      403,
    );
    expect((await update("record_other", { amount: 93 })).status).toBe(200);
  });

  test("read projection and query/count/aggregate inputs obey row-field pairs", async () => {
    const { app } = await createGrantApp();
    await grant(app, {
      action: "read",
      where: own,
      fields: ["name", "amount"],
    });
    await grant(app, { action: "read", fields: ["org_key"] });
    const query = async (suffix: string, body: object) => {
      const response = await app.request(
        `${records}/${suffix}`,
        jsonRequest("POST", body, "user_reader"),
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    };
    const all = await query("query", {});
    expect(all.total).toBe(2);
    expect(
      all.records.find((r: { id: string }) => r.id === "record_own").data,
    ).toEqual({ name: "Own", amount: 10, org_key: "org_test" });
    expect(
      all.records.find((r: { id: string }) => r.id === "record_other").data,
    ).toEqual({ org_key: "org_test" });
    const one = await app.request(`${records}/record_other`, {
      headers: { "x-test-user": "user_reader" },
    });
    expect((await one.json()).data).toEqual({ org_key: "org_test" });
    expect((await query("count", { where: { amount: { gt: 0 } } })).count).toBe(
      1,
    );
    expect((await query("query", { order_by: "amount", limit: 1 })).total).toBe(
      1,
    );
    expect(
      (
        await query("aggregate", {
          metrics: [{ op: "sum", field: "amount", as: "total" }],
        })
      ).rows,
    ).toEqual([{ total: 10 }]);
    expect(
      (
        await app.request(
          `${records}/query`,
          jsonRequest(
            "POST",
            { where: { owner_email: "reader@example.com" } },
            "user_reader",
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/v1/orgs/org_test/collections", {
          headers: { "x-test-user": "user_reader" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/v1/orgs/org_test/collections/contacts", {
          headers: { "x-test-user": "user_reader" },
        })
      ).status,
    ).toBe(200);
  });

  test("create/batch check new rows and update cannot change owners or jump between grants", async () => {
    const { app, services } = await createGrantApp();
    const byOwner = { owner_email: "$user.email" };
    await grant(app, { action: "create", where: byOwner });
    await grant(app, { action: "update", where: byOwner });
    await grant(app, {
      action: "update",
      where: { owner_email: "other@example.com" },
      fields: ["owner_email"],
    });
    const bad = await app.request(
      `${records}/record_own`,
      jsonRequest(
        "PATCH",
        { data: { owner_email: "other@example.com" } },
        "user_reader",
      ),
    );
    expect(bad.status).toBe(403);
    expect(
      (
        await services.prisma.record.findUniqueOrThrow({
          where: { id: "record_own" },
        })
      ).data,
    ).toMatchObject({ owner_email: "reader@example.com" });
    const valid = {
      name: "New",
      amount: 5,
      owner_email: "reader@example.com",
      org_key: "org_test",
    };
    expect(
      (
        await app.request(
          records,
          jsonRequest("POST", { data: valid }, "user_reader"),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          records,
          jsonRequest(
            "POST",
            { data: { ...valid, owner_email: "other@example.com" } },
            "user_reader",
          ),
        )
      ).status,
    ).toBe(403);
    const before = await services.prisma.record.count();
    expect(
      (
        await app.request(
          `${records}/batch`,
          jsonRequest(
            "POST",
            {
              records: [valid, { ...valid, owner_email: "other@example.com" }],
            },
            "user_reader",
          ),
        )
      ).status,
    ).toBe(403);
    expect(await services.prisma.record.count()).toBe(before);
    // A broad write grant still covers both create and update.
    await grant(app, { action: "write" });
    expect(
      (
        await app.request(
          `${records}/record_own`,
          jsonRequest(
            "PATCH",
            { data: { owner_email: "other@example.com" } },
            "user_reader",
          ),
        )
      ).status,
    ).toBe(200);
  });

  test("MCP discovers compact schemas and grants/lists/revokes exact conditions", async () => {
    const { connect } = await createGrantApp();
    const admin = await connect();
    const reader = await connect("user_reader");
    const input = { ...base, action: "update", where: own, fields: ["name"] };
    expect(
      (await admin.callTool({ name: "permissions_grant", arguments: input }))
        .isError,
    ).not.toBe(true);
    const listed = await admin.callTool({
      name: "permissions_list",
      arguments: {},
    });
    expect(listed.structuredContent).toMatchObject({
      policies: expect.arrayContaining([input]),
    });
    const update = await reader.callTool({
      name: "records_update",
      arguments: {
        collection: "contacts",
        id: "record_own",
        data: { name: "MCP" },
      },
    });
    expect(update.isError).not.toBe(true);
    expect(
      (
        await reader.callTool({
          name: "records_update",
          arguments: {
            collection: "contacts",
            id: "record_other",
            data: { name: "No" },
          },
        })
      ).isError,
    ).toBe(true);
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
            data: { name: "No" },
          },
        })
      ).isError,
    ).toBe(true);
  });

  test("invalid grants fail closed and canonical grant options revoke precisely", async () => {
    const { app, services } = await createGrantApp();
    for (const options of [
      { action: "delete", fields: ["name"] },
      { action: "manage", where: own },
      { action: "update", fields: ["missing"] },
      { action: "update", where: { missing: "value" } },
      { action: "update", where: { name: "$invalid" } },
      { action: "update", resource: "/collections/*", where: own },
    ])
      expect(
        (
          await app.request(
            policies,
            jsonRequest("POST", { ...base, ...options }),
          )
        ).status,
      ).toBe(400);
    const options = {
      where: { and: [own, { org_key: "$org.id" }] },
      fields: ["name", "amount"],
    };
    expect(
      await addPolicy(
        services.prisma,
        "org_test",
        "user_reader",
        base.resource,
        "update",
        options,
      ),
    ).toBe(true);
    expect(
      await addPolicy(
        services.prisma,
        "org_test",
        "user_reader",
        base.resource,
        "update",
        { ...options, fields: ["amount", "name", "name"] },
      ),
    ).toBe(false);
    expect(
      await removePolicy(
        services.prisma,
        "org_test",
        "user_reader",
        base.resource,
        "update",
        { ...options, fields: ["amount", "name"] },
      ),
    ).toBe(true);
  });
});

describe("grant persistence and role parity", () => {
  test("role grants and substitutions survive an export/import round trip", async () => {
    const { app, services } = await createGrantApp();
    await grant(app, {
      subject: "role:reader",
      action: "update",
      where: own,
      fields: ["name"],
    });
    const exported = await exportData(services.prisma, "org_test");
    expect(exported.policies).toContainEqual({
      subject: "role:reader",
      resource: base.resource,
      action: "update",
      where: own,
      fields: ["name"],
    });
    await services.prisma.casbinRule.deleteMany({
      where: { orgId: "org_test", v3: { not: null } },
    });
    await importData(services.prisma, "org_test", exported);
    const update = (id: string) =>
      app.request(
        `${records}/${id}`,
        jsonRequest("PATCH", { data: { name: "Round trip" } }, "user_reader"),
      );
    expect((await update("record_own")).status).toBe(200);
    expect((await update("record_other")).status).toBe(404);
    const checked = await app.request(
      "/v1/orgs/org_test/permissions/check",
      jsonRequest("POST", {
        user_id: "user_reader",
        resource: base.resource,
        action: "update",
      }),
    );
    expect(await checked.json()).toMatchObject({
      allowed: true,
      conditional: true,
    });
  });

  test("conditional deletes never grant collection deletion and negated empty conditions match no records", async () => {
    const { app } = await createGrantApp();
    await grant(app, { action: "delete", where: own });
    expect(
      (
        await app.request(
          "/v1/orgs/org_test/collections/contacts",
          jsonRequest("DELETE", { confirm: true }, "user_reader"),
        )
      ).status,
    ).toBe(403);
    await grant(app, { action: "read", where: { not: {} } });
    const response = await app.request(
      `${records}/query`,
      jsonRequest("POST", {}, "user_reader"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 0, records: [] });
  });
});
