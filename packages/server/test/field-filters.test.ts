import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";

import { loadConfig } from "../src/config";
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

async function createFieldFilterApp() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-field-filters-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
  });
  const services = await createServices(config);
  if (!services.database) throw new Error("Expected SQLite database handle");
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
      { id: "user_member", email: "member@example.com", name: "Member" },
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
      schema: {
        title: "string",
        amount: "number",
        secret: "string",
        schedule: "recurrence",
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
      ...["read", "write"].map((action) => ({
        orgId: "org_test",
        ptype: "p",
        v0: "org:org_test:user:member",
        v1: "/collections/entries",
        v2: action,
      })),
      {
        orgId: "org_test",
        ptype: "g",
        v0: "user_member",
        v1: "org:org_test:user:member",
      },
    ],
  });
  const now = new Date();
  await services.prisma.record.createMany({
    data: [
      {
        id: "record_own",
        orgId: "org_test",
        collectionId: "collection_entries",
        data: {
          title: "Own",
          amount: 10,
          secret: "own-secret",
          schedule:
            "DTSTART;TZID=UTC:20260820T160000\nRRULE:FREQ=DAILY;COUNT=3",
        },
        createdBy: "user_member",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "record_other",
        orgId: "org_test",
        collectionId: "collection_entries",
        data: {
          title: "Other",
          amount: 90,
          secret: "other-secret",
          schedule:
            "DTSTART;TZID=UTC:20260820T160000\nRRULE:FREQ=DAILY;COUNT=3",
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

describe("field filters", () => {
  test("compose with Casbin and row filters across reads and writes", async () => {
    const app = await createFieldFilterApp();
    const permissions = "/v1/orgs/org_test/permissions";
    const records = "/v1/orgs/org_test/collections/entries/records";

    for (const action of ["read", "write"] as const) {
      expect(
        (
          await app.request(
            `${permissions}/row-filters`,
            jsonRequest("POST", {
              collection: "entries",
              role: "member",
              action,
              condition: { created_by: "$user.id" },
            }),
          )
        ).status,
      ).toBe(200);
    }

    const readFilter = await app.request(
      `${permissions}/field-filters`,
      jsonRequest("POST", {
        collection: "entries",
        role: "member",
        action: "read",
        readable_fields: ["title", "amount"],
        writable_fields: [],
      }),
    );
    expect(readFilter.status).toBe(200);
    const readFilterId = ((await readFilter.json()) as { id: string }).id;
    expect(
      (
        await app.request(
          `${permissions}/field-filters`,
          jsonRequest("POST", {
            collection: "entries",
            role: "member",
            action: "write",
            readable_fields: ["title", "amount"],
            writable_fields: ["title", "amount"],
          }),
        )
      ).status,
    ).toBe(200);

    const listed = await app.request(`${permissions}/field-filters`, {
      headers: { "x-test-user": "user_admin" },
    });
    expect(await listed.json()).toMatchObject({
      field_filters: [
        expect.objectContaining({ collection: "entries", role: "member" }),
        expect.objectContaining({ collection: "entries", role: "member" }),
      ],
    });

    const inserted = await app.request(
      records,
      jsonRequest(
        "POST",
        { data: { title: "Submitted", amount: 20 } },
        "user_member",
      ),
    );
    expect(inserted.status).toBe(200);

    const deniedWrite = await app.request(
      records,
      jsonRequest(
        "POST",
        { data: { title: "Nope", secret: "leak" } },
        "user_member",
      ),
    );
    expect(deniedWrite.status).toBe(403);
    expect(await deniedWrite.json()).toMatchObject({
      error: "FieldPermissionDeniedError",
      message: expect.stringContaining("'secret'"),
    });

    const query = await app.request(
      `${records}/query`,
      jsonRequest("POST", {}, "user_member"),
    );
    const queryBody = (await query.json()) as {
      total: number;
      records: Array<{ data: Record<string, unknown>; created_by: string }>;
    };
    expect(queryBody.total).toBe(2);
    expect(queryBody.records).toHaveLength(2);
    for (const record of queryBody.records) {
      expect(record.created_by).toBe("user_member");
      expect(Object.keys(record.data).sort()).toEqual(["amount", "title"]);
    }

    const own = await app.request(`${records}/record_own`, {
      headers: { "x-test-user": "user_member" },
    });
    expect(await own.json()).toMatchObject({
      data: { title: "Own", amount: 10 },
    });
    expect(
      (
        await app.request(`${records}/record_other`, {
          headers: { "x-test-user": "user_member" },
        })
      ).status,
    ).toBe(404);

    const deniedPatch = await app.request(
      `${records}/record_own`,
      jsonRequest("PATCH", { data: { secret: "changed" } }, "user_member"),
    );
    expect(deniedPatch.status).toBe(403);
    expect(await deniedPatch.json()).toMatchObject({
      error: "FieldPermissionDeniedError",
    });

    const allowedPatch = await app.request(
      `${records}/record_own`,
      jsonRequest("PATCH", { data: { amount: 11 } }, "user_member"),
    );
    expect(allowedPatch.status).toBe(200);
    expect(await allowedPatch.json()).toMatchObject({
      data: { title: "Own", amount: 11 },
    });

    for (const body of [
      { where: { secret: "own-secret" } },
      {
        where: {
          schedule: {
            occurs_between: ["2026-08-20T00:00:00Z", "2026-08-25T00:00:00Z"],
          },
        },
      },
    ]) {
      const hiddenQuery = await app.request(
        `${records}/query`,
        jsonRequest("POST", body, "user_member"),
      );
      expect(hiddenQuery.status).toBe(400);
      expect(await hiddenQuery.json()).toMatchObject({
        error: "InvalidQueryError",
        message: expect.stringContaining("not allowed"),
      });
    }

    for (const body of [
      { group_by: ["secret"], metrics: [{ op: "count" }] },
      { metrics: [{ op: "sum", field: "secret" }] },
      {
        group_by: ["secret"],
        metrics: [{ op: "count", as: "total" }],
        having: { secret: { eq: "own-secret" } },
      },
    ]) {
      const hiddenAggregate = await app.request(
        `${records}/aggregate`,
        jsonRequest("POST", body, "user_member"),
      );
      expect(hiddenAggregate.status).toBe(400);
      expect(await hiddenAggregate.json()).toMatchObject({
        error: "InvalidQueryError",
      });
    }

    expect(
      (
        await app.request(`${permissions}/field-filters/${readFilterId}`, {
          method: "DELETE",
          headers: { "x-test-user": "user_admin" },
        })
      ).status,
    ).toBe(200);
  });

  test("rejects field-filter names outside the collection schema", async () => {
    const app = await createFieldFilterApp();
    const response = await app.request(
      "/v1/orgs/org_test/permissions/field-filters",
      jsonRequest("POST", {
        collection: "entries",
        role: "member",
        action: "read",
        readable_fields: ["missing"],
        writable_fields: [],
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "InvalidRequest",
      message: expect.stringContaining("'missing'"),
    });
  });
});
