import { registerDatabaseProvider } from "../src/db/provider";
import { jobsFor } from "../src/jobs";
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduleCreate } from "@lastsaas/shared";
import { addPolicy, removePolicy } from "../src/db/casbin";
import { createScheduleMaterializer } from "../src/schedules/materialize";
import { withUnitOfWork } from "../src/db/unit-of-work";
import { SqliteBackgroundScheduler } from "../src/scheduler";
import type { NotificationQueue } from "../src/notifications/queue";
import { createScheduleService } from "../src/schedules/service";
import { testMigrationSql } from "./test-migrations";

const postgresUrl = process.env.SCHEDULE_TEST_DATABASE_URL;
const provider = postgresUrl ? "postgresql" : "sqlite";
const creator = { orgId: "org", userId: "creator", userEmail: "c@example.com" };
const editor = { orgId: "org", userId: "editor", userEmail: "e@example.com" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-schedules-"));
  const path = join(directory, "test.db");
  const database = postgresUrl ? undefined : new Database(path);
  database?.exec(testMigrationSql);
  const prisma = new PrismaClient({
    datasourceUrl: postgresUrl ?? `file:${path}`,
  });
  registerDatabaseProvider(prisma, postgresUrl ?? `file:${path}`);
  cleanups.push(async () => {
    try {
      await prisma.organization.deleteMany({
        where: { id: { in: ["org", "foreign"] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: ["creator", "editor"] } },
      });
    } finally {
      await jobsFor(prisma)?.close();
      await prisma.$disconnect();
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await prisma.user.createMany({
    data: [
      { id: "creator", name: "Creator", email: creator.userEmail },
      {
        id: "editor",
        name: "Editor",
        email: editor.userEmail,
        kind: "serviceaccount",
      },
    ],
  });
  await prisma.organization.createMany({
    data: [
      { id: "org", name: "Org", slug: "org" },
      { id: "foreign", name: "Foreign", slug: "foreign" },
    ],
  });
  await prisma.member.createMany({
    data: [
      {
        id: "creator-member",
        organizationId: "org",
        userId: "creator",
        role: "member",
      },
      {
        id: "editor-member",
        organizationId: "org",
        userId: "editor",
        role: "member",
      },
    ],
  });
  await prisma.queue.createMany({
    data: [
      {
        id: "jobs",
        orgId: "org",
        name: "jobs",
        schema: { title: "string", owner: "string", email: "string" },
      },
      { id: "other", orgId: "org", name: "other", schema: { title: "string" } },
      {
        id: "foreign-jobs",
        orgId: "foreign",
        name: "foreignJobs",
        schema: { title: "string" },
      },
    ],
  });
  const service = createScheduleService(prisma, provider);
  const grant = (
    userId: string,
    resource: string,
    action: string,
    options = {},
  ) => addPolicy(prisma, "org", userId, resource, action, options);
  await grant("creator", "/schedules", "write");
  await grant("creator", "/queues/jobs", "create");
  const create = (overrides: Partial<ScheduleCreate> = {}) =>
    service.create(creator, { ...once, ...overrides });
  return {
    prisma,
    url: postgresUrl ?? `file:${path}`,
    service,
    grant,
    create,
    materializer: createScheduleMaterializer(prisma, provider),
  };
}
const once: ScheduleCreate = {
  queue: "jobs",
  payload: { title: "private scheduled message" },
  timing: { kind: "once", at: "2030-01-01T00:00:00Z" },
  enabled: true,
};

describe(`schedule materialization (${provider})`, () => {
  test("once publishes one job, completes and replays safely", async () => {
    const { prisma, create, materializer } = await fixture();
    const row = await create();
    expect(await materializer.materialize("2029-12-31T23:59:59Z")).toEqual({
      enqueued: 0,
      paused: 0,
      has_more: false,
    });
    expect(await materializer.materialize("2030-01-01T00:00:00Z")).toEqual({
      enqueued: 1,
      paused: 0,
      has_more: false,
    });
    const published = await prisma.queueScheduleOccurrence.findFirstOrThrow();
    expect(await prisma.queueEntry.count()).toBe(1);
    const entry = await prisma.queueEntry.findFirstOrThrow();
    expect(entry).toMatchObject({
      producerUserId: "creator",
      payload: once.payload,
      availableAt: new Date("2030-01-01T00:00:00Z"),
    });
    expect(
      await prisma.queueSchedule.findUnique({ where: { id: row.id } }),
    ).toMatchObject({
      status: "completed",
      cursorAt: entry.availableAt,
      nextOccurrenceAt: null,
    });
    expect(await materializer.materialize("2030-02-01T00:00:00Z")).toEqual({
      enqueued: 0,
      paused: 0,
      has_more: false,
    });
    const replay = await withUnitOfWork({ prisma, provider }, (unit) =>
      materializer.materializeOccurrence(
        unit,
        row.id,
        entry.availableAt.toISOString(),
      ),
    );
    expect(replay.entry_id).toBe(published.entryId);
    expect(await prisma.queueEntry.count()).toBe(1);
    // Ledger identity outlives entry retention; a replay cannot recreate old work.
    await prisma.queueEntry.deleteMany();
    await withUnitOfWork({ prisma, provider }, (unit) =>
      materializer.materializeOccurrence(
        unit,
        row.id,
        entry.availableAt.toISOString(),
      ),
    );
    expect(await prisma.queueEntry.count()).toBe(0);
  });

  test("recurrence preserves DST and EXDATE and never duplicates missed ticks", async () => {
    const { prisma, create, materializer } = await fixture();
    await create({
      timing: {
        kind: "recurring",
        recurrence:
          "DTSTART;TZID=America/New_York:20300309T090000\nRRULE:FREQ=DAILY;COUNT=4\nEXDATE;TZID=America/New_York:20300311T090000",
      },
    });
    for (const date of [
      "2030-03-09T14:00:00Z",
      "2030-03-10T13:00:00Z",
      "2030-03-12T13:00:00Z",
    ]) {
      expect((await materializer.materialize(date)).enqueued).toBe(1);
    }
    expect(
      (
        await prisma.queueScheduleOccurrence.findMany({
          orderBy: { occurrenceAt: "asc" },
        })
      ).map((row) => row.occurrenceAt.toISOString()),
    ).toEqual([
      "2030-03-09T14:00:00.000Z",
      "2030-03-10T13:00:00.000Z",
      "2030-03-12T13:00:00.000Z",
    ]);
    expect(
      (await materializer.materialize("2030-03-13T00:00:00Z")).enqueued,
    ).toBe(0);
  });

  test("two independent schedulers race without duplicate entries or cursor loss", async () => {
    const { prisma, url, create, materializer } = await fixture();
    await create({
      timing: {
        kind: "recurring",
        recurrence:
          "DTSTART;TZID=UTC:20300101T000000\nRRULE:FREQ=DAILY;COUNT=8",
      },
    });
    const other = new PrismaClient({ datasourceUrl: url });
    registerDatabaseProvider(other, url);
    try {
      const results = await Promise.all([
        materializer.materialize("2030-01-10T00:00:00Z"),
        createScheduleMaterializer(other, provider).materialize(
          "2030-01-10T00:00:00Z",
        ),
      ]);
      expect(results.reduce((sum, r) => sum + r.enqueued, 0)).toBe(1);
      expect(await prisma.queueEntry.count()).toBe(1);
      expect(await prisma.queueScheduleOccurrence.count()).toBe(1);
      expect(await prisma.queueEntry.count()).toBe(1);
    } finally {
      await other.$disconnect();
    }
  });

  test("crash after enqueue rolls back publication, ledger, audits and cursor", async () => {
    const { prisma, create, materializer } = await fixture();
    const row = await create();
    const auditCount = await prisma.auditLog.count();
    await expect(
      withUnitOfWork({ prisma, provider }, async (unit) => {
        await materializer.materializeOccurrence(
          unit,
          row.id,
          "2030-01-01T00:00:00Z",
        );
        throw new Error("simulated crash before commit");
      }),
    ).rejects.toThrow("simulated crash");
    expect(await prisma.queueEntry.count()).toBe(0);
    expect(await prisma.queueEntry.count()).toBe(0);
    expect(await prisma.queueScheduleOccurrence.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(auditCount);
    expect(
      await prisma.queueSchedule.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ status: "active", cursorAt: null });
    expect(
      (await materializer.materialize("2030-01-01T00:00:00Z")).enqueued,
    ).toBe(1);
  });

  test("invalid schema and disabled queues pause", async () => {
    for (const invalid of ["schema", "disabled"] as const) {
      const { prisma, create, materializer } = await fixture();
      await create();
      if (invalid === "schema")
        await prisma.queue.update({
          where: { id: "jobs" },
          data: { schema: { title: "number" } },
        });
      if (invalid === "disabled")
        await prisma.queue.update({
          where: { id: "jobs" },
          data: { enabled: false },
        });
      expect(
        (await materializer.materialize("2030-01-01T00:00:00Z")).paused,
      ).toBe(1);
      expect(await prisma.queueEntry.count()).toBe(0);
      await cleanups.pop()!();
    }
  });

  test("timing edits cannot republish a historical instant after retention", async () => {
    const { prisma, create, grant, service, materializer } = await fixture();
    const row = await create();
    await materializer.materialize("2030-01-01T00:00:00Z");
    await prisma.queueEntry.deleteMany();
    await grant("creator", `/schedules/${row.id}`, "update");
    await service.update(creator, row.id, { timing: once.timing });
    expect(await materializer.materialize("2030-01-01T00:00:00Z")).toEqual({
      enqueued: 0,
      paused: 0,
      has_more: false,
    });
    expect(await prisma.queueEntry.count()).toBe(0);
    expect(await prisma.queueScheduleOccurrence.count()).toBe(1);
  });

  test("invalid instants and noncursor occurrences cannot skip work", async () => {
    const { prisma, create, materializer } = await fixture();
    const row = await create();
    await expect(materializer.materialize("not-a-time")).rejects.toMatchObject({
      code: "SchemaValidationError",
    });
    await expect(
      withUnitOfWork({ prisma, provider }, (unit) =>
        materializer.materializeOccurrence(
          unit,
          row.id,
          "2030-01-02T00:00:00Z",
        ),
      ),
    ).rejects.toMatchObject({ code: "AutomationConflictError" });
    expect(await prisma.queueEntry.count()).toBe(0);
    expect(
      await prisma.queueSchedule.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      cursorAt: null,
      nextOccurrenceAt: new Date("2030-01-01T00:00:00Z"),
    });
  });

  (provider === "sqlite" ? test : test.skip)(
    "scheduler tick publishes general schedules separately from notification consumption",
    async () => {
      const { prisma, create } = await fixture();
      await create();
      await prisma.transactionRequest.create({
        data: {
          id: "expired-receipt",
          orgId: "org",
          principalId: "creator",
          key: "old",
          requestHash: "hash",
          response: { results: [] },
          visibility: [],
          expiresAt: new Date(0),
        },
      });
      let processed = 0;
      const queue = {
        processDue: async () => {
          processed++;
          return 0;
        },
      } as unknown as NotificationQueue;
      const scheduler = new SqliteBackgroundScheduler(prisma, queue);
      expect(await scheduler.flushOnce(new Date("2030-01-01T00:00:00Z"))).toBe(
        1,
      );
      expect(processed).toBe(1);
      expect(await prisma.transactionRequest.count()).toBe(0);
      expect(await prisma.queueEntry.count()).toBe(1);
    },
  );
});

test("missed recurrence publishes once and advances past downtime", async () => {
  const f = await fixture();
  const row = await f.create({
    timing: {
      kind: "recurring",
      recurrence: "DTSTART;TZID=UTC:20300101T000000\nRRULE:FREQ=DAILY",
    },
  });
  expect(
    (await f.materializer.materialize("2030-01-02T00:00:00Z")).enqueued,
  ).toBe(1);
  expect(
    (await f.materializer.materialize("2030-01-02T00:00:00Z")).enqueued,
  ).toBe(0);
  expect(
    (
      await f.prisma.queueSchedule.findUniqueOrThrow({ where: { id: row.id } })
    ).nextOccurrenceAt!.toISOString(),
  ).toBe("2030-01-03T00:00:00.000Z");
  await removePolicy(f.prisma, "org", "creator", "/queues/jobs", "create");
  expect(
    (await f.materializer.materialize("2030-01-03T00:00:00Z")).paused,
  ).toBe(1);
});
