import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { createQueueTransportFixture } from "./queue-transport-helpers";
import { closeServices } from "../src/services";
import { notify } from "../src/notifications/notify";
import { NotificationQueue } from "../src/notifications/queue";
import { NotificationDispatcher } from "../src/notifications/channels";
import { NotificationScheduleProcessor } from "../src/scheduler";
import { cancelNotificationSchedule } from "../src/db/notification-schedules";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture() {
  const f = await createQueueTransportFixture("notify-", false);
  cleanup.push(async () => {
    await closeServices(f.services);
    rmSync(f.directory, { recursive: true, force: true });
  });
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const prisma = f.services.prisma;
  const queue = new NotificationQueue(
    prisma,
    new NotificationDispatcher([
      {
        name: "email",
        async send(message) {
          sent.push(message);
          return true;
        },
      },
    ]),
  );
  return {
    ...f,
    prisma,
    queue,
    sent,
    send: (input: Parameters<typeof notify>[4]) =>
      notify(prisma, queue, "org_one", "admin", input),
  };
}

test("notify defaults to self and honors opt-outs before enqueue and before delivery", async () => {
  const f = await fixture();
  await f.prisma.user.update({
    where: { id: "admin" },
    data: {
      notificationPreferences: { default: { in_app: false, email: false } },
    },
  });
  expect(await f.send({ subject: "Muted" })).toMatchObject({
    kind: "immediate",
    recipient_count: 1,
    queued_count: 0,
    skipped_count: 1,
  });
  expect(await f.prisma.notification.count()).toBe(0);
  await f.prisma.user.update({
    where: { id: "admin" },
    data: {
      notificationPreferences: { default: { in_app: true, email: true } },
    },
  });
  const result = await f.send({
    subject: "Reminder",
    message: "Review the order",
    dedupe_key: "order-1",
  });
  expect(
    await f.send({
      subject: "Reminder",
      message: "Review the order",
      dedupe_key: "order-1",
    }),
  ).toEqual(result);
  await f.prisma.user.update({
    where: { id: "admin" },
    data: {
      notificationPreferences: { default: { in_app: true, email: false } },
    },
  });
  await f.queue.processDue();
  expect(f.sent).toHaveLength(0);
  expect(await f.prisma.notification.findFirst()).toMatchObject({
    inApp: true,
    status: "sent",
    message: "Review the order",
  });
});

test("scheduled notify deduplicates retries, preserves subject and content, and delivers privately", async () => {
  const f = await fixture();
  const request = {
    subject: "Order check",
    message: "Inspect the delivery",
    data: { z: 1, a: 2 },
    dedupe_key: "reminder-1",
    timing: { kind: "once" as const, at: "2030-01-01T00:00:00Z" },
  };
  const results = await Promise.all([
    f.send(request),
    f.send({ ...request, data: { a: 2, z: 1 } }),
  ]);
  for (const result of results) {
    expect(result.kind).toBe("scheduled");
    if (result.kind !== "scheduled") throw new Error("Expected schedule");
    expect(result.schedule).toMatchObject({
      subject: request.subject,
      message: request.message,
      data: request.data,
    });
  }
  expect(
    results.map((result) =>
      result.kind === "scheduled" ? result.schedule.id : null,
    ),
  ).toEqual([expect.any(String), expect.any(String)]);
  if (results[0]!.kind === "scheduled" && results[1]!.kind === "scheduled")
    expect(results[0]!.schedule.id).toBe(results[1]!.schedule.id);
  expect(await f.prisma.notificationSchedule.count()).toBe(1);
  await expect(f.send({ ...request, subject: "Changed" })).rejects.toThrow(
    "different notification schedule",
  );
  const processor = new NotificationScheduleProcessor(f.prisma, f.queue);
  expect(await processor.processDue(new Date(request.timing.at))).toBe(1);
  expect(await processor.processDue(new Date(request.timing.at))).toBe(0);
  await f.queue.processDue();
  expect(f.sent).toMatchObject([
    {
      to: "admin@example.com",
      subject: "Order check",
      text: "Inspect the delivery",
    },
  ]);
  expect(await f.prisma.queue.count()).toBe(0);
  expect(await f.prisma.queueEntry.count()).toBe(0);
});

test("recurring notify uses the same content contract and cancellation stops future occurrences", async () => {
  const f = await fixture();
  const result = await f.send({
    subject: "Weekly review",
    timing: {
      kind: "recurring",
      recurrence: "DTSTART;TZID=UTC:20300101T090000\nRRULE:FREQ=WEEKLY;COUNT=2",
    },
  });
  if (result.kind !== "scheduled") throw new Error("Expected a schedule");
  expect(result.schedule).toMatchObject({
    subject: "Weekly review",
    message: "Weekly review",
    audience: { kind: "self" },
    kind: "recurring",
  });
  await cancelNotificationSchedule(
    f.prisma,
    "org_one",
    "admin",
    result.schedule.id,
  );
  expect(
    await new NotificationScheduleProcessor(f.prisma, f.queue).processDue(
      new Date("2030-02-01T00:00:00Z"),
    ),
  ).toBe(0);
  expect(await f.prisma.notification.count()).toBe(0);
});
