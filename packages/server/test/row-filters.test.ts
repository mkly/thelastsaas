import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";

import { loadConfig } from "../src/config";
import { getRowFilter } from "../src/db/rowFilters";
import type { AppEnvironment } from "../src/env";
import { permissionRouter } from "../src/routes/permissions";
import { recordsRouter } from "../src/routes/records";
import { closeServices, createServices } from "../src/services";

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

async function createRowFilterApp() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-row-filters-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
  });
  const services = await createServices(config);
  services.database.exec(
    readFileSync(
      new URL(
        "../prisma/migrations/20260819015000_init/migration.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );

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
  return app;
}

describe("row filters", () => {
  test("leaves access unrestricted when any granting path has no filter", async () => {
    let lookups = 0;
    const prisma = {
      rowFilter: {
        findMany: async () => {
          lookups += 1;
          return [{ role: "reader", condition: { created_by: "$user.id" } }];
        },
      },
    };
    const principal = {
      userId: "user_reader",
      userEmail: "reader@example.com",
      orgId: "org_test",
    };

    const direct = await getRowFilter(
      prisma as never,
      {
        getPermissionsForUser: async () => [
          ["user_reader", "/collections/*", "read"],
        ],
      } as never,
      principal,
      "collection_contacts",
      "/collections/contacts",
      "read",
    );
    expect(direct).toBeNull();
    expect(lookups).toBe(0);

    const unfilteredRole = await getRowFilter(
      prisma as never,
      {
        getPermissionsForUser: async () => [],
        getRolesForUser: async () => [
          "org:org_test:user:reader",
          "org:org_test:user:viewer",
        ],
        enforce: async () => true,
      } as never,
      principal,
      "collection_contacts",
      "/collections/contacts",
      "read",
    );
    expect(unfilteredRole).toBeNull();
    expect(lookups).toBe(1);
  });

  test("CRUD and principal substitutions narrow every existing-row operation", async () => {
    const app = await createRowFilterApp();
    const permissions = "/v1/orgs/org_test/permissions/row-filters";
    const records = "/v1/orgs/org_test/collections/contacts/records";
    const condition = {
      and: [
        { created_by: "$user.id" },
        { owner_email: "$user.email" },
        { org_key: "$org.id" },
      ],
    };
    const ids: string[] = [];

    for (const action of ["read", "write", "delete"] as const) {
      const response = await app.request(
        permissions,
        jsonRequest("POST", {
          collection: "contacts",
          role: "reader",
          action,
          condition,
        }),
      );
      expect(response.status).toBe(200);
      ids.push(((await response.json()) as { id: string }).id);
    }

    const listed = await app.request(permissions, {
      headers: { "x-test-user": "user_admin" },
    });
    expect(await listed.json()).toMatchObject({
      status: "ok",
      row_filters: [
        expect.objectContaining({ collection: "contacts", role: "reader" }),
        expect.objectContaining({ collection: "contacts", role: "reader" }),
        expect.objectContaining({ collection: "contacts", role: "reader" }),
      ],
    });

    const query = await app.request(
      `${records}/query`,
      jsonRequest("POST", {}, "user_reader"),
    );
    expect(await query.json()).toMatchObject({
      total: 1,
      records: [expect.objectContaining({ id: "record_own" })],
    });

    const count = await app.request(
      `${records}/count`,
      jsonRequest("POST", {}, "user_reader"),
    );
    expect(await count.json()).toEqual({ status: "ok", count: 1 });

    const aggregate = await app.request(
      `${records}/aggregate`,
      jsonRequest(
        "POST",
        {
          metrics: [
            { op: "count", as: "records" },
            { op: "sum", field: "amount", as: "total" },
          ],
        },
        "user_reader",
      ),
    );
    expect(await aggregate.json()).toMatchObject({
      rows: [{ records: 1, total: 10 }],
    });

    expect(
      (
        await app.request(`${records}/record_other`, {
          headers: { "x-test-user": "user_reader" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`${records}/record_own`, {
          headers: { "x-test-user": "user_reader" },
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await app.request(
          `${records}/record_other`,
          jsonRequest("PATCH", { data: { amount: 91 } }, "user_reader"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `${records}/record_own`,
          jsonRequest("PATCH", { data: { amount: 11 } }, "user_reader"),
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await app.request(`${records}/record_other`, {
          method: "DELETE",
          headers: { "x-test-user": "user_reader" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`${records}/record_own`, {
          method: "DELETE",
          headers: { "x-test-user": "user_reader" },
        })
      ).status,
    ).toBe(200);

    const removed = await app.request(`${permissions}/${ids[0]}`, {
      method: "DELETE",
      headers: { "x-test-user": "user_admin" },
    });
    expect(removed.status).toBe(200);
    const afterDelete = (await (
      await app.request(permissions, {
        headers: { "x-test-user": "user_admin" },
      })
    ).json()) as { row_filters: unknown[] };
    expect(afterDelete.row_filters).toHaveLength(2);
  });
});
