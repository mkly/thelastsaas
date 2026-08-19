import { errorResponse, genId } from "@lastsaas/shared";
import type { Prisma } from "@prisma/client";
import { Hono } from "hono";
import { z } from "zod";

import type { AppEnvironment } from "../env";
import { InvalidRecurrenceError, parseRecurrence } from "../lib/recurrence";

const scheduleSchema = z
  .object({
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

interface ScheduleRow {
  id: string;
  userId: string;
  channel: string;
  message: string;
  data: Prisma.JsonValue | null;
  deliverAt: Date | null;
  recurrence: string | null;
  nextOccurrenceAt: Date | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

function scheduleResponse(row: ScheduleRow) {
  const timezone = row.recurrence
    ? (/^DTSTART;TZID=([^:;\r\n]+):/.exec(row.recurrence)?.[1] ?? null)
    : null;
  return {
    id: row.id,
    kind: row.recurrence ? ("recurring" as const) : ("one_shot" as const),
    channel: row.channel,
    recipient: row.userId,
    subject: null,
    message: row.message,
    data: row.data,
    deliver_at: row.deliverAt?.toISOString() ?? null,
    recurrence: row.recurrence,
    timezone,
    enabled: row.status === "scheduled",
    next_delivery_at:
      row.nextOccurrenceAt?.toISOString() ??
      row.deliverAt?.toISOString() ??
      null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export const notificationScheduleRouter = new Hono<AppEnvironment>()
  .get("/", async (context) => {
    const schedules = await context
      .get("services")
      .prisma.notificationSchedule.findMany({
        where: {
          orgId: context.get("orgId"),
          userId: context.get("userId"),
        },
        orderBy: { createdAt: "desc" },
      });
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

    let nextOccurrenceAt: Date | undefined;
    if (parsed.data.recurrence) {
      try {
        const recurrence = parseRecurrence(parsed.data.recurrence);
        nextOccurrenceAt =
          recurrence.rule.after(new Date(0), true) ?? undefined;
      } catch (error) {
        if (error instanceof InvalidRecurrenceError) {
          return context.json(
            errorResponse("InvalidRequest", error.message),
            400,
          );
        }
        throw error;
      }
    }

    const schedule = await context
      .get("services")
      .prisma.notificationSchedule.create({
        data: {
          id: genId(),
          orgId: context.get("orgId"),
          userId: context.get("userId"),
          dedupeKey: parsed.data.dedupe_key ?? genId(),
          type: parsed.data.type,
          message: parsed.data.message,
          ...(parsed.data.data
            ? { data: parsed.data.data as Prisma.InputJsonObject }
            : {}),
          inApp: parsed.data.in_app,
          channel: parsed.data.channel,
          ...(parsed.data.deliver_at
            ? { deliverAt: new Date(parsed.data.deliver_at) }
            : {}),
          ...(parsed.data.recurrence
            ? { recurrence: parsed.data.recurrence, nextOccurrenceAt }
            : {}),
        },
      });
    return context.json(
      { status: "ok" as const, ...scheduleResponse(schedule) },
      201,
    );
  })
  .delete("/:id", async (context) => {
    const result = await context
      .get("services")
      .prisma.notificationSchedule.updateMany({
        where: {
          id: context.req.param("id"),
          orgId: context.get("orgId"),
          userId: context.get("userId"),
          status: "scheduled",
        },
        data: { status: "cancelled", lockedAt: null },
      });
    if (result.count === 0) {
      return context.json(
        errorResponse("NotFound", "Active notification schedule not found"),
        404,
      );
    }
    return context.json({
      status: "ok" as const,
      message: "Notification schedule cancelled",
    });
  });
