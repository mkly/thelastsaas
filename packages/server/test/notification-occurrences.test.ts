import { jobsFor } from "../src/jobs";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPolicy, assignRole, removePolicy } from "../src/db/casbin";
import { createNotificationSchedule } from "../src/db/notification-schedules";
import { registerDatabaseProvider } from "../src/db/provider";
import { NotificationDispatcher } from "../src/notifications/channels";
import { NotificationQueue } from "../src/notifications/queue";
import { NotificationScheduleProcessor } from "../src/scheduler";
import { testMigrationSql } from "./test-migrations";

const postgresUrl = process.env.NOTIFICATION_OCCURRENCE_DATABASE_URL;
const provider = postgresUrl ? "postgresql" : "sqlite";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const first = new Date("2026-10-10T10:00:00Z");
const last = new Date("2026-10-10T10:02:00Z");

async function fixture() {
  const directory = mkdtempSync(
    join(tmpdir(), "lastsaas-notification-occurrences-"),
  );
  const path = join(directory, "test.db");
  const database = postgresUrl ? undefined : new Database(path);
  database?.exec(testMigrationSql);
  const url = postgresUrl ?? `file:${path}`;
  const prisma = new PrismaClient({ datasourceUrl: url });
  registerDatabaseProvider(prisma, url);
  cleanups.push(async () => {
    try {
      // Notification-to-schedule deletion is deliberately restricted.
      await prisma.notification.deleteMany({
        where: { orgId: "occurrence-org" },
      });
      await prisma.organization.deleteMany({ where: { id: "occurrence-org" } });
      await prisma.user.deleteMany({
        where: { id: { in: ["owner", "alice", "bob"] } },
      });
    } finally {
      await jobsFor(prisma)?.close();
      await prisma.$disconnect();
      database?.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });
  await prisma.organization.create({
    data: { id: "occurrence-org", name: "Org", slug: "occurrence-org" },
  });
  for (const id of ["owner", "alice", "bob"]) {
    await prisma.user.create({
      data: { id, name: id, email: `${id}@example.com` },
    });
    await prisma.member.create({
      data: {
        id: `${id}-member`,
        organizationId: "occurrence-org",
        userId: id,
        role: "member",
      },
    });
  }
  await addPolicy(
    prisma,
    "occurrence-org",
    "owner",
    "/notifications/*",
    "write",
  );
  await assignRole(prisma, "occurrence-org", "alice", "team");
  const dispatcher = new NotificationDispatcher([]);
  const queue = new NotificationQueue(prisma, dispatcher, provider);
  const processor = new NotificationScheduleProcessor(prisma, queue, provider);
  const create = (input: Parameters<typeof createNotificationSchedule>[3]) =>
    createNotificationSchedule(prisma, "occurrence-org", "owner", input);
  return { prisma, url, queue, processor, create };
}

describe("atomic notification occurrences", () => {
  test("independent workers racing the same cursor publish each occurrence once", async () => {
    const { prisma, url, processor, create } = await fixture();
    const row = await create({
      message: "Race",
      recurrence:
        "DTSTART;TZID=UTC:20261010T100000\nRRULE:FREQ=MINUTELY;COUNT=3",
      audience: { kind: "all" },
    });
    const other = new PrismaClient({ datasourceUrl: url });
    registerDatabaseProvider(other, url);
    cleanups.push(() => other.$disconnect());
    const competing = new NotificationScheduleProcessor(
      other,
      new NotificationQueue(other, new NotificationDispatcher([]), provider),
      provider,
    );
    const counts = await Promise.all([
      processor.processDue(last),
      competing.processDue(last),
    ]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(
      await prisma.notification.count({ where: { scheduleId: row.id } }),
    ).toBe(3);

    expect(
      await prisma.notificationSchedule.findUniqueOrThrow({
        where: { id: row.id },
      }),
    ).toMatchObject({
      status: "sent",
      nextOccurrenceAt: null,
      lastEnqueuedAt: first,
      lockedAt: null,
    });
  });

  test("cursor failure rolls back domain fanout and job publication", async () => {
    const { prisma, queue, processor, create } = await fixture();
    const row = await create({
      message: "Rollback",
      deliver_at: first.toISOString(),
      audience: { kind: "all" },
    });
    const failing = prisma.$extends({
      query: {
        notificationSchedule: {
          async update() {
            throw new Error("cursor storage unavailable");
          },
        },
      },
    });
    const broken = new NotificationScheduleProcessor(
      failing as never,
      queue,
      provider,
    );
    await expect(broken.processDue(first)).rejects.toThrow(
      "cursor storage unavailable",
    );
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.queueEntry.count()).toBe(0);
    expect(await prisma.queueDelivery.count()).toBe(0);
    expect(
      await prisma.notificationSchedule.findUniqueOrThrow({
        where: { id: row.id },
      }),
    ).toMatchObject({
      status: "scheduled",
      lastEnqueuedAt: null,
      lockedAt: null,
    });
    expect(await processor.processDue(first)).toBe(1);
    expect(await prisma.notification.count()).toBe(3);
  });

  test("each committed occurrence refreshes dynamic audiences and current grants", async () => {
    const { prisma, queue, create } = await fixture();
    const row = await create({
      message: "Dynamic",
      recurrence:
        "DTSTART;TZID=UTC:20261010T100000\nRRULE:FREQ=MINUTELY;COUNT=3",
      audience: { kind: "roles", roles: ["team"] },
    });
    const enqueue = queue.enqueue.bind(queue);
    let calls = 0;
    const processor = new NotificationScheduleProcessor(
      prisma,
      {
        enqueue: async (...args: Parameters<NotificationQueue["enqueue"]>) => {
          // This mutation joins the occurrence transaction and is visible next time.
          if (++calls === 1)
            await args[1]!.casbinRule.create({
              data: {
                orgId: "occurrence-org",
                ptype: "g",
                v0: "bob",
                v1: "org:occurrence-org:user:team",
              },
            });
          return enqueue(...args);
        },
      } as never,
      provider,
    );
    expect(await processor.processDue(first)).toBe(1);
    expect(await processor.processDue(new Date("2026-10-10T10:01:00Z"))).toBe(
      1,
    );
    expect(
      await prisma.notification.count({ where: { userId: "alice" } }),
    ).toBe(2);
    expect(await prisma.notification.count({ where: { userId: "bob" } })).toBe(
      1,
    );
    await removePolicy(
      prisma,
      "occurrence-org",
      "owner",
      "/notifications/*",
      "write",
    );
    expect(await processor.processDue(last)).toBe(0);
    expect(
      await prisma.notificationSchedule.findUniqueOrThrow({
        where: { id: row.id },
      }),
    ).toMatchObject({
      status: "cancelled",
      lastEnqueuedAt: new Date("2026-10-10T10:01:00Z"),
    });
    expect(await prisma.notification.count()).toBe(3);
  });

  test("fixed recipients keep IDs and departed self owners cannot materialize", async () => {
    const { prisma, processor, create } = await fixture();
    const fixed = await create({
      message: "Fixed",
      deliver_at: first.toISOString(),
      audience: { kind: "users", users: ["alice@example.com"] },
    });
    await prisma.user.update({
      where: { id: "alice" },
      data: { email: "changed@example.com" },
    });
    await prisma.user.update({
      where: { id: "bob" },
      data: { email: "alice@example.com" },
    });
    expect(await processor.processDue(first)).toBe(1);
    expect(
      await prisma.notification.findFirstOrThrow({
        where: { scheduleId: fixed.id },
      }),
    ).toMatchObject({ userId: "alice", createdByUserId: "owner" });
    const self = await create({
      message: "Self",
      deliver_at: first.toISOString(),
    });
    await prisma.member.delete({ where: { id: "owner-member" } });
    expect(await processor.processDue(first)).toBe(0);
    expect(
      await prisma.notificationSchedule.findUniqueOrThrow({
        where: { id: self.id },
      }),
    ).toMatchObject({ status: "cancelled", lastEnqueuedAt: null });
    expect(
      await prisma.notification.count({ where: { scheduleId: self.id } }),
    ).toBe(0);
  });

  test("cancellation after selection is observed under the occurrence lock", async () => {
    const { prisma, queue, create } = await fixture();
    const row = await create({
      message: "Cancelled",
      deliver_at: first.toISOString(),
    });
    const selected = prisma.$extends({
      query: {
        notificationSchedule: {
          async findMany({ args, query }) {
            const rows = await query(args);
            await prisma.notificationSchedule.update({
              where: { id: row.id },
              data: { status: "cancelled" },
            });
            return rows;
          },
        },
      },
    });
    const enqueue = mock(queue.enqueue.bind(queue));
    const processor = new NotificationScheduleProcessor(
      selected as never,
      { enqueue } as never,
      provider,
    );
    expect(await processor.processDue(first)).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await prisma.notification.count()).toBe(0);
  });
});
