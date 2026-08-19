import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import type { AppEnvironment } from "../src/env";
import { notificationRouter } from "../src/routes/notifications";

function createRouterApp(services: Record<string, unknown>) {
  const app = new Hono<AppEnvironment>();
  app.use("*", async (context, next) => {
    context.set("orgId", "org_1");
    context.set("userId", "user_1");
    context.set("services", services as never);
    context.set("audit", async () => undefined);
    await next();
  });
  app.route("/v1/orgs/:orgId/notifications", notificationRouter);
  return app;
}

describe("notification routes", () => {
  test("lists only the current user's in-app notifications", async () => {
    const findMany = mock().mockResolvedValue([
      {
        id: "notification_1",
        type: "invitation",
        message: "You were invited",
        data: {
          invitation_id: "invitation_1",
          __delivery: { to: "user@example.com" },
        },
        read: false,
        createdAt: new Date("2026-08-18T20:00:00.000Z"),
      },
    ]);
    const app = createRouterApp({
      prisma: { notification: { findMany } },
    });

    const response = await app.request(
      "/v1/orgs/org_1/notifications?unread=true",
    );
    expect(response.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orgId: "org_1",
          userId: "user_1",
          inApp: true,
          read: false,
        },
      }),
    );
    expect(await response.json()).toEqual({
      status: "ok",
      notifications: [
        {
          id: "notification_1",
          type: "invitation",
          message: "You were invited",
          data: { invitation_id: "invitation_1" },
          read: false,
          created_at: "2026-08-18T20:00:00.000Z",
        },
      ],
    });
  });

  test("gets and updates per-user channel preferences", async () => {
    const findUnique = mock().mockResolvedValue({
      notificationPreferences: null,
    });
    const update = mock().mockResolvedValue({});
    const app = createRouterApp({ prisma: { user: { findUnique, update } } });

    const getResponse = await app.request(
      "/v1/orgs/org_1/notifications/preferences",
    );
    expect(await getResponse.json()).toEqual({
      status: "ok",
      preferences: {
        default: { in_app: true, email: true },
        by_kind: {},
      },
    });

    const patchResponse = await app.request(
      "/v1/orgs/org_1/notifications/preferences",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          by_kind: { invitation: { email: false } },
        }),
      },
    );
    expect(patchResponse.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "user_1" },
      data: {
        notificationPreferences: {
          default: { in_app: true, email: true },
          by_kind: { invitation: { in_app: true, email: false } },
        },
      },
    });
  });

  test("queues a delivery for the current user", async () => {
    const enqueue = mock().mockResolvedValue("notification_1");
    const app = createRouterApp({
      prisma: {
        user: {
          findUnique: mock().mockResolvedValue({ email: "user@example.com" }),
        },
      },
      notificationQueue: { enqueue },
    });

    const response = await app.request("/v1/orgs/org_1/notifications/queue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "build_alert",
        subject: "Build finished",
        text: "The build passed.",
        channel: "email",
        in_app: false,
        dedupe_key: "build:42",
      }),
    });

    expect(response.status).toBe(201);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_1",
        userId: "user_1",
        type: "build_alert",
        inApp: false,
        dedupeKey: "build:42",
        delivery: expect.objectContaining({
          to: "user@example.com",
          subject: "Build finished",
          text: "The build passed.",
          channels: ["email"],
        }),
      }),
    );
  });

  test("scopes read and delete mutations to the current org and user", async () => {
    const updateMany = mock().mockResolvedValue({ count: 1 });
    const deleteMany = mock().mockResolvedValue({ count: 1 });
    const app = createRouterApp({
      prisma: { notification: { updateMany, deleteMany } },
    });

    const patchResponse = await app.request(
      "/v1/orgs/org_1/notifications/notification_1",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ read: true }),
      },
    );
    expect(patchResponse.status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: "notification_1",
        orgId: "org_1",
        userId: "user_1",
        inApp: true,
      },
      data: { read: true },
    });

    const deleteResponse = await app.request(
      "/v1/orgs/org_1/notifications/notification_1",
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        id: "notification_1",
        orgId: "org_1",
        userId: "user_1",
        inApp: true,
      },
    });
  });
});
