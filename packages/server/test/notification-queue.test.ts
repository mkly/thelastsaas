import { describe, expect, mock, test } from "bun:test";

import {
  NotificationDispatcher,
  type NotificationChannel,
} from "../src/notifications/channels";
import { NotificationQueue } from "../src/notifications/queue";
import {
  mergeNotificationPreferences,
  normalizeNotificationPreferences,
  resolveNotificationChannels,
} from "../src/notifications/preferences";

function dueRow(attempts = 0) {
  return {
    id: "notification_1",
    data: {
      __delivery: {
        to: "recipient@example.com",
        subject: "Build finished",
        text: "The build passed.",
      },
    },
    attempts,
    errorLogs: attempts ? ["Earlier failure"] : null,
  };
}

describe("notification preferences", () => {
  test("normalizes defaults and retains only meaningful per-kind overrides", () => {
    expect(normalizeNotificationPreferences(null)).toEqual({
      default: { in_app: true, email: true },
      by_kind: {},
    });

    expect(
      mergeNotificationPreferences(null, {
        by_kind: { invitation: { email: false } },
      }),
    ).toEqual({
      default: { in_app: true, email: true },
      by_kind: { invitation: { in_app: true, email: false } },
    });
  });

  test("a default-only update applies to kinds without an explicit override", () => {
    const stored = mergeNotificationPreferences(null, {
      by_kind: { invitation: { email: false } },
    });

    const merged = mergeNotificationPreferences(stored, {
      default: { email: false },
    });

    expect(merged).toEqual({
      default: { in_app: true, email: false },
      by_kind: {},
    });
    expect(resolveNotificationChannels(merged, "role_assigned")).toEqual({
      in_app: true,
      email: false,
    });
  });

  test("keeps an explicit override that still differs from the new default", () => {
    const stored = mergeNotificationPreferences(null, {
      by_kind: { invitation: { in_app: false } },
    });

    expect(
      mergeNotificationPreferences(stored, { default: { email: false } }),
    ).toEqual({
      default: { in_app: true, email: false },
      by_kind: { invitation: { in_app: false, email: true } },
    });
  });
});

describe("notification delivery", () => {
  test("fans out to every configured channel", async () => {
    const consoleSend = mock().mockResolvedValue(true);
    const emailSend = mock().mockResolvedValue(true);
    const channels: NotificationChannel[] = [
      { name: "console", send: consoleSend },
      { name: "email", send: emailSend },
    ];
    const dispatcher = new NotificationDispatcher(channels);
    const delivered = await dispatcher.send({
      to: "recipient@example.com",
      subject: "Hello",
      text: "World",
    });

    expect(delivered).toBe(true);
    expect(consoleSend).toHaveBeenCalledTimes(1);
    expect(emailSend).toHaveBeenCalledTimes(1);
  });
});

describe("retrying notification queue", () => {
  test("claims and marks a delivered notification sent", async () => {
    const prisma = {
      notification: {
        updateMany: mock()
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 1 }),
        findMany: mock().mockResolvedValue([dueRow()]),
        update: mock().mockResolvedValue({}),
      },
    };
    const dispatcher = {
      send: mock().mockResolvedValue(true),
    };
    const queue = new NotificationQueue(prisma as never, dispatcher as never);

    expect(await queue.processDue(new Date("2026-08-18T20:00:00.000Z"))).toBe(
      1,
    );
    expect(dispatcher.send).toHaveBeenCalledWith(
      {
        to: "recipient@example.com",
        subject: "Build finished",
        text: "The build passed.",
      },
      undefined,
    );
    expect(prisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          lockedAt: null,
          OR: [
            {
              status: "pending",
              OR: [
                { nextAttemptAt: null },
                {
                  nextAttemptAt: {
                    lte: new Date("2026-08-18T20:00:00.000Z"),
                  },
                },
              ],
            },
            {
              status: "failed",
              nextAttemptAt: {
                not: null,
                lte: new Date("2026-08-18T20:00:00.000Z"),
              },
            },
          ],
        },
      }),
    );
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: "notification_1" },
      data: {
        status: "sent",
        lockedAt: null,
        nextAttemptAt: null,
        attempts: 1,
      },
    });
  });

  test("backs off failures and exhausts them after three attempts", async () => {
    const now = new Date("2026-08-18T20:00:00.000Z");
    const prisma = {
      notification: {
        updateMany: mock()
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 1 }),
        findMany: mock().mockResolvedValue([dueRow(1)]),
        update: mock().mockResolvedValue({}),
      },
    };
    const queue = new NotificationQueue(
      prisma as never,
      { send: mock().mockResolvedValue(false) } as never,
    );

    await queue.processDue(now);
    expect(prisma.notification.update).toHaveBeenCalledWith({
      where: { id: "notification_1" },
      data: {
        status: "pending",
        lockedAt: null,
        attempts: 2,
        nextAttemptAt: new Date("2026-08-18T20:01:00.000Z"),
        errorLogs: ["Earlier failure", "Notification delivery failed"],
      },
    });

    prisma.notification.updateMany = mock()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.notification.findMany.mockResolvedValue([dueRow(2)]);
    await queue.processDue(now);
    expect(prisma.notification.update).toHaveBeenLastCalledWith({
      where: { id: "notification_1" },
      data: {
        status: "failed",
        lockedAt: null,
        attempts: 3,
        nextAttemptAt: null,
        errorLogs: ["Earlier failure", "Notification delivery failed"],
      },
    });
  });
});
