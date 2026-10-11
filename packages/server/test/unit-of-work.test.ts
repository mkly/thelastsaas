import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeStatement, queryRows, sql } from "../src/db/query/kysely";
import { withUnitOfWork } from "../src/db/unit-of-work";
import { testMigrationSql } from "./test-migrations";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-unit-of-work-"));
  const path = join(directory, "test.db");
  const database = new Database(path);
  try {
    database.exec(testMigrationSql);
  } finally {
    database.close();
  }
  // Deliberately do not register the root client in the provider WeakMap.
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${path}` } },
  });
  cleanups.push(async () => {
    await prisma.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  });
  return { prisma, provider: "sqlite" as const };
}

describe("unit of work", () => {
  test("commits Prisma and compiled SQL writes on the same connection", async () => {
    const source = fixture();
    const id = crypto.randomUUID();
    const result = await withUnitOfWork(source, async ({ db, provider }) => {
      await db.organization.create({ data: { id, name: "Before", slug: id } });
      expect(
        await queryRows<{ name: string }>(
          db,
          provider,
          sql`SELECT name FROM organization WHERE id = ${id}`,
        ),
      ).toEqual([{ name: "Before" }]);
      expect(
        await executeStatement(
          db,
          provider,
          sql`UPDATE organization SET name = ${"After"} WHERE id = ${id}`,
        ),
      ).toBe(1);
      return db.organization.findUniqueOrThrow({ where: { id } });
    });
    expect(result.name).toBe("After");
    expect(
      await source.prisma.organization.findUnique({ where: { id } }),
    ).toEqual(result);
  });

  test("rolls back both Prisma and compiled SQL writes on failure", async () => {
    const source = fixture();
    const existingId = crypto.randomUUID();
    const newId = crypto.randomUUID();
    await source.prisma.organization.create({
      data: { id: existingId, name: "Original", slug: existingId },
    });
    const failure = new Error("rollback probe");
    await expect(
      withUnitOfWork(source, async ({ db, provider }) => {
        await db.organization.create({
          data: { id: newId, name: "Temporary", slug: newId },
        });
        await executeStatement(
          db,
          provider,
          sql`UPDATE organization SET name = ${"Changed"} WHERE id = ${existingId}`,
        );
        expect(
          (
            await db.organization.findUniqueOrThrow({
              where: { id: existingId },
            })
          ).name,
        ).toBe("Changed");
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(
      await source.prisma.organization.findUnique({ where: { id: newId } }),
    ).toBeNull();
    expect(
      (
        await source.prisma.organization.findUniqueOrThrow({
          where: { id: existingId },
        })
      ).name,
    ).toBe("Original");
  });

  test("nested services reuse context and their writes roll back with the outer service", async () => {
    const source = fixture();
    const id = crypto.randomUUID();
    await expect(
      withUnitOfWork(source, async (outer) => {
        await withUnitOfWork(outer, async (nested) => {
          expect(nested).toBe(outer);
          expect(nested.provider).toBe("sqlite");
          await nested.db.organization.create({
            data: { id, name: "Nested", slug: id },
          });
        });
        expect(await outer.db.organization.count({ where: { id } })).toBe(1);
        throw new Error("outer rollback");
      }),
    ).rejects.toThrow("outer rollback");
    expect(
      await source.prisma.organization.findUnique({ where: { id } }),
    ).toBeNull();
  });

  test("transaction options apply only when the call owns the transaction", async () => {
    const source = fixture();
    const slow = () => new Promise((resolve) => setTimeout(resolve, 200));
    await expect(
      withUnitOfWork(source, slow, { timeout: 50 }),
    ).rejects.toThrow();
    await withUnitOfWork(
      source,
      async (outer) => {
        await withUnitOfWork(outer, slow, { timeout: 50 });
      },
      { timeout: 5_000 },
    );
  });
});
