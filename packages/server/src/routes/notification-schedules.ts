import { errorResponse } from "@lastsaas/shared";
import { Hono } from "hono";

import type { AppEnvironment } from "../env";
import {
  listNotificationSchedules,
  cancelNotificationSchedule,
  scheduleResponse,
} from "../db/notification-schedules";

export const notificationScheduleRouter = new Hono<AppEnvironment>()
  .get("/", async (context) => {
    const schedules = await listNotificationSchedules(
      context.get("services").prisma,
      context.get("orgId"),
      context.get("userId"),
    );
    return context.json({
      status: "ok" as const,
      schedules: schedules.map(scheduleResponse),
    });
  })
  .delete("/:id", async (context) => {
    const result = await cancelNotificationSchedule(
      context.get("services").prisma,
      context.get("orgId"),
      context.get("userId"),
      context.req.param("id"),
    );
    if (result.count === 0) {
      return context.json(
        errorResponse("NotFound", "Active notification schedule not found"),
        404,
      );
    }
    await context.get("audit")(
      "cancel_notification_schedule",
      "notification_schedule",
      context.req.param("id"),
      {},
    );
    return context.json({
      status: "ok" as const,
      message: "Notification schedule cancelled",
    });
  });
