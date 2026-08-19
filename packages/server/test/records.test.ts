import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Schema } from "@lastsaas/shared";
import { Hono } from "hono";

import { loadConfig } from "../src/config";
import type { AppEnvironment } from "../src/env";
import { recordsRouter } from "../src/routes/records";
import { closeServices, createServices } from "../src/services";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createRecordsApp(schema: Schema) {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-records-"));
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
  await services.prisma.organization.create({
    data: { id: "org_test", name: "Test Org", slug: "test-org" },
  });
  await services.prisma.collection.create({
    data: {
      id: "collection_contacts",
      orgId: "org_test",
      name: "contacts",
      schema,
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
        v0: "user_test",
        v1: "org:org_test:user:admin",
      },
    ],
  });

  const app = new Hono<AppEnvironment>();
  app.use("/v1/orgs/:orgId/*", async (context, next) => {
    context.set("services", services);
    context.set("orgId", context.req.param("orgId")!);
    context.set("userId", "user_test");
    context.set("audit", async () => undefined);
    await next();
  });
  app.route("/v1/orgs/:orgId/collections/:name/records", recordsRouter);

  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, services };
}

const jsonRequest = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("records routes", () => {
  test("inserts, batches, gets, updates, deletes, and normalizes dates", async () => {
    const { app } = await createRecordsApp({
      name: "string",
      amount: "number",
      due: "date",
      starts_at: "datetime",
    });
    const base = "/v1/orgs/org_test/collections/contacts/records";

    const insertedResponse = await app.request(
      base,
      jsonRequest({
        data: {
          name: "Alice",
          amount: 10,
          due: "2026-08-19",
          starts_at: "2026-08-19T09:30:00-07:00",
        },
      }),
    );
    expect(insertedResponse.status).toBe(200);
    const inserted = (await insertedResponse.json()) as {
      id: string;
      created_by: string;
      data: Record<string, unknown>;
    };
    expect(inserted).toEqual(
      expect.objectContaining({
        status: "ok",
        collection: "contacts",
        created_by: "user_test",
        data: expect.objectContaining({
          due: "2026-08-19T00:00:00.000Z",
          starts_at: "2026-08-19T16:30:00.000Z",
        }),
      }),
    );

    const batchResponse = await app.request(
      `${base}/batch`,
      jsonRequest({
        records: [
          { name: "Bob", amount: 20 },
          { name: "Broken", amount: "lots" },
          { name: "Carol", amount: 30 },
        ],
      }),
    );
    expect(await batchResponse.json()).toEqual(
      expect.objectContaining({
        status: "ok",
        inserted: 2,
        ids: expect.any(Array),
        errors: [expect.objectContaining({ index: 1 })],
      }),
    );

    const getResponse = await app.request(`${base}/${inserted.id}`);
    expect(await getResponse.json()).toEqual(
      expect.objectContaining({ id: inserted.id, data: inserted.data }),
    );

    const updateResponse = await app.request(`${base}/${inserted.id}`, {
      ...jsonRequest({ data: { amount: 12 } }),
      method: "PATCH",
    });
    expect(await updateResponse.json()).toEqual(
      expect.objectContaining({
        status: "ok",
        data: expect.objectContaining({ name: "Alice", amount: 12 }),
      }),
    );

    const invalidUpdate = await app.request(`${base}/${inserted.id}`, {
      ...jsonRequest({ data: { unknown: true } }),
      method: "PATCH",
    });
    expect(invalidUpdate.status).toBe(400);
    expect(await invalidUpdate.json()).toEqual(
      expect.objectContaining({ error: "SchemaValidationError" }),
    );

    const deleteResponse = await app.request(`${base}/${inserted.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    expect((await app.request(`${base}/${inserted.id}`)).status).toBe(404);
  });

  test("covers comparison, logical, in, contains, between, and null filters", async () => {
    const { app } = await createRecordsApp({
      name: "string",
      status: "string",
      amount: "number",
      note: "string",
    });
    const base = "/v1/orgs/org_test/collections/contacts/records";
    await app.request(
      `${base}/batch`,
      jsonRequest({
        records: [
          { name: "Alice", status: "active", amount: 15, note: "alpha" },
          { name: "Bob", status: "inactive", amount: 25, note: "bravo" },
          { name: "Carol", status: "active", amount: 45, note: "charlie" },
          { name: "Dora", status: "inactive", amount: 5, note: null },
        ],
      }),
    );

    const comparison = await app.request(
      `${base}/query`,
      jsonRequest({
        where: {
          and: [
            { amount: { gt: 10, lte: 45 } },
            { amount: { gte: 15, lt: 45 } },
            { status: { not: "inactive" } },
          ],
        },
      }),
    );
    expect((await comparison.json()).records).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ name: "Alice" }),
      }),
    ]);

    const logical = await app.request(
      `${base}/query`,
      jsonRequest({
        where: {
          or: [{ not: { status: "active" } }, { name: { eq: "Alice" } }],
        },
        order_by: "name",
      }),
    );
    expect(
      ((await logical.json()).records as Array<{ data: { name: string } }>).map(
        (record) => record.data.name,
      ),
    ).toEqual(["Alice", "Bob", "Dora"]);

    const operators = await app.request(
      `${base}/query`,
      jsonRequest({
        where: {
          and: [
            { name: { contains: "or" } },
            { status: { in: ["inactive"] } },
            { amount: { between: [1, 10] } },
            { note: { is_null: true } },
          ],
        },
      }),
    );
    expect((await operators.json()).records).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ name: "Dora" }),
      }),
    ]);

    const count = await app.request(
      `${base}/count`,
      jsonRequest({ where: { status: "active" } }),
    );
    expect(await count.json()).toEqual({ status: "ok", count: 2 });
  });

  test("groups aggregate metrics and applies having", async () => {
    const { app } = await createRecordsApp({
      status: "string",
      amount: "number",
      schedule: "recurrence",
    });
    const base = "/v1/orgs/org_test/collections/contacts/records";
    const schedule =
      "DTSTART;TZID=America/Los_Angeles:20260819T090000\nRRULE:FREQ=DAILY;COUNT=3";
    await app.request(
      `${base}/batch`,
      jsonRequest({
        records: [
          { status: "active", amount: 15, schedule },
          { status: "active", amount: 45, schedule },
          { status: "inactive", amount: 5, schedule },
          { status: "inactive", amount: 25, schedule },
        ],
      }),
    );

    const aggregate = await app.request(
      `${base}/aggregate`,
      jsonRequest({
        group_by: ["status"],
        metrics: [
          { op: "count", as: "n" },
          { op: "sum", field: "amount", as: "total" },
          { op: "avg", field: "amount", as: "average" },
          { op: "min", field: "amount", as: "minimum" },
          { op: "max", field: "amount", as: "maximum" },
        ],
        having: { n: { gte: 2 } },
        order_by: "-total",
      }),
    );
    expect(await aggregate.json()).toEqual({
      status: "ok",
      columns: ["status", "n", "total", "average", "minimum", "maximum"],
      rows: [
        {
          status: "active",
          n: 2,
          total: 60,
          average: 30,
          minimum: 15,
          maximum: 45,
        },
        {
          status: "inactive",
          n: 2,
          total: 30,
          average: 15,
          minimum: 5,
          maximum: 25,
        },
      ],
    });
  });

  test("expands occurs_between after SQL filtering and before pagination", async () => {
    const { app } = await createRecordsApp({
      name: "string",
      status: "string",
      schedule: "recurrence",
    });
    const base = "/v1/orgs/org_test/collections/contacts/records";
    const dstWithExdate = [
      "DTSTART;TZID=America/New_York:20260301T090000",
      "RRULE:FREQ=WEEKLY;COUNT=4",
      "EXDATE:20260308T090000",
    ].join("\n");
    const later = [
      "DTSTART;TZID=America/New_York:20260315T090000",
      "RRULE:FREQ=WEEKLY;COUNT=2",
    ].join("\n");
    const outsideWindow = [
      "DTSTART;TZID=America/New_York:20260405T090000",
      "RRULE:FREQ=WEEKLY;COUNT=2",
    ].join("\n");
    await app.request(
      `${base}/batch`,
      jsonRequest({
        records: [
          { name: "A-no-match", status: "open", schedule: outsideWindow },
          { name: "B-dst", status: "open", schedule: dstWithExdate },
          { name: "C-later", status: "open", schedule: later },
          { name: "D-prefiltered", status: "closed", schedule: later },
        ],
      }),
    );

    const response = await app.request(
      `${base}/query`,
      jsonRequest({
        where: {
          and: [
            { status: "open" },
            {
              schedule: {
                occurs_between: [
                  "2026-03-01T00:00:00Z",
                  "2026-03-30T00:00:00Z",
                ],
              },
            },
          ],
        },
        order_by: "name",
        limit: 1,
        offset: 1,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      records: [
        expect.objectContaining({
          data: expect.objectContaining({ name: "C-later" }),
          occurrences: ["2026-03-15T13:00:00.000Z", "2026-03-22T13:00:00.000Z"],
        }),
      ],
      total: 2,
      limit: 1,
      offset: 1,
    });

    const fullResponse = await app.request(
      `${base}/query`,
      jsonRequest({
        where: {
          schedule: {
            occurs_between: ["2026-03-01T00:00:00Z", "2026-03-30T00:00:00Z"],
          },
        },
        order_by: "name",
      }),
    );
    const full = (await fullResponse.json()) as {
      records: Array<{ data: { name: string }; occurrences: string[] }>;
    };
    expect(full.records.map((record) => record.data.name)).toEqual([
      "B-dst",
      "C-later",
      "D-prefiltered",
    ]);
    expect(full.records[0]?.occurrences).toEqual([
      "2026-03-01T14:00:00.000Z",
      "2026-03-15T13:00:00.000Z",
      "2026-03-22T13:00:00.000Z",
    ]);

    const count = await app.request(
      `${base}/count`,
      jsonRequest({
        where: {
          schedule: {
            occurs_between: ["2026-03-01T00:00:00Z", "2026-03-30T00:00:00Z"],
          },
        },
      }),
    );
    expect(await count.json()).toEqual({ status: "ok", count: 3 });

    const overlongWindow = await app.request(
      `${base}/query`,
      jsonRequest({
        where: {
          schedule: {
            occurs_between: ["2026-01-01T00:00:00Z", "2028-01-04T00:00:00Z"],
          },
        },
      }),
    );
    expect(overlongWindow.status).toBe(400);
    expect(await overlongWindow.json()).toEqual(
      expect.objectContaining({ error: "RECURRENCE_WINDOW_LIMIT" }),
    );
  });
});
