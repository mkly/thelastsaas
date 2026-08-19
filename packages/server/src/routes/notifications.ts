import { NOTIFICATION_KINDS } from "@lastsaas/shared";
import { Hono } from "hono";
import { z } from "zod";

import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "../db/notification-preferences";
import {
  deleteNotification,
  getNotifications,
  markNotificationRead,
  queueDirectNotification,
} from "../db/notifications";
import type { AppEnvironment } from "../env";

const channelPatchSchema = z
  .object({
    in_app: z.boolean().optional(),
    email: z.boolean().optional(),
  })
  .refine(
    (value) => value.in_app !== undefined || value.email !== undefined,
    "At least one channel preference must be provided",
  );

const preferencesPatchSchema = z
  .object({
    default: channelPatchSchema.optional(),
    by_kind: z
      .partialRecord(z.enum(NOTIFICATION_KINDS), channelPatchSchema)
      .optional(),
  })
  .refine(
    (value) => value.default !== undefined || value.by_kind !== undefined,
    "At least one preference update must be provided",
  );

const queueSchema = z.object({
  type: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
  subject: z.string().min(1),
  text: z.string().min(1).optional(),
  html: z.string().min(1).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  in_app: z.boolean().optional(),
  channel: z.enum(["console", "email"]).optional(),
  dedupe_key: z.string().min(1).optional(),
});

const readSchema = z.object({ read: z.boolean() });

async function readJson<Input>(
  context: { req: { json(): Promise<unknown> } },
  schema: z.ZodType<Input>,
): Promise<Input | null> {
  const body = await context.req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export const notificationRouter = new Hono<AppEnvironment>()
  .get("/", async (context) => {
    const { prisma } = context.get("services");
    const notifications = await getNotifications(
      prisma,
      context.get("orgId"),
      context.get("userId"),
      context.req.query("unread") === "true",
    );
    return context.json({ status: "ok" as const, notifications });
  })
  .get("/preferences", async (context) => {
    const preferences = await getNotificationPreferences(
      context.get("services").prisma,
      context.get("userId"),
    );
    return context.json({ status: "ok" as const, preferences });
  })
  .patch("/preferences", async (context) => {
    const patch = await readJson(context, preferencesPatchSchema);
    if (!patch) {
      return context.json(
        {
          status: "error" as const,
          error: "InvalidRequest",
          message: "Invalid notification preference update",
        },
        400,
      );
    }
    const preferences = await updateNotificationPreferences(
      context.get("services").prisma,
      context.get("userId"),
      patch,
    );
    return context.json({ status: "ok" as const, preferences });
  })
  .post("/queue", async (context) => {
    const body = await readJson(context, queueSchema);
    if (!body) {
      return context.json(
        {
          status: "error" as const,
          error: "InvalidRequest",
          message: "Invalid notification",
        },
        400,
      );
    }
    const { prisma, notificationQueue } = context.get("services");
    const id = await queueDirectNotification(
      prisma,
      notificationQueue,
      context.get("orgId"),
      context.get("userId"),
      {
        subject: body.subject,
        ...(body.type ? { type: body.type } : {}),
        ...(body.message ? { message: body.message } : {}),
        ...(body.text ? { text: body.text } : {}),
        ...(body.html ? { html: body.html } : {}),
        ...(body.data ? { data: body.data } : {}),
        ...(body.in_app !== undefined ? { inApp: body.in_app } : {}),
        ...(body.channel ? { channel: body.channel } : {}),
        ...(body.dedupe_key ? { dedupeKey: body.dedupe_key } : {}),
      },
    );
    return context.json(
      { status: "ok" as const, id, message: "Notification queued" },
      201,
    );
  })
  .patch("/:id", async (context) => {
    const body = await readJson(context, readSchema);
    if (!body) {
      return context.json(
        {
          status: "error" as const,
          error: "InvalidRequest",
          message: "read must be a boolean",
        },
        400,
      );
    }
    const result = await markNotificationRead(
      context.get("services").prisma,
      context.req.param("id"),
      context.get("orgId"),
      context.get("userId"),
      body.read,
    );
    if (result.count === 0) {
      return context.json(
        {
          status: "error" as const,
          error: "NotFound",
          message: "Notification not found",
        },
        404,
      );
    }
    return context.json({ status: "ok" as const, read: body.read });
  })
  .delete("/:id", async (context) => {
    const result = await deleteNotification(
      context.get("services").prisma,
      context.req.param("id"),
      context.get("orgId"),
      context.get("userId"),
    );
    if (result.count === 0) {
      return context.json(
        {
          status: "error" as const,
          error: "NotFound",
          message: "Notification not found",
        },
        404,
      );
    }
    return context.json({ status: "ok" as const });
  });
