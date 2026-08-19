import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";

import { loadConfig } from "../src/config";
import { validateCollectionRecordData } from "../src/db/collections";
import type { AppEnvironment } from "../src/env";
import { collectionsRouter } from "../src/routes/collections";
import { closeServices, createServices } from "../src/services";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createCollectionsApp() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-collections-"));
  const databasePath = join(directory, "test.sqlite");
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${databasePath}`,
  });
  const services = createServices(config);
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

  const app = new Hono<AppEnvironment>();
  app.use("/v1/orgs/:orgId/*", async (context, next) => {
    context.set("services", services);
    context.set("orgId", context.req.param("orgId")!);
    context.set("userId", "user_test");
    await next();
  });
  app.route("/v1/orgs/:orgId/collections", collectionsRouter);

  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  return app;
}

describe("collections routes", () => {
  test("creates, lists, describes, and deletes an org-scoped collection", async () => {
    const app = await createCollectionsApp();
    const base = "/v1/orgs/org_test/collections";

    const createResponse = await app.request(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "contacts",
        description: "CRM contacts",
        schema: { name: "string" },
      }),
    });
    expect(createResponse.status).toBe(200);
    expect(await createResponse.json()).toEqual(
      expect.objectContaining({
        status: "ok",
        name: "contacts",
        description: "CRM contacts",
        schema: { name: "string" },
      }),
    );

    const listResponse = await app.request(base);
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      status: "ok",
      collections: [
        expect.objectContaining({
          name: "contacts",
          description: "CRM contacts",
        }),
      ],
    });

    const describeResponse = await app.request(`${base}/contacts`);
    expect(describeResponse.status).toBe(200);
    expect(await describeResponse.json()).toEqual(
      expect.objectContaining({
        status: "ok",
        name: "contacts",
        record_count: 0,
        sample_records: [],
      }),
    );

    const unconfirmedDelete = await app.request(`${base}/contacts`, {
      method: "DELETE",
    });
    expect(unconfirmedDelete.status).toBe(400);
    expect(await unconfirmedDelete.json()).toEqual({
      status: "error",
      error: "ValidationError",
      message: "confirm: deletion requires confirm=true",
    });

    const deleteResponse = await app.request(`${base}/contacts?confirm=true`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({
      status: "ok",
      message: "Collection 'contacts' deleted.",
    });

    const missingResponse = await app.request(`${base}/contacts`);
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({
      status: "error",
      error: "CollectionNotFoundError",
      message: "Collection 'contacts' not found",
    });
  });

  test("adds every supported field type and stores descriptions as AI hints", async () => {
    const app = await createCollectionsApp();
    const base = "/v1/orgs/org_test/collections";
    await app.request(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "events", schema: { title: "string" } }),
    });

    const response = await app.request(`${base}/events/schema`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        add_fields: {
          notes: "text",
          amount: "number",
          count: "integer",
          ratio: "float",
          active: "boolean",
          due: "date",
          starts_at: "datetime",
          metadata: "json",
          state: "enum:draft,published",
          owner: "ref:users",
          schedule: {
            type: "recurrence",
            description: "RFC 5545 schedule used by the planning agent",
          },
        },
        update_fields: {
          title: { description: "Short human-readable event title" },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        status: "ok",
        name: "events",
        schema: expect.objectContaining({
          title: {
            type: "string",
            description: "Short human-readable event title",
          },
          notes: "text",
          amount: "number",
          count: "integer",
          ratio: "float",
          active: "boolean",
          due: "date",
          starts_at: "datetime",
          metadata: "json",
          state: "enum:draft,published",
          owner: "ref:users",
          schedule: {
            type: "recurrence",
            description: "RFC 5545 schedule used by the planning agent",
          },
        }),
      }),
    );
  });

  test("returns structured errors for invalid schemas and duplicate names", async () => {
    const app = await createCollectionsApp();
    const base = "/v1/orgs/org_test/collections";
    const request = (schema: unknown) =>
      app.request(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "contacts", schema }),
      });

    const invalidResponse = await request({ bad: "unsupported" });
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.json()).toEqual(
      expect.objectContaining({
        status: "error",
        error: "SchemaValidationError",
      }),
    );

    expect((await request({ name: "string" })).status).toBe(200);
    const duplicateResponse = await request({ name: "string" });
    expect(duplicateResponse.status).toBe(409);
    expect(await duplicateResponse.json()).toEqual({
      status: "error",
      error: "CollectionExistsError",
      message: "Collection 'contacts' already exists",
    });
  });
});

describe("collection record validation", () => {
  test("uses the RFC 5545 engine for recurrence field values", () => {
    const schema = { schedule: "recurrence" };
    const valid =
      "DTSTART;TZID=America/Los_Angeles:20260819T090000\nRRULE:FREQ=DAILY;COUNT=3";
    const invalid =
      "DTSTART;TZID=Mars/Olympus:20260819T090000\nRRULE:FREQ=DAILY;COUNT=3";

    expect(validateCollectionRecordData({ schedule: valid }, schema)).toEqual(
      [],
    );
    expect(validateCollectionRecordData({ schedule: invalid }, schema)).toEqual(
      ["Field 'schedule': invalid recurrence value"],
    );
  });
});
