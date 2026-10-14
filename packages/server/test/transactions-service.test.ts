import { registerDatabaseProvider } from "../src/db/provider";
import { jobsFor } from "../src/jobs";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TransactionRequest, TransactionResult } from "@lastsaas/shared";
import { addPolicy, removePolicy } from "../src/db/casbin";
import { createTransactionService } from "../src/transactions/service";
import { testMigrationSql } from "./test-migrations";

const postgresUrl = process.env.TRANSACTION_TEST_DATABASE_URL;
const provider = postgresUrl ? "postgresql" : "sqlite";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-transactions-"));
  const path = join(directory, "test.db");
  if (!postgresUrl) {
    const database = new Database(path);
    database.exec(testMigrationSql);
    database.close();
  }
  const url = postgresUrl ?? `file:${path}`;
  const prisma = new PrismaClient({ datasourceUrl: url });
  registerDatabaseProvider(prisma, url);
  const orgId = crypto.randomUUID();
  const foreignId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const context = { orgId, userId, userEmail: `${userId}@example.com` };
  cleanups.push(async () => {
    try {
      await prisma.organization.deleteMany({
        where: { id: { in: [orgId, foreignId] } },
      });
      await prisma.user.deleteMany({ where: { id: userId } });
    } finally {
      await jobsFor(prisma)?.close();
      await prisma.$disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await prisma.user.create({
    data: { id: userId, name: "Worker", email: context.userEmail },
  });
  await prisma.organization.createMany({
    data: [orgId, foreignId].map((id) => ({ id, name: "Org", slug: id })),
  });
  await prisma.member.create({
    data: {
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId,
      role: "member",
    },
  });
  const collection = await prisma.collection.create({
    data: {
      id: crypto.randomUUID(),
      orgId,
      name: "tasks",
      schema: {
        title: "string",
        owner: "string",
        meta: "json",
        secret: "string",
      },
    },
  });
  const queue = await prisma.queue.create({
    data: {
      id: crypto.randomUUID(),
      orgId,
      name: "jobs",
      schema: { title: "string" },
    },
  });
  const grant = (resource: string, action: string, options = {}) =>
    addPolicy(prisma, orgId, userId, resource, action, options);
  for (const action of ["create", "update", "delete", "read"])
    await grant("/collections/tasks", action);
  await grant("/queues/jobs", "create");
  await prisma.collection.create({
    data: {
      id: crypto.randomUUID(),
      orgId,
      name: "notes",
      schema: { title: "string" },
    },
  });
  await grant("/collections/notes", "create");
  await grant("/collections/notes", "read");
  const service = createTransactionService(prisma, provider);
  const execute = (input: TransactionRequest) =>
    service.execute(context, input);
  const counts = async () => ({
    records: await prisma.record.count({ where: { orgId } }),
    entries: await prisma.queueEntry.count({ where: { queueId: queue.id } }),
    audits: await prisma.auditLog.count({ where: { orgId } }),
    requests: await prisma.transactionRequest.count({ where: { orgId } }),
  });
  return {
    prisma,
    context,
    collection,
    queue,
    foreignId,
    url,
    grant,
    service,
    execute,
    counts,
  };
}

const create = {
  op: "record.create",
  collection: "tasks",
  data: { title: "Work", owner: "me", secret: "private" },
} as const;
const note = {
  op: "record.create",
  collection: "notes",
  data: { title: "Note" },
} as const;
function createdId(result: TransactionResult) {
  const operation = result.results[0]!;
  if (operation.op !== "record.create")
    throw new Error("Expected record create");
  return operation.record.id;
}

describe(`bounded transactions (${provider})`, () => {
  test("cross-collection writes commit in order with metadata-only transactional audits", async () => {
    const { execute, counts, prisma, context } = await fixture();
    const result = await execute({ operations: [create, note] });
    expect(result.results.map((r) => r.op)).toEqual([
      "record.create",
      "record.create",
    ]);
    expect(await counts()).toEqual({
      records: 2,
      entries: 0,

      audits: 2,
      requests: 0,
    });
    const audits = await prisma.auditLog.findMany({
      where: { orgId: context.orgId },
    });
    expect(JSON.stringify(audits)).not.toContain("private");
    expect(JSON.stringify(audits)).not.toContain('"payload"');
  });

  test("a later schema failure rolls back record writes, audits and dedup results", async () => {
    const { execute, counts } = await fixture();
    await expect(
      execute({
        idempotency_key: "invalid",
        operations: [create, note, { ...create, data: { title: 1 } }],
      }),
    ).rejects.toThrow("Schema validation");
    expect(await counts()).toEqual({
      records: 0,
      entries: 0,

      audits: 0,
      requests: 0,
    });
  });

  test("a denied operation rolls back preceding record writes", async () => {
    const { execute, counts, prisma, context } = await fixture();
    await prisma.collection.create({
      data: {
        id: crypto.randomUUID(),
        orgId: context.orgId,
        name: "other",
        schema: { title: "string" },
      },
    });
    await expect(
      execute({
        operations: [create, note, { ...note, collection: "other" }],
      }),
    ).rejects.toThrow("Permission denied");
    expect((await counts()).audits).toBe(0);
    expect((await counts()).records).toBe(0);
    expect((await counts()).entries).toBe(0);
  });

  test("update and delete preserve row/field restrictions and rollback previous changes", async () => {
    const { prisma, context, execute, counts, grant } = await fixture();
    const id = createdId(await execute({ operations: [create] }));
    await removePolicy(
      prisma,
      context.orgId,
      context.userId,
      "/collections/tasks",
      "update",
    );
    await grant("/collections/tasks", "update", {
      where: { owner: "me" },
      fields: ["title"],
    });
    const updated = await execute({
      operations: [
        {
          op: "record.update",
          collection: "tasks",
          id,
          data: { title: "Allowed" },
        },
      ],
    });
    expect(updated.results[0]).toMatchObject({
      record: { data: { title: "Allowed" } },
    });
    const before = await counts();
    await expect(
      execute({
        operations: [
          {
            op: "record.update",
            collection: "tasks",
            id,
            data: { title: "Rolled back" },
          },
          {
            op: "record.update",
            collection: "tasks",
            id,
            data: { owner: "other" },
          },
        ],
      }),
    ).rejects.toThrow();
    expect(await counts()).toEqual(before);
    expect(
      (await prisma.record.findUniqueOrThrow({ where: { id } })).data,
    ).toMatchObject({ title: "Allowed" });
    await execute({
      operations: [{ op: "record.delete", collection: "tasks", id }],
    });
    expect((await counts()).records).toBe(0);
  });

  test("create restrictions are checked for each operation", async () => {
    const { prisma, context, execute, grant, counts } = await fixture();
    await removePolicy(
      prisma,
      context.orgId,
      context.userId,
      "/collections/tasks",
      "create",
    );
    await grant("/collections/tasks", "create", {
      where: { owner: "me" },
      fields: ["title", "owner"],
    });
    await expect(execute({ operations: [create] })).rejects.toThrow("secret");
    await expect(
      execute({ operations: [{ ...create, data: { owner: "other" } }] }),
    ).rejects.toThrow("No grant");
    await removePolicy(
      prisma,
      context.orgId,
      context.userId,
      "/collections/notes",
      "create",
    );
    await expect(
      execute({ operations: [{ ...create, data: { owner: "me" } }, note] }),
    ).rejects.toMatchObject({ code: "PermissionDeniedError" });
    expect((await counts()).records).toBe(0);
  });

  test("foreign record IDs, collections and nonmembers cannot cross organization scope", async () => {
    const { prisma, context, foreignId, collection, execute, service, counts } =
      await fixture();
    const foreignCollection = await prisma.collection.create({
      data: {
        id: crypto.randomUUID(),
        orgId: foreignId,
        name: "tasks",
        schema: collection.schema as { title: string },
      },
    });
    const foreign = await prisma.record.create({
      data: {
        id: crypto.randomUUID(),
        orgId: foreignId,
        collectionId: foreignCollection.id,
        data: { title: "foreign" },
      },
    });
    await prisma.collection.create({
      data: {
        id: crypto.randomUUID(),
        orgId: foreignId,
        name: "foreignNotes",
        schema: { title: "string" },
      },
    });
    for (const op of ["record.update", "record.delete"] as const) {
      await expect(
        execute({
          operations: [
            create,
            {
              op,
              collection: "tasks",
              id: foreign.id,
              ...(op === "record.update" ? { data: {} } : {}),
            } as TransactionRequest["operations"][number],
          ],
        }),
      ).rejects.toThrow("not found");
    }
    await expect(
      execute({
        operations: [create, { ...note, collection: "foreignNotes" }],
      }),
    ).rejects.toThrow("not found");
    await expect(
      service.execute(
        { ...context, orgId: foreignId },
        { operations: [create] },
      ),
    ).rejects.toThrow("not found");
    expect((await counts()).records).toBe(0);
  });

  test("operation and byte bounds and result references reject before persistence", async () => {
    const { execute, counts } = await fixture();
    for (const input of [
      { operations: [] },
      { operations: Array.from({ length: 26 }, () => create) },
      { operations: [{ ...create, data: { title: "é".repeat(530_000) } }] },
      {
        operations: [
          {
            op: "record.update",
            collection: "tasks",
            id: { result: 0 },
            data: {},
          },
        ],
      },
      { operations: [create], orgId: "foreign" },
      { operations: [{ op: "sql", query: "DELETE FROM records" }] },
      {
        operations: [
          create,
          { op: "queue.enqueue", queue: "jobs", entry: { payload: {} } },
        ],
      },
    ])
      await expect(execute(input as TransactionRequest)).rejects.toThrow(
        "Invalid transaction request",
      );
    const result = await execute({
      operations: [{ ...create, data: { title: "$results[0].id" } }],
    });
    expect(result.results[0]).toMatchObject({
      record: { data: { title: "$results[0].id" } },
    });
    expect((await counts()).records).toBe(1);
  });

  test("canonical retries return the original response without repeated writes; conflicts are 409", async () => {
    const { execute, counts, prisma, context } = await fixture();
    const request: TransactionRequest = {
      idempotency_key: "retry",
      operations: [create, note],
    };
    const first = await execute(request);
    const before = await counts();
    const second = await execute({
      ...request,
      operations: [
        { ...create, data: { secret: "private", owner: "me", title: "Work" } },
        note,
      ],
    });
    expect(second).toEqual(first);
    expect(await counts()).toEqual(before);
    const row = await prisma.transactionRequest.findFirstOrThrow({
      where: { orgId: context.orgId },
    });
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(
      7 * 24 * 60 * 60 * 1000,
    );
    try {
      await execute({ ...request, operations: [note, create] });
      throw new Error("Expected conflict");
    } catch (error) {
      expect(error).toMatchObject({ code: "AutomationConflictError" });
    }
    expect(await counts()).toEqual(before);
  });

  test("replay rechecks current membership, row grants and field projection using full saved snapshots", async () => {
    const { prisma, context, execute, grant, counts } = await fixture();
    const request = { idempotency_key: "visible", operations: [create] };
    await execute(request);
    const before = await counts();
    await removePolicy(
      prisma,
      context.orgId,
      context.userId,
      "/collections/tasks",
      "read",
    );
    await grant("/collections/tasks", "read", {
      where: { owner: "me" },
      fields: ["title"],
    });
    const replay = await execute(request);
    expect(replay.results[0]).toMatchObject({
      record: { data: { title: "Work" } },
    });
    await removePolicy(
      prisma,
      context.orgId,
      context.userId,
      "/collections/tasks",
      "read",
      { where: { owner: "me" }, fields: ["title"] },
    );
    await grant("/collections/tasks", "read", { where: { owner: "other" } });
    await expect(execute(request)).rejects.toThrow("Permission denied");
    expect(await counts()).toEqual(before);
    await prisma.member.deleteMany({
      where: { organizationId: context.orgId },
    });
    await expect(execute(request)).rejects.toThrow("not found");
  });

  test("delete replay evaluates original metadata", async () => {
    const { prisma, context, execute, grant, counts } = await fixture();
    const id = createdId(await execute({ operations: [create] }));
    const request: TransactionRequest = {
      idempotency_key: "deleted",
      operations: [{ op: "record.delete", collection: "tasks", id }, note],
    };
    const result = await execute(request);
    const before = await counts();
    await removePolicy(
      prisma,
      context.orgId,
      context.userId,
      "/collections/tasks",
      "delete",
    );
    await grant("/collections/tasks", "delete", {
      where: { created_by: context.userId },
    });
    expect(await execute(request)).toEqual(result);
    await removePolicy(
      prisma,
      context.orgId,
      context.userId,
      "/collections/tasks",
      "delete",
      { where: { created_by: context.userId } },
    );
    await expect(execute(request)).rejects.toThrow("Permission denied");
    expect(await counts()).toEqual(before);
  });

  test("expiry permits key reuse while principal scopes stay independent", async () => {
    const { execute, counts, prisma, context } = await fixture();
    const request = { idempotency_key: "expiry", operations: [create] };
    const first = await execute(request);
    await prisma.transactionRequest.updateMany({
      where: { orgId: context.orgId },
      data: { expiresAt: new Date(0) },
    });
    const second = await execute(request);
    expect(createdId(second)).not.toBe(createdId(first));
    expect((await counts()).requests).toBe(1);
    // A foreign principal's saved key cannot conflict or supply our response.
    await prisma.transactionRequest.updateMany({
      where: { orgId: context.orgId },
      data: { principalId: "other" },
    });
    await execute({ ...request, operations: [note] });
    expect((await counts()).requests).toBe(2);
  });

  test("independent clients racing one key execute once and replay the same response", async () => {
    const { prisma, url, context, execute, counts } = await fixture();
    const other = new PrismaClient({ datasourceUrl: url });
    cleanups.push(() => other.$disconnect());
    const second = createTransactionService(other, provider);
    const request = { idempotency_key: "race", operations: [create, note] };
    const results = await Promise.all([
      execute(request),
      second.execute(context, request),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await counts()).toEqual({
      records: 2,
      entries: 0,

      audits: 2,
      requests: 1,
    });
    expect(
      await prisma.transactionRequest.count({
        where: { orgId: context.orgId },
      }),
    ).toBe(1);
  });
});
