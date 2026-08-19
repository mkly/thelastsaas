import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import type { AppEnvironment } from "../src/env";
import { notificationScheduleRouter } from "../src/routes/notification-schedules";

const now = new Date("2026-08-18T20:00:00.000Z");

function scheduleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "schedule_1",
    orgId: "org_123",
    userId: "user_123",
    dedupeKey: "dedupe_1",
    type: "direct_notification",
    message: "Reminder",
    data: null,
    inApp: true,
    channel: "console",
    deliverAt: new Date("2026-08-20T09:00:00.000Z"),
    recurrence: null,
    nextOccurrenceAt: null,
    status: "scheduled",
    lockedAt: null,
    lastEnqueuedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createScheduleApp(prisma: unknown) {
  const app = new Hono<AppEnvironment>();
  app.use("*", async (context, next) => {
    context.set("orgId", "org_123");
    context.set("userId", "user_123");
    context.set("services", { prisma } as never);
    context.set("audit", async () => undefined);
    await next();
  });
  app.route("/", notificationScheduleRouter);
  return app;
}

describe("notification schedule routes", () => {
  test("creates one-shot schedules for the authenticated user", async () => {
    const create = mock().mockImplementation(({ data }) =>
      Promise.resolve(scheduleRow(data)),
    );
    const app = createScheduleApp({
      notificationSchedule: { create },
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Reminder",
        deliver_at: "2026-08-20T09:00:00.000Z",
      }),
    });

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      orgId: "org_123",
      userId: "user_123",
      type: "direct_notification",
      message: "Reminder",
      inApp: true,
      channel: "console",
      deliverAt: new Date("2026-08-20T09:00:00.000Z"),
    });
    expect(await response.json()).toMatchObject({
      status: "ok",
      id: expect.any(String),
      kind: "one_shot",
      recipient: "user_123",
      enabled: true,
      deliver_at: "2026-08-20T09:00:00.000Z",
    });
  });

  test("validates recurring content before creating a schedule", async () => {
    const create = mock();
    const app = createScheduleApp({
      notificationSchedule: { create },
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Weekly reminder",
        recurrence: "RRULE:FREQ=WEEKLY",
      }),
    });

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      status: "error",
      error: "InvalidRequest",
    });
  });

  test("lists and cancels only the authenticated user's schedules", async () => {
    const findMany = mock().mockResolvedValue([scheduleRow()]);
    const updateMany = mock().mockResolvedValue({ count: 1 });
    const app = createScheduleApp({
      notificationSchedule: { findMany, updateMany },
    });

    const listResponse = await app.request("/");
    const cancelResponse = await app.request("/schedule_1", {
      method: "DELETE",
    });

    expect(listResponse.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith({
      where: { orgId: "org_123", userId: "user_123" },
      orderBy: { createdAt: "desc" },
    });
    expect(cancelResponse.status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "schedule_1",
        orgId: "org_123",
        userId: "user_123",
        status: "scheduled",
      },
      data: { status: "cancelled", lockedAt: null },
    });
  });
});
