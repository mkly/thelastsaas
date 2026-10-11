import { jobsFor } from "../src/jobs";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databaseProvider } from "../src/config";
import { registerDatabaseProvider } from "../src/db/provider";
import {
  insertRecord,
  insertRecordInTransaction,
  insertRecords,
  insertRecordsInTransaction,
} from "../src/db/records";
import { withUnitOfWork } from "../src/db/unit-of-work";
import { testMigrationSql } from "./test-migrations";

const postgresUrl = process.env.QUERY_TEST_DATABASE_URL;
const provider = postgresUrl ? databaseProvider(postgresUrl) : "sqlite";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-record-create-"));
  const path = join(directory, "test.db");
  if (!postgresUrl) {
    const database = new Database(path);
    try {
      database.exec(testMigrationSql);
    } finally {
      database.close();
    }
  }
  const url = postgresUrl ?? `file:${path}`;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const orgId = crypto.randomUUID();
  cleanups.push(async () => {
    try {
      await prisma.organization.deleteMany({ where: { id: orgId } });
    } finally {
      await jobsFor(prisma)?.close();
      await prisma.$disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await prisma.organization.create({
    data: { id: orgId, name: "Create test", slug: orgId },
  });
  const collection = await prisma.collection.create({
    data: {
      id: crypto.randomUUID(),
      orgId,
      name: "tasks",
      schema: {
        name: "string",
        amount: "number",
        due: "date",
        secret: "string",
      },
    },
  });
  // Context-taking functions must also work without a registered root client.
  return { prisma, provider, orgId, collection, url };
}

describe(`transaction-composable record create (${provider})`, () => {
  test("public wrappers preserve responses and partial batch validation", async () => {
    const { prisma, orgId, url } = await fixture();
    registerDatabaseProvider(prisma, url);
    const record = await insertRecord(
      prisma,
      orgId,
      "tasks",
      { name: "One", due: "2026-10-10" },
      "worker",
    );
    expect(record).toMatchObject({
      collection: "tasks",
      data: { name: "One", due: "2026-10-10T00:00:00.000Z" },
      created_by: "worker",
    });
    expect(record).not.toHaveProperty("mutation");
    const result = await insertRecords(prisma, orgId, "tasks", [
      { name: "Two", amount: 2 },
      { name: "Invalid", amount: "bad" },
      { name: "Three", amount: 3 },
    ]);
    expect(result.inserted).toBe(2);
    expect(result.ids).toHaveLength(2);
    expect(result.errors).toEqual([{ index: 1, errors: expect.any(Array) }]);
    expect(result).not.toHaveProperty("mutations");
    expect(await prisma.record.count({ where: { orgId } })).toBe(3);
    expect(await insertRecords(prisma, orgId, "tasks", [])).toEqual({
      inserted: 0,
      ids: [],
    });
    expect(
      await insertRecords(prisma, orgId, "tasks", [{ amount: "bad" }]),
    ).toEqual({
      inserted: 0,
      ids: [],
      errors: [{ index: 0, errors: expect.any(Array) }],
    });
    expect(await prisma.record.count({ where: { orgId } })).toBe(3);
  });

  test("single and batch inserts join an outer transaction and roll back together", async () => {
    const source = await fixture();
    await expect(
      withUnitOfWork(source, async (context) => {
        const single = await insertRecordInTransaction(
          context,
          source.orgId,
          "tasks",
          { name: "Single" },
        );
        const batch = await insertRecordsInTransaction(
          context,
          source.orgId,
          "tasks",
          [{ name: "Batch" }, { amount: "bad" }, { name: "Last" }],
        );
        expect(batch.result.inserted).toBe(2);
        expect(batch.result.errors?.[0]?.index).toBe(1);
        expect(
          await context.db.record.count({ where: { orgId: source.orgId } }),
        ).toBe(3);
        expect(
          await context.db.record.findUnique({
            where: { id: single.record.id },
          }),
        ).not.toBeNull();
        throw new Error("outer rollback");
      }),
    ).rejects.toThrow("outer rollback");
    expect(
      await source.prisma.record.count({ where: { orgId: source.orgId } }),
    ).toBe(0);
  });

  test("mutation snapshots retain full normalized data without leaking through projection", async () => {
    const source = await fixture();
    const { single, batch } = await withUnitOfWork(source, async (context) => {
      const single = await insertRecordInTransaction(
        context,
        source.orgId,
        "tasks",
        { name: "Projected", secret: "Internal", due: "2026-10-10" },
        "worker",
        undefined,
        [
          {
            where: { name: "Projected", created_by: "worker" },
            readable: ["name"],
            writable: ["name", "secret", "due"],
            checkAfter: true,
          },
        ],
      );
      const batch = await insertRecordsInTransaction(
        context,
        source.orgId,
        "tasks",
        [{ name: "A" }, { amount: "bad" }, { name: "B" }],
      );
      return { single, batch };
    });
    expect(single.record.data).toEqual({ name: "Projected" });
    expect(single.mutation).toEqual({
      mutation_id: expect.any(String),
      record_id: single.record.id,
      collection: "tasks",
      event: "create",
      occurred_at: single.record.created_at,
      before: null,
      after: {
        name: "Projected",
        secret: "Internal",
        due: "2026-10-10T00:00:00.000Z",
      },
      changed_fields: ["due", "name", "secret"],
    });
    expect(batch.mutations.map((event) => event.record_id)).toEqual(
      batch.result.ids,
    );
    expect(batch.mutations.map((event) => event.after?.name)).toEqual([
      "A",
      "B",
    ]);
    const mutations = [single.mutation, ...batch.mutations];
    expect(new Set(mutations.map((event) => event.mutation_id)).size).toBe(3);
    for (const event of mutations) {
      const persisted = await source.prisma.record.findUniqueOrThrow({
        where: { id: event.record_id },
      });
      expect(persisted.data).toEqual(event.after);
      expect(event.occurred_at).toBe(persisted.createdAt.toISOString());
    }
  });

  test("authorization failures roll back other writes and never become partial-validation errors", async () => {
    const source = await fixture();
    await expect(
      withUnitOfWork(source, async (context) => {
        await insertRecordInTransaction(context, source.orgId, "tasks", {
          name: "Earlier",
        });
        await insertRecordsInTransaction(
          context,
          source.orgId,
          "tasks",
          [{ name: "Allowed" }, { name: "Denied" }],
          "worker",
          undefined,
          [{ where: { name: "Allowed" }, checkAfter: true }],
        );
      }),
    ).rejects.toThrow("No grant permits this record change");
    expect(
      await source.prisma.record.count({ where: { orgId: source.orgId } }),
    ).toBe(0);
    await expect(
      withUnitOfWork(source, async (context) => {
        await insertRecordInTransaction(context, source.orgId, "tasks", {
          name: "Earlier",
        });
        await insertRecordsInTransaction(
          context,
          source.orgId,
          "tasks",
          [{ name: "Allowed" }, { secret: "Denied" }],
          "worker",
          {
            readableFields: new Set(["name"]),
            writableFields: new Set(["name"]),
          },
        );
      }),
    ).rejects.toThrow();
    expect(
      await source.prisma.record.count({ where: { orgId: source.orgId } }),
    ).toBe(0);
  });

  test("collection lookup observes uncommitted schemas and isolates them after rollback", async () => {
    const source = await fixture();
    await expect(
      withUnitOfWork(source, async (context) => {
        await context.db.collection.update({
          where: { id: source.collection.id },
          data: { schema: { name: "number" } },
        });
        const { record } = await insertRecordInTransaction(
          context,
          source.orgId,
          "tasks",
          { name: 123 },
        );
        expect(record.data).toEqual({ name: 123 });
        throw new Error("schema rollback");
      }),
    ).rejects.toThrow("schema rollback");
    const { record } = await withUnitOfWork(source, (context) =>
      insertRecordInTransaction(context, source.orgId, "tasks", {
        name: "Original schema",
      }),
    );
    expect(record.data).toEqual({ name: "Original schema" });
    expect(
      await source.prisma.record.count({ where: { orgId: source.orgId } }),
    ).toBe(1);
  });
});
