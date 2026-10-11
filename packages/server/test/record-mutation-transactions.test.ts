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
  insertRecordsInTransaction,
  updateRecord,
  updateRecordInTransaction,
  deleteRecord,
  deleteRecordInTransaction,
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
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-record-mutate-"));
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
    data: { id: orgId, name: "Mutation test", slug: orgId },
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
        details: "json",
      },
    },
  });
  // Context-taking functions must also work without a registered root client.
  return { prisma, provider, orgId, collection, url };
}

describe(`transaction-composable record mutations (${provider})`, () => {
  test("public update/delete keep their response and grant projection", async () => {
    const source = await fixture();
    registerDatabaseProvider(source.prisma, source.url);
    const record = await insertRecord(source.prisma, source.orgId, "tasks", {
      name: "Before",
      secret: "Internal",
    });
    const updated = await updateRecord(
      source.prisma,
      source.orgId,
      "tasks",
      record.id,
      { name: "After" },
      undefined,
      undefined,
      [{ readable: ["name"], writable: ["name"], checkAfter: true }],
    );
    expect(updated.data).toEqual({ name: "After" });
    expect(updated).not.toHaveProperty("mutation");
    expect(
      await deleteRecord(source.prisma, source.orgId, "tasks", record.id),
    ).toBeUndefined();
    await expect(
      deleteRecord(source.prisma, source.orgId, "tasks", record.id),
    ).rejects.toThrow("not found");
  });

  test("rollback restores existing updated and deleted rows", async () => {
    const source = await fixture();
    const records = await withUnitOfWork(source, (context) =>
      insertRecordsInTransaction(context, source.orgId, "tasks", [
        { name: "Update" },
        { name: "Delete" },
      ]),
    );
    const before = await source.prisma.record.findMany({
      where: { orgId: source.orgId },
      orderBy: { id: "asc" },
    });
    await expect(
      withUnitOfWork(source, async (context) => {
        await updateRecordInTransaction(
          context,
          source.orgId,
          "tasks",
          records.result.ids[0]!,
          { name: "Changed" },
        );
        await deleteRecordInTransaction(
          context,
          source.orgId,
          "tasks",
          records.result.ids[1]!,
        );
        throw new Error("restore");
      }),
    ).rejects.toThrow("restore");
    expect(
      await source.prisma.record.findMany({
        where: { orgId: source.orgId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
  });
});
