import { sql, queryRows } from "../src/db/query/kysely";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Schema, Where } from "@lastsaas/shared";
import { databaseProvider, loadConfig } from "../src/config";
import {
  createCollection,
  updateCollectionSchema,
} from "../src/db/collections";
import { addPolicy } from "../src/db/casbin";
import { resolveRecordGrants } from "../src/db/record-grants";
import {
  aggregateRecords,
  countRecords,
  deleteRecord,
  getRecord,
  insertRecord,
  queryRecords,
  updateRecord,
} from "../src/db/records";
import { compileWhere } from "../src/db/query/compile";
import { closeServices, createServices } from "../src/services";
import { testMigrationSql } from "./test-migrations";

// Run this exact contract with each generated Prisma client. The PostgreSQL
// runner supplies an isolated schema; the normal suite uses a temporary SQLite DB.
const postgresUrl = process.env.QUERY_TEST_DATABASE_URL;
const provider = postgresUrl ? databaseProvider(postgresUrl) : "sqlite";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const schema: Schema = {
  title: "string",
  status: "string",
  amount: "number",
  active: "boolean",
  due: "datetime",
  secret: "string",
  schedule: "recurrence",
};

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-query-backends-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: postgresUrl ?? `file:${join(directory, "test.db")}`,
    STORAGE_PATH: join(directory, "files"),
  });
  const services = await createServices(config);
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  services.database?.exec(testMigrationSql);
  const prisma = services.prisma;
  const orgId = crypto.randomUUID();
  await prisma.organization.create({
    data: { id: orgId, name: "Query test", slug: orgId },
  });
  cleanups.push(async () => {
    await prisma.organization.delete({ where: { id: orgId } });
  });
  const collection = await createCollection(
    prisma,
    orgId,
    null,
    "tasks",
    schema,
  );
  const insert = (data: Record<string, unknown>, user = "reader") =>
    insertRecord(prisma, orgId, "tasks", data, user);
  const query = (where?: Where, orderBy = "title") =>
    queryRecords(prisma, orgId, "tasks", where, orderBy);
  await insert({
    title: "A",
    status: "open",
    amount: 2,
    active: true,
    due: "2026-09-01T00:00:00Z",
    secret: "hidden",
  });
  await insert({
    title: "B",
    status: "done",
    amount: 10,
    active: false,
    due: "2026-09-02T00:00:00Z",
    secret: "other",
  });
  await insert({ title: "C", status: null, amount: null, active: null });
  await insert({ title: "D" });
  return { prisma, orgId, collection, insert, query };
}

function titles(result: Awaited<ReturnType<typeof queryRecords>>) {
  return result.records.map((r) => r.data.title);
}

