import { jobsFor } from "../src/jobs";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { TriggerCreate } from "@lastsaas/shared";
import { addPolicy, removePolicy } from "../src/db/casbin";
import { createAuditWriter } from "../src/db/audit";
import { registerDatabaseProvider } from "../src/db/provider";
import {
  insertRecord,
  insertRecords,
  updateRecord,
  deleteRecord,
  insertRecordInTransaction,
} from "../src/db/records";
import { withUnitOfWork } from "../src/db/unit-of-work";
import { executeRecordTriggers } from "../src/triggers/execute";
import { createTriggerService } from "../src/triggers/service";
import { createTransactionService } from "../src/transactions/service";
import { registerDataTools } from "../src/mcp/tools/data";
import { recordsRouter } from "../src/routes/records";
import { loadConfig } from "../src/config";
import type { AppEnvironment } from "../src/env";
import type { AppServices } from "../src/services";
import { testMigrationSql } from "./test-migrations";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-trigger-execute-"));
  const url = `file:${join(directory, "test.db")}`;
  const database = new Database(url.slice(5));
  database.exec(testMigrationSql);
  database.close();
  const prisma = new PrismaClient({ datasourceUrl: url });
  registerDatabaseProvider(prisma, url);
  cleanups.push(async () => {
    await jobsFor(prisma)?.close();
    await prisma.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  });
  const context = {
    orgId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    userEmail: `${crypto.randomUUID()}@example.com`,
  };
  await prisma.user.create({
    data: { id: context.userId, email: context.userEmail, name: "Creator" },
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
  const collection = await prisma.collection.create({
    data: {
      id: crypto.randomUUID(),
      orgId: context.orgId,
      name: "tasks",
      schema: {
        title: "string",
        private: "string",
        owner: "string",
        details: "json",
        id: "string",
      },
    },
  });
  const queue = await prisma.queue.create({
    data: {
      id: crypto.randomUUID(),
      orgId: context.orgId,
      name: "jobs",
      schema: {
        value: "string",
        previous: "string",
        event: "string",
        at: "datetime",
        record: "string",
        collection: "string",
      },
    },
  });
  const grant = (resource: string, action: string, options = {}) =>
    addPolicy(prisma, context.orgId, context.userId, resource, action, options);
  await grant("/triggers", "write");
  for (const action of ["read", "create", "update", "delete"])
    await grant("/collections/tasks", action);
  await grant("/queues/jobs", "create");
  const triggers = createTriggerService(prisma, "sqlite");
  const rule: TriggerCreate = {
    collection: "tasks",
    queue: "jobs",
    events: ["create"],
    mapping: { value: { kind: "after", field: "title" } },
    enabled: true,
  };
  const entries = () =>
    prisma.queueEntry.findMany({
      where: { queueId: queue.id },
      orderBy: { createdAt: "asc" },
    });
  const create = (data: Record<string, unknown>) =>
    insertRecord(prisma, context.orgId, "tasks", data, context.userId);
  const update = (id: string, data: Record<string, unknown>) =>
    updateRecord(prisma, context.orgId, "tasks", id, data);
  return {
    prisma,
    url,
    context,
    collection,
    queue,
    grant,
    triggers,
    rule,
    entries,
    create,
    update,
  };
}

describe("transactional collection trigger publication", () => {
  test("all mutation wrappers publish event-specific mappings; batch preserves partial validation", async () => {
    const f = await fixture();
    await f.triggers.create(f.context, f.rule);
    await f.triggers.create(f.context, {
      ...f.rule,
      events: ["update"],
      watched_fields: ["title"],
      where: { title: "After" },
      mapping: {
        value: { kind: "after", field: "title" },
        previous: { kind: "before", field: "title" },
      },
    });
    await f.triggers.create(f.context, {
      ...f.rule,
      events: ["delete"],
      where: { title: "After" },
      mapping: {
        value: { kind: "before", field: "title" },
        event: { kind: "metadata", key: "event" },
        at: { kind: "metadata", key: "occurredAt" },
        record: { kind: "metadata", key: "recordId" },
        collection: { kind: "metadata", key: "collectionName" },
      },
    });
    const row = await f.create({
      title: "Before",
      private: "DO NOT PUBLISH",
      details: { a: 1, b: 2 },
    });
    await f.update(row.id, { title: "Before", details: { b: 2, a: 1 } });
    await f.update(row.id, { private: "changed" });
    await f.update(row.id, { title: "After" });
    await deleteRecord(f.prisma, f.context.orgId, "tasks", row.id);
    const batch = await insertRecords(f.prisma, f.context.orgId, "tasks", [
      { title: "A" },
      { title: 1 },
      { title: "B" },
    ]);
    expect(batch.inserted).toBe(2);
    expect(batch.errors).toHaveLength(1);
    const entries = await f.entries();
    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.payload)).toEqual([
      { value: "Before" },
      { value: "After", previous: "Before" },
      {
        value: "After",
        event: "delete",
        record: row.id,
        collection: "tasks",
        at: expect.stringMatching(/Z$/),
      },
      { value: "A" },
      { value: "B" },
    ]);
    expect(
      entries.every((entry) => entry.producerUserId === f.context.userId),
    ).toBe(true);
    expect(await f.prisma.queueEntry.count()).toBe(5);
    expect(JSON.stringify(await f.prisma.auditLog.findMany())).not.toContain(
      "DO NOT PUBLISH",
    );
  });

  test("unwatched updates use actual deep changes and predicates use after", async () => {
    const f = await fixture();
    const record = await f.create({
      title: "Before",
      details: { a: 1, b: [1, 2] },
    });
    await f.triggers.create(f.context, {
      ...f.rule,
      events: ["update"],
      where: { title: "After" },
    });
    await f.update(record.id, { details: { b: [1, 2], a: 1 } });
    await f.update(record.id, { private: "changed" });
    expect(await f.entries()).toHaveLength(0);
    await f.update(record.id, { title: "After" });
    await f.update(record.id, { details: { a: 1, b: [2, 1] } });
    expect(await f.entries()).toHaveLength(2);
  });

  test("source row and field grants apply independently to before and after snapshots", async () => {
    const f = await fixture();
    await removePolicy(
      f.prisma,
      f.context.orgId,
      f.context.userId,
      "/collections/tasks",
      "read",
    );
    await f.grant("/collections/tasks", "read", {
      where: { owner: "$user.id" },
      fields: ["title"],
    });
    const trigger = await f.triggers.create(f.context, {
      ...f.rule,
      events: ["update"],
      mapping: { previous: { kind: "before", field: "title" } },
    });
    const record = await f.create({ title: "Hidden earlier", owner: "other" });
    await f.update(record.id, {
      title: "Visible now",
      owner: f.context.userId,
    });
    expect(await f.entries()).toHaveLength(0);
    await f.update(record.id, { title: "Still visible" });
    expect((await f.entries()).map((entry) => entry.payload)).toEqual([
      { previous: "Visible now" },
    ]);
    expect(
      (
        await f.prisma.collectionTrigger.findUniqueOrThrow({
          where: { id: trigger.id },
        })
      ).status,
    ).toBe("active");
  });

  test("native record metadata predicates and deleted-row read constraints use exact snapshots", async () => {
    const f = await fixture();
    await removePolicy(
      f.prisma,
      f.context.orgId,
      f.context.userId,
      "/collections/tasks",
      "read",
    );
    await f.grant("/collections/tasks", "read", {
      where: { created_by: "$user.id" },
      fields: ["title"],
    });
    await f.triggers.create(f.context, {
      ...f.rule,
      events: ["create", "delete"],
      where: { created_by: "$user.id" },
      mapping: { event: { kind: "metadata", key: "event" } },
    });
    const foreign = await insertRecord(
      f.prisma,
      f.context.orgId,
      "tasks",
      { title: "Other" },
      "other",
    );
    await deleteRecord(f.prisma, f.context.orgId, "tasks", foreign.id);
    const owned = await f.create({ title: "Owned" });
    await deleteRecord(f.prisma, f.context.orgId, "tasks", owned.id);
    expect((await f.entries()).map((entry) => entry.payload)).toEqual([
      { event: "create" },
      { event: "delete" },
    ]);
  });

  for (const revocation of [
    "membership",
    "source",
    "destination",
    "mapped",
    "watched",
    "predicate",
    "schema",
    "disabled",
  ] as const)
    test(`${revocation} invalidation pauses with redacted audit while source mutation commits`, async () => {
      const f = await fixture();
      const trigger = await f.triggers.create(f.context, {
        ...f.rule,
        events: ["update"],
        watched_fields: ["private"],
        where: { owner: "allowed" },
      });
      const row = await f.create({
        title: "SENSITIVE",
        owner: "allowed",
        private: "before",
      });
      if (revocation === "membership")
        await f.prisma.member.deleteMany({
          where: { organizationId: f.context.orgId },
        });
      if (revocation === "source")
        await removePolicy(
          f.prisma,
          f.context.orgId,
          f.context.userId,
          "/collections/tasks",
          "read",
        );
      if (revocation === "destination")
        await removePolicy(
          f.prisma,
          f.context.orgId,
          f.context.userId,
          "/queues/jobs",
          "create",
        );
      if (["mapped", "watched", "predicate"].includes(revocation)) {
        await removePolicy(
          f.prisma,
          f.context.orgId,
          f.context.userId,
          "/collections/tasks",
          "read",
        );
        const excluded = {
          mapped: "title",
          watched: "private",
          predicate: "owner",
        }[revocation as "mapped" | "watched" | "predicate"];
        await f.grant("/collections/tasks", "read", {
          fields: ["title", "private", "owner"].filter(
            (field) => field !== excluded,
          ),
        });
      }
      if (revocation === "schema")
        await f.prisma.queue.update({
          where: { id: f.queue.id },
          data: { schema: { value: "integer" } },
        });
      if (revocation === "disabled")
        await f.prisma.queue.update({
          where: { id: f.queue.id },
          data: { enabled: false },
        });
      await f.update(row.id, { private: "SENSITIVE after" });
      expect(
        (await f.prisma.record.findUniqueOrThrow({ where: { id: row.id } }))
          .data,
      ).toHaveProperty("private", "SENSITIVE after");
      expect(await f.entries()).toHaveLength(0);
      expect(
        await f.prisma.collectionTrigger.findUniqueOrThrow({
          where: { id: trigger.id },
        }),
      ).toMatchObject({ status: "paused", pauseReason: expect.any(String) });
      const audits = await f.prisma.auditLog.findMany({
        where: { action: "pause_trigger" },
      });
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits)).not.toContain("SENSITIVE");
      await f.update(row.id, { private: "Another change" });
      expect(
        await f.prisma.auditLog.count({ where: { action: "pause_trigger" } }),
      ).toBe(1);
    });

  test("duplicate publisher invocation and transaction retry enqueue once", async () => {
    const f = await fixture();
    await f.triggers.create(f.context, f.rule);
    await withUnitOfWork(
      { prisma: f.prisma, provider: "sqlite" },
      async (unit) => {
        const result = await insertRecordInTransaction(
          unit,
          f.context.orgId,
          "tasks",
          { title: "One" },
          f.context.userId,
        );
        const row = await unit.db.record.findUniqueOrThrow({
          where: { id: result.record.id },
        });
        await executeRecordTriggers(unit, f.context.orgId, result.mutation, {
          before: null,
          after: row,
        });
      },
    );
    const transactions = createTransactionService(f.prisma, "sqlite");
    const request = {
      idempotency_key: "retry",
      operations: [
        {
          op: "record.create" as const,
          collection: "tasks",
          data: { title: "Two" },
        },
      ],
    };
    const first = await transactions.execute(f.context, request);
    expect(await transactions.execute(f.context, request)).toEqual(first);
    expect(await f.entries()).toHaveLength(2);
    expect(await f.prisma.queueEntry.count()).toBe(2);
    expect(
      await f.prisma.auditLog.count({
        where: { action: "enqueue_queue_entry" },
      }),
    ).toBe(2);
  });

  test("queue persistence errors roll back creates, updates, deletes and partial batches", async () => {
    const f = await fixture();
    const row = await f.create({ title: "Before" });
    await f.triggers.create(f.context, {
      ...f.rule,
      events: ["create", "update", "delete"],
      mapping: { event: { kind: "metadata", key: "event" } },
    });
    // Real SQLite failure after entry insertion, while the native job is being published.
    await f.prisma.$executeRawUnsafe(
      `CREATE TRIGGER reject_trigger_delivery BEFORE INSERT ON job_outbox BEGIN SELECT RAISE(ABORT, 'job publication failed'); END`,
    );
    for (const operation of [
      () => f.create({ title: "After" }),
      () => f.update(row.id, { title: "After" }),
      () => deleteRecord(f.prisma, f.context.orgId, "tasks", row.id),
      () =>
        insertRecords(f.prisma, f.context.orgId, "tasks", [
          { title: "A" },
          { title: 1 },
          { title: "B" },
        ]),
    ]) {
      await expect(operation()).rejects.toThrow();
      expect(await f.prisma.record.count()).toBe(1);
      expect(
        (await f.prisma.record.findUniqueOrThrow({ where: { id: row.id } }))
          .data,
      ).toEqual({ title: "Before" });
      expect(await f.entries()).toHaveLength(0);
      expect(
        await f.prisma.auditLog.count({
          where: { action: "enqueue_queue_entry" },
        }),
      ).toBe(0);
      expect(await f.prisma.collectionTrigger.findFirst()).toHaveProperty(
        "status",
        "active",
      );
    }
  });

  test("a failing later transaction operation rolls back earlier triggered messages", async () => {
    const f = await fixture();
    await f.triggers.create(f.context, f.rule);
    await expect(
      createTransactionService(f.prisma, "sqlite").execute(f.context, {
        operations: [
          {
            op: "record.create",
            collection: "tasks",
            data: { title: "Rollback" },
          },
          {
            op: "record.update",
            collection: "tasks",
            id: "missing",
            data: { title: "Failure" },
          },
        ],
      }),
    ).rejects.toThrow();
    expect(await f.prisma.record.count()).toBe(0);
    expect(await f.entries()).toHaveLength(0);
  });

  test("REST and MCP record mutations reach the same publisher without composition flags", async () => {
    const f = await fixture();
    await f.triggers.create(f.context, f.rule);
    const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: f.url });
    const services = { prisma: f.prisma } as AppServices;
    const app = new Hono<AppEnvironment>();
    app.use("*", async (c, next) => {
      c.set("services", services);
      c.set("config", config);
      c.set("orgId", f.context.orgId);
      c.set("userId", f.context.userId);
      c.set(
        "audit",
        createAuditWriter(f.prisma, f.context.orgId, f.context.userId),
      );
      await next();
    });
    app.route("/collections/:name/records", recordsRouter);
    const response = await app.request(
      "http://test/collections/tasks/records",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { title: "REST" } }),
      },
    );
    expect(response.status).toBe(200);
    const server = new McpServer({ name: "trigger-test", version: "1" });
    const client = new Client({ name: "test", version: "1" });
    registerDataTools(server, { services, config, ...f.context });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "records_insert",
      arguments: { collection: "tasks", data: { title: "MCP" } },
    });
    expect(result.isError).not.toBe(true);
    expect((await f.entries()).map((entry) => entry.payload)).toEqual([
      { value: "REST" },
      { value: "MCP" },
    ]);
  });
});
