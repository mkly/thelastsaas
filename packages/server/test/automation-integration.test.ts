import { jobsFor } from "../src/jobs";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TransactionRequest } from "@lastsaas/shared";
import { addPolicy, removePolicy } from "../src/db/casbin";
import { registerDatabaseProvider } from "../src/db/provider";
import { insertRecords } from "../src/db/records";
import { createTransactionService } from "../src/transactions/service";
import { createTriggerService } from "../src/triggers/service";
import { testMigrationSql } from "./test-migrations";

const postgresUrl = process.env.AUTOMATION_TEST_DATABASE_URL;
const provider = postgresUrl ? "postgresql" : "sqlite";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-automation-"));
  const path = join(directory, "test.db");
  if (!postgresUrl) {
    const database = new Database(path);
    database.exec(testMigrationSql);
    database.close();
  }
  const url = postgresUrl ?? `file:${path}`;
  const prisma = new PrismaClient({ datasourceUrl: url });
  registerDatabaseProvider(prisma, url);
  const context = {
    orgId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    userEmail: `${crypto.randomUUID()}@example.com`,
  };
  cleanups.push(async () => {
    try {
      await prisma.organization.deleteMany({ where: { id: context.orgId } });
      await prisma.user.deleteMany({ where: { id: context.userId } });
    } finally {
      await jobsFor(prisma)?.close();
      await prisma.$disconnect();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await prisma.user.create({
    data: { id: context.userId, name: "Producer", email: context.userEmail },
  });
  await prisma.organization.create({
    data: { id: context.orgId, name: "Org", slug: context.orgId },
  });
  await prisma.member.create({
    data: {
      id: crypto.randomUUID(),
      organizationId: context.orgId,
      userId: context.userId,
      role: "member",
    },
  });
  await prisma.collection.create({
    data: {
      id: crypto.randomUUID(),
      orgId: context.orgId,
      name: "tasks",
      schema: { title: "string", private: "string" },
    },
  });
  const queue = await prisma.queue.create({
    data: {
      id: crypto.randomUUID(),
      orgId: context.orgId,
      name: "jobs",
      schema: { title: "string", record: "string", event: "string" },
    },
  });
  await prisma.queueSubscription.createMany({
    data: ["primary", "secondary"].map((name) => ({
      id: crypto.randomUUID(),
      queueId: queue.id,
      name,
    })),
  });
  for (const action of ["create", "read"])
    await addPolicy(
      prisma,
      context.orgId,
      context.userId,
      "/collections/tasks",
      action,
    );
  await addPolicy(prisma, context.orgId, context.userId, "/triggers", "write");
  await addPolicy(
    prisma,
    context.orgId,
    context.userId,
    "/queues/jobs",
    "create",
  );
  const trigger = await createTriggerService(prisma, provider).create(context, {
    collection: "tasks",
    queue: "jobs",
    events: ["create"],
    mapping: {
      title: { kind: "after", field: "title" },
      record: { kind: "metadata", key: "recordId" },
      event: { kind: "metadata", key: "event" },
    },
    enabled: true,
  });
  const counts = async () => ({
    records: await prisma.record.count({ where: { orgId: context.orgId } }),
    entries: await prisma.queueEntry.count({ where: { queueId: queue.id } }),
    deliveries: await prisma.queueDelivery.count({
      where: { queueId: queue.id },
    }),
    requests: await prisma.transactionRequest.count({
      where: { orgId: context.orgId },
    }),
    audits: await prisma.auditLog.count({ where: { orgId: context.orgId } }),
  });
  const request: TransactionRequest = {
    idempotency_key: "publication",
    operations: [
      {
        op: "record.create",
        collection: "tasks",
        data: { title: "From record", private: "DO NOT PUBLISH" },
      },
      {
        op: "queue.enqueue",
        queue: "jobs",
        entry: { payload: { title: "Direct" } },
      },
    ],
  };
  const service = createTransactionService(prisma, provider);
  return { prisma, url, context, queue, trigger, counts, request, service };
}

describe(`record/trigger/queue integration (${provider})`, () => {
  test("a later invalid operation rolls back trigger fanout and the retry receipt together", async () => {
    const f = await fixture();
    const before = await f.counts();
    await expect(
      f.service.execute(f.context, {
        ...f.request,
        operations: [
          ...f.request.operations,
          {
            op: "record.create",
            collection: "tasks",
            data: { title: 123 },
          },
        ],
      }),
    ).rejects.toThrow("Schema validation");
    expect(await f.counts()).toEqual(before);
    // A failed request must not reserve the key or strand the trigger's message.
    await f.service.execute(f.context, f.request);
    expect(await f.counts()).toMatchObject({
      records: 1,
      entries: 2,
      deliveries: 4,
      requests: 1,
    });
  });

  test("independent keyed callers commit real trigger fanout once and canonical retries return the same IDs", async () => {
    const f = await fixture();
    const other = new PrismaClient({ datasourceUrl: f.url });
    cleanups.push(() => other.$disconnect());
    const competing = createTransactionService(other, provider);
    const results = await Promise.all([
      f.service.execute(f.context, f.request),
      competing.execute(f.context, f.request),
    ]);
    expect(results[1]).toEqual(results[0]);
    const before = await f.counts();
    expect(before).toMatchObject({
      records: 1,
      entries: 2,
      deliveries: 4,
      requests: 1,
    });
    const created = results[0]!.results[0]!;
    if (created.op !== "record.create")
      throw new Error("Expected record result");
    const entries = await f.prisma.queueEntry.findMany({
      where: { queueId: f.queue.id },
    });
    expect(entries.map((entry) => entry.payload)).toEqual(
      expect.arrayContaining([
        { title: "From record", record: created.record.id, event: "create" },
        { title: "Direct" },
      ]),
    );
    for (const entry of entries) {
      const deliveries = await f.prisma.queueDelivery.findMany({
        where: { entryId: entry.id },
      });
      expect(deliveries).toHaveLength(2);
      expect(
        new Set(deliveries.map((delivery) => delivery.subscriptionId)).size,
      ).toBe(2);
    }
    const canonicalRetry: TransactionRequest = {
      ...f.request,
      operations: [
        {
          op: "record.create",
          collection: "tasks",
          data: { private: "DO NOT PUBLISH", title: "From record" },
        },
        f.request.operations[1]!,
      ],
    };
    expect(await competing.execute(f.context, canonicalRetry)).toEqual(
      results[0],
    );
    await expect(
      competing.execute(f.context, {
        ...f.request,
        operations: [f.request.operations[0]!],
      }),
    ).rejects.toMatchObject({ code: "AutomationConflictError" });
    expect(await f.counts()).toEqual(before);
    expect(JSON.stringify(entries)).not.toContain("DO NOT PUBLISH");
    expect(
      JSON.stringify(
        await f.prisma.auditLog.findMany({ where: { orgId: f.context.orgId } }),
      ),
    ).not.toContain("DO NOT PUBLISH");
  });

  test("partial batches publish only valid rows; revoked trigger grants pause publication while source writes continue", async () => {
    const f = await fixture();
    const batch = (titles: unknown[]) =>
      insertRecords(
        f.prisma,
        f.context.orgId,
        "tasks",
        titles.map((title) => ({ title })),
        f.context.userId,
      );
    const first = await batch(["A", 123, "B"]);
    expect(first).toMatchObject({ inserted: 2, errors: [{ index: 1 }] });
    expect(first.ids).toHaveLength(2);
    expect(await f.counts()).toMatchObject({
      records: 2,
      entries: 2,
      deliveries: 4,
      requests: 0,
    });
    const entries = await f.prisma.queueEntry.findMany({
      where: { queueId: f.queue.id },
    });
    expect(entries.map((entry) => entry.payload)).toEqual(
      expect.arrayContaining([
        { title: "A", record: first.ids[0], event: "create" },
        { title: "B", record: first.ids[1], event: "create" },
      ]),
    );
    await removePolicy(
      f.prisma,
      f.context.orgId,
      f.context.userId,
      "/queues/jobs",
      "create",
    );
    expect(await batch(["C", false, "D"])).toMatchObject({
      inserted: 2,
      errors: [{ index: 1 }],
    });
    expect(await f.counts()).toMatchObject({
      records: 4,
      entries: 2,
      deliveries: 4,
      requests: 0,
    });
    expect(
      await f.prisma.collectionTrigger.findUniqueOrThrow({
        where: { id: f.trigger.id },
      }),
    ).toMatchObject({ status: "paused", pauseReason: expect.any(String) });
    expect(
      await f.prisma.auditLog.count({
        where: { orgId: f.context.orgId, action: "pause_trigger" },
      }),
    ).toBe(1);
    await batch(["E"]);
    expect(await f.counts()).toMatchObject({
      records: 5,
      entries: 2,
      deliveries: 4,
    });
  });
});