describe(`query backend contract (${provider})`, () => {
  test("scalar filters, nulls and nested negation have the same results", async () => {
    const { query } = await fixture();
    const cases: Array<[Where, string[]]> = [
      [{ status: "open" }, ["A"]],
      [{ status: { eq: "done" } }, ["B"]],
      [{ amount: 2 }, ["A"]],
      [{ active: true }, ["A"]],
      [{ active: false }, ["B"]],
      [{ status: { not: "open" } }, ["B"]],
      [{ not: { status: "open" } }, ["B"]],
      [{ not: { or: [{ status: "open" }, { active: false }] } }, []],
      [{ not: { not: { status: "open" } } }, ["A"]],
      [{ status: { is_null: true } }, ["C", "D"]],
      [{ status: { is_null: false } }, ["A", "B"]],
      [{ status: null }, []],
      [{ not: { status: null } }, []],
      [{ status: { in: ["open", "done"] } }, ["A", "B"]],
      [{ amount: { gt: 3 } }, ["B"]],
      [{ due: { gte: "2026-09-02T00:00:00.000Z" } }, ["B"]],
      [{ and: [{ active: true }, { amount: { between: [1, 3] } }] }, ["A"]],
      [{ or: [{ status: "open" }, { status: "done" }] }, ["A", "B"]],
    ];
    for (const [where, expected] of cases)
      expect(titles(await query(where))).toEqual(expected);
    await expect(query({ amount: "2" })).rejects.toThrow(
      "equality requires a number",
    );
    expect(
      titles(await query({ amount: { is_null: false } }, "-amount")),
    ).toEqual(["B", "A"]);
    expect(titles(await query(undefined, "amount")).slice(0, 2)).toEqual([
      "A",
      "B",
    ]);
    expect(titles(await query(undefined, "-amount")).slice(2)).toEqual([
      "B",
      "A",
    ]);
  });

  test("parameters, aggregate/count and tenant/collection scope", async () => {
    const { prisma, orgId, insert, query } = await fixture();
    const literal = "x' OR 1=1 -- ? %_";
    await insert({ title: "E", status: literal });
    expect(titles(await query({ status: literal }))).toEqual(["E"]);
    expect(titles(await query({ status: { contains: "%_" } }))).toEqual(["E"]);
    await createCollection(prisma, orgId, null, "other", schema);
    await insertRecord(prisma, orgId, "other", {
      title: "Wrong collection",
      status: "open",
    });
    const otherOrg = crypto.randomUUID();
    await prisma.organization.create({
      data: { id: otherOrg, name: "Other", slug: otherOrg },
    });
    cleanups.push(async () => {
      await prisma.organization.delete({ where: { id: otherOrg } });
    });
    await createCollection(prisma, otherOrg, null, "tasks", schema);
    await insertRecord(prisma, otherOrg, "tasks", {
      title: "Wrong tenant",
      status: "open",
    });
    expect(titles(await query({ status: "open" }))).toEqual(["A"]);
    expect(await countRecords(prisma, orgId, "tasks", { status: "open" })).toBe(
      1,
    );
    const result = await aggregateRecords(prisma, orgId, "tasks", {
      where: { amount: { is_null: false } },
      metrics: [
        { op: "sum", field: "amount", as: "total" },
        { op: "count", as: "n" },
      ],
    });
    expect(Number(result.rows[0]?.total)).toBe(12);
    expect(Number(result.rows[0]?.n)).toBe(2);
  });

  test("bound JSON paths work across grouping, having, ordering and pagination", async () => {
    const { prisma, orgId, query } = await fixture();
    const result = await aggregateRecords(prisma, orgId, "tasks", {
      group_by: ["active", "amount"],
      where: { amount: { is_null: false } },
      metrics: [
        { op: "count", as: "n" },
        { op: "sum", field: "amount", as: "total" },
      ],
      having: { active: true, total: { between: [1, 3] }, n: { gte: 1 } },
      order_by: "-total",
      limit: 1,
    });
    expect(result.rows).toHaveLength(1);
    expect(Boolean(result.rows[0]?.active)).toBe(true);
    expect(Number(result.rows[0]?.amount)).toBe(2);
    expect(Number(result.rows[0]?.total)).toBe(2);
    expect(Number(result.rows[0]?.n)).toBe(1);
    const page = await queryRecords(
      prisma,
      orgId,
      "tasks",
      { amount: { is_null: false } },
      "amount",
      1,
      1,
    );
    expect(titles(page)).toEqual(["B"]);
    expect(page.total).toBe(2);
    expect(
      titles(await query({ amount: { is_null: false } }, "amount")),
    ).toEqual(["A", "B"]);
  });

  test("Kysely queries execute inside the supplied Prisma transaction", async () => {
    const { prisma, orgId, collection, query } = await fixture();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.record.create({
          data: {
            id: crypto.randomUUID(),
            orgId,
            collectionId: collection.id,
            createdBy: "test",
            data: { title: "Rollback", status: "temporary" },
          },
        });
        const predicate = compileWhere(
          { status: "temporary" },
          schema,
          provider,
        );
        const rows = await queryRows<{ id: string }>(
          tx,
          provider,
          sql`SELECT id FROM records WHERE org_id = ${orgId} AND collection_id = ${collection.id} AND ${predicate.expression}`,
        );
        expect(rows).toHaveLength(1);
        throw new Error("rollback probe");
      }),
    ).rejects.toThrow("rollback probe");
    expect((await query({ status: "temporary" })).total).toBe(0);
  });

  test("conditional grants constrain reads, query inputs, writes and deletes", async () => {
    const { prisma, orgId, collection, query } = await fixture();
    const condition = { status: "open" };
    for (const action of ["read", "create", "update"]) {
      await addPolicy(prisma, orgId, "reader", "/collections/tasks", action, {
        where: condition,
        fields: ["title", "status"],
      });
    }
    await addPolicy(prisma, orgId, "reader", "/collections/tasks", "delete", {
      where: condition,
    });
    const grants = (action: string) =>
      resolveRecordGrants(
        prisma,
        { orgId, userId: "reader", userEmail: "reader@example.com" },
        collection.id,
        "/collections/tasks",
        action,
      );
    const read = await grants("read");
    const visible = await queryRecords(
      prisma,
      orgId,
      "tasks",
      undefined,
      "title",
      50,
      0,
      null,
      null,
      read,
    );
    expect(visible.total).toBe(1);
    expect(visible.records[0]?.data).toEqual({ title: "A", status: "open" });
    expect(
      await countRecords(prisma, orgId, "tasks", undefined, null, null, read),
    ).toBe(1);
    await expect(
      queryRecords(
        prisma,
        orgId,
        "tasks",
        { secret: "hidden" },
        undefined,
        50,
        0,
        null,
        null,
        read,
      ),
    ).rejects.toThrow("not allowed");
    await expect(
      aggregateRecords(
        prisma,
        orgId,
        "tasks",
        { metrics: [{ op: "sum", field: "amount" }] },
        null,
        null,
        read,
      ),
    ).rejects.toThrow("not allowed");
    const a = visible.records[0]!.id;
    const b = (await query({ status: "done" })).records[0]!.id;
    expect(
      (await getRecord(prisma, orgId, "tasks", a, null, null, read)).data,
    ).toEqual({ title: "A", status: "open" });
    await expect(
      getRecord(prisma, orgId, "tasks", b, null, null, read),
    ).rejects.toThrow();
    const update = await grants("update");
    await updateRecord(
      prisma,
      orgId,
      "tasks",
      a,
      { title: "Updated" },
      null,
      null,
      update,
    );
    await expect(
      updateRecord(
        prisma,
        orgId,
        "tasks",
        a,
        { status: "done" },
        null,
        null,
        update,
      ),
    ).rejects.toThrow("No grant");
    await expect(
      updateRecord(
        prisma,
        orgId,
        "tasks",
        a,
        { secret: "changed" },
        null,
        null,
        update,
      ),
    ).rejects.toThrow();
    const create = await grants("create");
    await insertRecord(
      prisma,
      orgId,
      "tasks",
      { title: "New", status: "open" },
      "reader",
      null,
      create,
    );
    await expect(
      insertRecord(
        prisma,
        orgId,
        "tasks",
        { title: "Denied", status: "done" },
        "reader",
        null,
        create,
      ),
    ).rejects.toThrow("No grant");
    const remove = await grants("delete");
    await expect(
      deleteRecord(prisma, orgId, "tasks", b, null, remove),
    ).rejects.toThrow();
    await deleteRecord(prisma, orgId, "tasks", a, null, remove);
    expect(
      await countRecords(prisma, orgId, "tasks", { title: "Updated" }),
    ).toBe(0);
  });

  test("negated grants never expose records with missing or null fields", async () => {
    const { prisma, orgId, collection } = await fixture();
    await addPolicy(prisma, orgId, "reader", "/collections/tasks", "read", {
      where: { not: { status: "open" } },
      fields: ["title"],
    });
    const grants = await resolveRecordGrants(
      prisma,
      { orgId, userId: "reader", userEmail: "" },
      collection.id,
      "/collections/tasks",
      "read",
    );
    const result = await queryRecords(
      prisma,
      orgId,
      "tasks",
      undefined,
      "title",
      50,
      0,
      null,
      null,
      grants,
    );
    expect(titles(result)).toEqual(["B"]);
  });

  test("recurrence expansion retains the shared behavior", async () => {
    const { insert, query } = await fixture();
    await insert({
      title: "Recurring",
      status: "open",
      schedule: "DTSTART;TZID=UTC:20260901T090000\nRRULE:FREQ=DAILY;COUNT=3",
    });
    const result = await query({
      status: "open",
      schedule: {
        occurs_between: ["2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z"],
      },
    });
    expect(titles(result)).toEqual(["Recurring"]);
    expect(result.records[0]?.occurrences).toEqual([
      "2026-09-02T09:00:00.000Z",
    ]);
  });

  test("schema edits reject type changes and removed-field reuse without modifying records", async () => {
    const { prisma, orgId, collection } = await fixture();
    const before = await prisma.record.findMany({
      where: { orgId },
      orderBy: { id: "asc" },
    });
    await expect(
      updateCollectionSchema(prisma, orgId, "tasks", undefined, undefined, {
        amount: { type: "string" },
      }),
    ).rejects.toThrow("unsupported");
    await expect(
      updateCollectionSchema(prisma, orgId, "tasks", { amount: "string" }),
    ).rejects.toThrow("unsupported");
    await expect(
      updateCollectionSchema(prisma, orgId, "tasks", { amount: "string" }, [
        "amount",
      ]),
    ).rejects.toThrow("unsupported");
    expect(
      (
        await prisma.collection.findUniqueOrThrow({
          where: { id: collection.id },
        })
      ).schema,
    ).toEqual(schema);
    await updateCollectionSchema(prisma, orgId, "tasks", undefined, undefined, {
      amount: { type: "number", description: "Total" },
    });
    await updateCollectionSchema(prisma, orgId, "tasks", undefined, ["amount"]);
    await expect(
      updateCollectionSchema(prisma, orgId, "tasks", { amount: "string" }),
    ).rejects.toThrow("reusing a removed field");
    await updateCollectionSchema(prisma, orgId, "tasks", {
      newField: "integer",
    });
    expect(
      await prisma.record.findMany({
        where: { orgId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
  });

  if (provider === "postgresql") {
    test("deployment creates a GIN index usable by native equality queries", async () => {
      const { prisma, orgId, collection } = await fixture();
      const indexes = await prisma.$queryRawUnsafe<Array<{ indexdef: string }>>(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'records_data_gin_idx'",
      );
      expect(indexes[0]?.indexdef).toContain("USING gin (data jsonb_path_ops)");
      const where = compileWhere({ status: "open" }, schema, provider);
      // A tiny test table normally favors a sequential scan. Disable only that
      // plan locally to prove the generated predicate can use the actual index.
      const plan = await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
        return queryRows(
          tx,
          provider,
          sql`EXPLAIN (FORMAT JSON) SELECT id FROM records WHERE ${where.expression}`,
        );
      });
      expect(JSON.stringify(plan)).toContain("records_data_gin_idx");
      expect(
        (await queryRecords(prisma, orgId, "tasks", { status: "open" })).total,
      ).toBe(1);
      expect(collection.id).toBeTruthy();
    });
  }
});
