import { errorResponse, notificationAudienceSchema } from "@lastsaas/shared";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnvironment } from "../env";
import {
  createNotificationSchedule,
  listNotificationSchedules,
  cancelNotificationSchedule,
  scheduleResponse,
} from "../db/notification-schedules";
import { notificationError } from "./notifications";

const scheduleSchema = z
  .object({
    audience: notificationAudienceSchema.optional(),
    type: z.string().min(1).default("direct_notification"),
    message: z.string().min(1),
    data: z.record(z.string(), z.unknown()).optional(),
    in_app: z.boolean().default(true),
    channel: z.string().min(1).default("console"),
    dedupe_key: z.string().min(1).optional(),
    deliver_at: z.string().datetime({ offset: true }).optional(),
    recurrence: z.string().min(1).optional(),
  })
  .refine(
    (value) =>
      (value.deliver_at === undefined) !== (value.recurrence === undefined),
    "Provide exactly one of deliver_at or recurrence",
  );

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
  .post("/", async (context) => {
    const parsed = scheduleSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return context.json(
        errorResponse(
          "InvalidRequest",
          parsed.error.issues.map((issue) => issue.message).join("; "),
        ),
        400,
      );
    }

    let schedule;
    try {
      schedule = scheduleResponse(
        await createNotificationSchedule(
          context.get("services").prisma,
          context.get("orgId"),
          context.get("userId"),
          parsed.data,
        ),
      );
    } catch (error) {
      return notificationError(context, error);
    }
    await context.get("audit")(
      "create_notification_schedule",
      "notification_schedule",
      schedule.id,
      { type: parsed.data.type, audience: schedule.audience },
    );
    return context.json({ status: "ok" as const, ...schedule }, 201);
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
