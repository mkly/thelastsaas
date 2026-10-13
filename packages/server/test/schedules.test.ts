import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduleCreate, ScheduleUpdate } from "@lastsaas/shared";
import { addPolicy, removePolicy } from "../src/db/casbin";
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
  cleanups.push(async () => {
    try {
      await prisma.organization.deleteMany({
        where: { id: { in: ["org", "foreign"] } },
      });
      await prisma.user.deleteMany({
        where: { id: { in: ["creator", "editor"] } },
      });
    } finally {
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
  return { prisma, service, grant, create };
}
const once: ScheduleCreate = {
  queue: "jobs",
  payload: { title: "private scheduled message" },
  timing: { kind: "once", at: "2030-01-01T00:00:00Z" },
  enabled: true,
};
const recurring: ScheduleCreate["timing"] = {
  kind: "recurring",
  recurrence:
    "DTSTART;TZID=America/New_York:20300309T090000\nRRULE:FREQ=DAILY;COUNT=3\nEXDATE;TZID=America/New_York:20300309T090000",
};

describe(`schedule management (${provider})`, () => {
  test("once CRUD persists UTC timing and creator, audits metadata, never enqueues", async () => {
    const { prisma, service, grant, create } = await fixture();
    const row = await create();
    expect(row).toMatchObject({
      created_by: "creator",
      queue_id: "jobs",
      status: "active",
      cursor_at: null,
      timezone: null,
      next_occurrence_at: "2030-01-01T00:00:00.000Z",
      pause_reason: null,
    });
    expect(row.timing).toEqual({
      kind: "once",
      at: "2030-01-01T00:00:00.000Z",
    });
    // Creation does not implicitly grant read, update or delete.
    for (const run of [
      () => service.show(creator, row.id),
      () => service.update(creator, row.id, { enabled: false }),
      () => service.delete(creator, row.id),
    ])
      await expect(run()).rejects.toMatchObject({
        code: "PermissionDeniedError",
      });
    await grant("creator", `/schedules/${row.id}`, "read");
    await grant("creator", `/schedules/${row.id}`, "update");
    await grant("creator", `/schedules/${row.id}`, "delete");
    expect(await service.show(creator, row.id)).toEqual(row);
    expect(
      (
        await service.update(creator, row.id, {
          payload: { title: "edited private message" },
        })
      ).created_by,
    ).toBe("creator");
    await service.delete(creator, row.id);
    expect(await prisma.queueSchedule.count()).toBe(0);
    expect(await prisma.queueEntry.count()).toBe(0);
    expect(await prisma.queueEntry.count()).toBe(0);
    const audits = await prisma.auditLog.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(audits.map((a) => a.action)).toEqual([
      "create_schedule",
      "update_schedule",
      "delete_schedule",
    ]);
    expect(JSON.stringify(audits)).not.toContain("private");
  });

  test("deep recurrence validation preserves local timezone, DST, EXDATE and past catch-up", async () => {
    const { create } = await fixture();
    const row = await create({ timing: recurring });
    expect(row.timezone).toBe("America/New_York");
    expect(row.next_occurrence_at).toBe("2030-03-10T13:00:00.000Z");
    expect(row.timing).toEqual(recurring);
    expect(
      (await create({ timing: { kind: "once", at: "2020-01-01T00:00:00Z" } }))
        .status,
    ).toBe("active");
    const invalid: unknown[] = [
      { kind: "once", at: "2030-02-30T00:00:00Z" },
      { kind: "once", at: "2030-01-01T00:00:00-05:00" },
      { kind: "once", at: "2030-01-01T00:00:00" },
      {
        kind: "recurring",
        recurrence:
          "DTSTART;TZID=Invalid/Zone:20300101T090000\nRRULE:FREQ=DAILY",
      },
      {
        kind: "recurring",
        recurrence: "DTSTART;TZID=UTC:20300230T090000\nRRULE:FREQ=DAILY",
      },
      {
        kind: "recurring",
        recurrence: "DTSTART;TZID=UTC:20300101T090000\nRRULE:FREQ=INVALID",
      },
      {
        kind: "recurring",
        recurrence:
          "DTSTART;TZID=UTC:20300101T090000\nRRULE:FREQ=DAILY\nEXDATE:20300230T090000",
      },
    ];
    for (const timing of invalid)
      await expect(
        create({ timing: timing as ScheduleCreate["timing"] }),
      ).rejects.toMatchObject({ code: "SchemaValidationError" });
    const exhausted = await create({
      timing: {
        kind: "recurring",
        recurrence:
          "DTSTART;TZID=UTC:20300101T090000\nRRULE:FREQ=DAILY;COUNT=1\nEXDATE:20300101T090000",
      },
    });
    expect(exhausted).toMatchObject({
      status: "completed",
      next_occurrence_at: null,
    });
  });

  test("destination requires schema and current create authority", async () => {
    const { prisma, grant, create } = await fixture();
    await removePolicy(prisma, "org", "creator", "/queues/jobs", "create");
    await grant("creator", "/queues/jobs", "manage");
    await expect(create()).rejects.toMatchObject({
      code: "PermissionDeniedError",
    });
    await grant("creator", "/queues/jobs", "create");
    const invalidPayloads: ScheduleCreate["payload"][] = [
      { title: 5 },
      { unknown: "secret" },
      { title: "é".repeat(32768) },
    ];
    for (const payload of invalidPayloads)
      await expect(create({ payload })).rejects.toMatchObject({
        code: "SchemaValidationError",
      });
    expect(await prisma.queueSchedule.count()).toBe(0);
    await create({ payload: { owner: "creator", title: "accepted" } });
    await removePolicy(prisma, "org", "creator", "/schedules", "write");
    await expect(
      create({ payload: { owner: "creator" } }),
    ).rejects.toMatchObject({ code: "PermissionDeniedError" });
  });

  test("editing administrator cannot replace the creator or lend destination authority", async () => {
    const { prisma, service, grant, create } = await fixture();
    const row = await create();
    await grant("editor", "/schedules/*", "*");
    await grant("editor", "/queues/*", "*");
    await service.update(editor, row.id, {
      payload: { title: "editor update" },
    });
    expect((await service.show(editor, row.id)).created_by).toBe("creator");
    await expect(
      service.update(editor, row.id, {
        created_by: "editor",
      } as unknown as ScheduleUpdate),
    ).rejects.toMatchObject({ code: "SchemaValidationError" });
    await expect(
      service.update(editor, row.id, { queue: "other" }),
    ).rejects.toMatchObject({ code: "PermissionDeniedError" });
    await removePolicy(prisma, "org", "creator", "/queues/jobs", "create");
    await expect(
      service.update(editor, row.id, { enabled: true }),
    ).rejects.toMatchObject({ code: "PermissionDeniedError" });
    await grant("creator", "/queues/jobs", "create");
    await prisma.member.delete({ where: { id: "creator-member" } });
    await expect(
      service.update(editor, row.id, { enabled: true }),
    ).rejects.toMatchObject({ code: "AutomationNotFoundError" });
  });

  test("pause/resume retains durable cursor; replacing timing explicitly resets it", async () => {
    const { prisma, service, grant, create } = await fixture();
    const row = await create({ timing: recurring, enabled: false });
    expect(row).toMatchObject({
      status: "paused",
      pause_reason: "disabled",
      cursor_at: null,
    });
    await grant("editor", "/schedules/*", "*");
    const cursorAt = new Date("2030-03-10T13:00:00Z");
    const nextOccurrenceAt = new Date("2030-03-11T13:00:00Z");
    await prisma.queueSchedule.update({
      where: { id: row.id },
      data: { cursorAt, nextOccurrenceAt, pauseReason: "permission_revoked" },
    });
    const stillPaused = await service.update(editor, row.id, {
      payload: { title: "changed" },
    });
    expect(stillPaused).toMatchObject({
      status: "paused",
      pause_reason: "permission_revoked",
      cursor_at: cursorAt.toISOString(),
      next_occurrence_at: nextOccurrenceAt.toISOString(),
    });
    const resumed = await service.update(editor, row.id, { enabled: true });
    expect(resumed).toMatchObject({
      status: "active",
      pause_reason: null,
      cursor_at: cursorAt.toISOString(),
      next_occurrence_at: nextOccurrenceAt.toISOString(),
    });
    const paused = await service.update(editor, row.id, { enabled: false });
    expect(paused.pause_reason).toBe("disabled");
    const replaced = await service.update(editor, row.id, {
      timing: once.timing,
    });
    expect(replaced).toMatchObject({
      status: "paused",
      cursor_at: null,
      timezone: null,
      next_occurrence_at: "2030-01-01T00:00:00.000Z",
    });
    await expect(
      service.update(editor, row.id, {} as ScheduleUpdate),
    ).rejects.toMatchObject({ code: "SchemaValidationError" });
  });

  test("current schema and queue availability are checked on all configuration writes", async () => {
    const { prisma, service, grant, create } = await fixture();
    const row = await create();
    await grant("editor", "/schedules/*", "*");
    await prisma.queue.update({
      where: { id: "jobs" },
      data: { schema: { count: "integer" } },
    });
    await expect(
      service.update(editor, row.id, { enabled: false }),
    ).rejects.toMatchObject({ code: "SchemaValidationError" });
    await service.update(editor, row.id, { payload: { count: 2 } });
    await prisma.queue.update({
      where: { id: "jobs" },
      data: { enabled: false },
    });
    await expect(create({ payload: { count: 1 } })).rejects.toMatchObject({
      code: "AutomationConflictError",
    });
    await prisma.queue.update({
      where: { id: "jobs" },
      data: { enabled: true },
    });
    expect(
      (await service.update(editor, row.id, { enabled: true })).status,
    ).toBe("active");
    expect(
      (await prisma.queueSchedule.findUniqueOrThrow({ where: { id: row.id } }))
        .payload,
    ).toEqual({ count: 2 });
  });

  test("bounded list filters read grants and binds cursors to organization/principal", async () => {
    const { service, grant, create } = await fixture();
    const rows = [await create(), await create(), await create()];
    await grant("editor", `/schedules/${rows[2]!.id}`, "read");
    const first = await service.list(editor, { limit: 1 });
    expect(first.items).toEqual([]);
    expect(first.next_cursor).not.toBeNull();
    await expect(
      service.list(creator, { limit: 1, cursor: first.next_cursor! }),
    ).rejects.toMatchObject({ code: "SchemaValidationError" });
    const second = await service.list(editor, {
      limit: 1,
      cursor: first.next_cursor!,
    });
    const third = await service.list(editor, {
      limit: 1,
      cursor: second.next_cursor!,
    });
    expect(third.items.map((r) => r.id)).toEqual([rows[2]!.id]);
    expect(third.next_cursor).toBeNull();
    for (const input of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1, cursor: "invalid" },
    ])
      await expect(service.list(editor, input)).rejects.toMatchObject({
        code: "SchemaValidationError",
      });
  });

  test("cross-org IDs, missing resources and removed membership are nondisclosing", async () => {
    const { prisma, service, grant, create } = await fixture();
    const row = await create();
    await grant("editor", "/*", "*");
    await prisma.queueSchedule.create({
      data: {
        id: "foreign-schedule",
        orgId: "foreign",
        createdBy: "creator",
        queueId: "foreign-jobs",
        payload: {},
        deliverAt: new Date(once.timing.kind === "once" ? once.timing.at : ""),
        nextOccurrenceAt: new Date("2030-01-01T00:00:00Z"),
      },
    });
    for (const id of ["missing", "foreign-schedule"])
      for (const run of [
        () => service.show(editor, id),
        () => service.update(editor, id, { enabled: false }),
        () => service.delete(editor, id),
      ])
        await expect(run()).rejects.toMatchObject({
          code: "AutomationNotFoundError",
        });
    for (const queue of ["missing", "foreignJobs", "internal"])
      await expect(create({ queue })).rejects.toMatchObject({
        code: "AutomationNotFoundError",
      });
    await expect(
      Promise.resolve(
        prisma.queueSchedule.create({
          data: {
            id: "cross-org",
            orgId: "org",
            createdBy: "creator",
            queueId: "foreign-jobs",
            payload: {},
          },
        }),
      ),
    ).rejects.toThrow();
    await prisma.member.delete({ where: { id: "editor-member" } });
    for (const run of [
      () => service.list(editor, { limit: 10 }),
      () => service.show(editor, row.id),
      () => service.update(editor, row.id, { enabled: false }),
      () => service.delete(editor, row.id),
      () => service.create(editor, once),
    ])
      await expect(run()).rejects.toMatchObject({
        code: "AutomationNotFoundError",
      });
  });
});
