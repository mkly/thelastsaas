import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config";
import {
  createBackgroundScheduler,
  NotificationScheduleProcessor,
  SqliteBackgroundScheduler,
} from "../src/scheduler";
import { closeServices, createServices } from "../src/services";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260819015000_init/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createSchedulerServices() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-scheduler-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
  });
  const services = await createServices(config);
  if (!services.database) throw new Error("Expected SQLite database handle");
  services.database.exec(migration);
  await services.prisma.organization.create({
    data: { id: "org_test", name: "Test Org", slug: "test-org" },
  });
  await services.prisma.user.create({
    data: {
      id: "user_test",
      email: "user@example.com",
      name: "Test User",
    },
  });
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  return services;
}

describe("one-shot notification schedules", () => {
  test("materializes a due schedule into the delivery queue exactly once", async () => {
    const services = await createSchedulerServices();
    const deliverAt = new Date("2026-08-18T20:00:00.000Z");
    await services.prisma.notificationSchedule.create({
      data: {
        id: "schedule_1",
        orgId: "org_test",
        userId: "user_test",
        dedupeKey: "build-42",
        type: "build_alert",
        message: "Build finished",
        data: { build_id: 42 },
        channel: "console",
        deliverAt,
      },
    });

    expect(await services.scheduler.flushOnce(deliverAt)).toBe(1);
    expect(
      await services.prisma.notification.count({
        where: { orgId: "org_test", userId: "user_test" },
      }),
    ).toBe(1);
    expect(
      await services.prisma.notification.findFirst({
        select: { scheduleId: true, occurrenceAt: true },
      }),
    ).toEqual({ scheduleId: "schedule_1", occurrenceAt: deliverAt });
    expect(
      await services.prisma.notificationSchedule.findUnique({
        where: { id: "schedule_1" },
        select: { status: true, lockedAt: true, lastEnqueuedAt: true },
      }),
    ).toEqual({ status: "sent", lockedAt: null, lastEnqueuedAt: deliverAt });

    expect(await services.scheduler.flushOnce(deliverAt)).toBe(0);
    expect(await services.prisma.notification.count()).toBe(1);
  });

  test("recovers a stale schedule claim before materializing it", async () => {
    const services = await createSchedulerServices();
    const deliverAt = new Date("2026-08-18T20:00:00.000Z");
    await services.prisma.notificationSchedule.create({
      data: {
        id: "schedule_stale",
        orgId: "org_test",
        userId: "user_test",
        dedupeKey: "stale",
        type: "reminder",
        message: "Recovered reminder",
        deliverAt,
        status: "processing",
        lockedAt: new Date("2026-08-18T19:50:00.000Z"),
      },
    });

    expect(await services.scheduler.flushOnce(deliverAt)).toBe(1);
    expect(await services.prisma.notification.count()).toBe(1);
  });
});

describe("SQLite scheduler lifecycle", () => {
  test("flushes immediately and delegates queue stale-lock recovery", async () => {
    const prisma = {
      notificationSchedule: {
        updateMany: mock().mockResolvedValue({ count: 0 }),
        findMany: mock().mockResolvedValue([]),
      },
    };
    const queue = { processDue: mock().mockResolvedValue(0) };
    const scheduler = new SqliteBackgroundScheduler(
      prisma as never,
      queue as never,
    );
    const now = new Date("2026-08-18T20:00:00.000Z");

    expect(await scheduler.flushOnce(now)).toBe(0);
    expect(queue.processDue).toHaveBeenCalledWith(now);
    await scheduler.start();
    await scheduler.stop();
  });

  test("releases a failed claim so a later poll can retry it", async () => {
    const row = {
      id: "schedule_1",
      orgId: "org_1",
      userId: "user_1",
      type: "alert",
      message: "Alert",
      data: null,
      inApp: true,
      channel: "console",
      deliverAt: new Date("2026-08-18T20:00:00.000Z"),
      user: { email: "user@example.com" },
    };
    const updateMany = mock()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma = {
      notificationSchedule: {
        updateMany,
        findMany: mock().mockResolvedValue([row]),
        update: mock(),
      },
    };
    const queue = {
      enqueue: mock().mockRejectedValue(new Error("queue unavailable")),
    };
    const processor = new NotificationScheduleProcessor(
      prisma as never,
      queue as never,
    );

    await expect(processor.processDue(row.deliverAt)).rejects.toThrow(
      "queue unavailable",
    );
    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "schedule_1",
        status: "processing",
        lockedAt: row.deliverAt,
      },
      data: { status: "scheduled", lockedAt: null },
    });
  });
});

describe("background service lifecycle", () => {
  test("selects pg-boss for a PostgreSQL database URL", () => {
    const scheduler = createBackgroundScheduler(
      {} as never,
      {} as never,
      loadConfig({
        DATABASE_URL: "postgresql://user:secret@example.com/lastsaas",
      }),
    );

    expect(scheduler.name).toBe("pg-boss");
  });

  test("stops the scheduler before closing database connections", async () => {
    const callOrder: string[] = [];
    await closeServices({
      scheduler: {
        stop: mock().mockImplementation(async () => {
          callOrder.push("scheduler.stop");
        }),
      },
      database: {
        close: mock().mockImplementation(() => {
          callOrder.push("database.close");
        }),
      },
      prisma: {
        $disconnect: mock().mockImplementation(async () => {
          callOrder.push("prisma.disconnect");
        }),
      },
    } as never);

    expect(callOrder).toEqual([
      "scheduler.stop",
      "database.close",
      "prisma.disconnect",
    ]);
  });
});
