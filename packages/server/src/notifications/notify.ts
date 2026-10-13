import {
  InvalidQueryError,
  notifySchema,
  type NotifyInput,
  type NotifyResult,
} from "@lastsaas/shared";
import type { PrismaClient } from "@prisma/client";
import {
  createNotificationSchedule,
  scheduleResponse,
} from "../db/notification-schedules";
import { queueNotifications } from "../db/notifications";
import type { NotificationQueue } from "./queue";

/** One domain entry point shared by REST and MCP. Delivery remains server-owned. */
export async function notify(
  prisma: PrismaClient,
  queue: Pick<NotificationQueue, "enqueue">,
  orgId: string,
  senderId: string,
  request: NotifyInput,
): Promise<NotifyResult> {
  const parsed = notifySchema.safeParse(request);
  if (!parsed.success) throw new InvalidQueryError("Invalid notification");
  const { timing, dedupe_key, ...input } = parsed.data;
  if (timing) {
    const schedule = await createNotificationSchedule(prisma, orgId, senderId, {
      ...input,
      message: input.message ?? input.subject,
      dedupe_key,
      ...(timing.kind === "once"
        ? { deliver_at: timing.at }
        : { recurrence: timing.recurrence }),
    });
    return { kind: "scheduled", schedule: scheduleResponse(schedule) };
  }
  return {
    kind: "immediate",
    ...(await queueNotifications(prisma, queue, orgId, senderId, {
      ...input,
      dedupeKey: dedupe_key,
    })),
  };
}
