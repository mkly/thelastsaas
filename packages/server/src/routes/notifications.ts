import { notify } from "../notifications/notify";
import {
  NOTIFICATION_KINDS,
  notifySchema,
  LastSaasError,
  PermissionDeniedError,
} from "@lastsaas/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";

import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "../db/notification-preferences";
import {
  deleteNotification,
  getNotifications,
  markNotificationRead,
} from "../db/notifications";
import type { AppEnvironment } from "../env";

export function notificationError(
  context: Context<AppEnvironment>,
  error: unknown,
): Response {
  if (error instanceof PermissionDeniedError) {
    return context.json(error.toResponse(), 403);
  }
  if (error instanceof LastSaasError) {
    return context.json(error.toResponse(), 400);
  }
  throw error;
}

export const channelPatchSchema = z
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
    await context.get("audit")(
      "update_notification_preferences",
      "notification",
      null,
      {},
    );
    return context.json({ status: "ok" as const, preferences });
  })
  .post("/notify", async (context) => {
    const body = await readJson(context, notifySchema);
    if (!body)
      return context.json(
        {
          status: "error" as const,
          error: "InvalidRequest",
          message: "Invalid notification",
        },
        400,
      );
    try {
      const { prisma, notificationQueue } = context.get("services");
      const result = await notify(
        prisma,
        notificationQueue,
        context.get("orgId"),
        context.get("userId"),
        body,
      );
      await context.get("audit")(
        "notify",
        "notification",
        result.kind === "scheduled" ? result.schedule.id : result.id,
        {
          subject: body.subject,
          audience: body.audience ?? { kind: "self" },
          kind: result.kind,
          ...(result.kind === "immediate"
            ? { recipient_count: result.recipient_count }
            : {}),
        },
      );
      return context.json({ status: "ok" as const, ...result }, 201);
    } catch (error) {
      return notificationError(context, error);
    }
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
    await context.get("audit")(
      "update_notification_read_status",
      "notification",
      context.req.param("id"),
      { read: body.read },
    );
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
    await context.get("audit")(
      "delete_notification",
      "notification",
      context.req.param("id"),
      {},
    );
    return context.json({ status: "ok" as const });
  });
