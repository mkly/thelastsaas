import {
  genId,
  InvalidQueryError,
  storedNotificationAudience,
  type NotificationAudience,
} from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { InvalidRecurrenceError, parseRecurrence } from "../lib/recurrence";
import { resolveNotificationAudience } from "./notification-audiences";

export interface ScheduleRow {
  id: string;
  userId: string;
  audience?: Prisma.JsonValue | null;
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

export function scheduleResponse(row: ScheduleRow) {
  const audience = storedNotificationAudience(row.audience);
  const timezone = row.recurrence
    ? (/^DTSTART;TZID=([^:;\r\n]+):/.exec(row.recurrence)?.[1] ?? null)
    : null;
  return {
    id: row.id,
    kind: row.recurrence ? ("recurring" as const) : ("one_shot" as const),
    channel: row.channel,
    recipient:
      audience.kind === "self"
        ? row.userId
        : audience.kind === "users" && audience.users.length === 1
          ? audience.users[0]!
          : null,
    created_by: row.userId,
    audience,
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

export interface NotificationScheduleInput {
  message: string;
  type?: string;
  data?: object;
  in_app?: boolean;
  channel?: string;
  dedupe_key?: string;
  deliver_at?: string;
  recurrence?: string;
  audience?: NotificationAudience;
}

export async function createNotificationSchedule(
  prisma: PrismaClient,
  orgId: string,
  senderId: string,
  input: NotificationScheduleInput,
) {
  if ((input.deliver_at === undefined) === (input.recurrence === undefined))
    throw new InvalidQueryError(
      "Provide exactly one of deliver_at or recurrence",
    );
  let nextOccurrenceAt: Date | undefined;
  if (input.recurrence) {
    try {
      nextOccurrenceAt =
        parseRecurrence(input.recurrence).rule.after(new Date(0), true) ??
        undefined;
    } catch (error) {
      if (error instanceof InvalidRecurrenceError)
        throw new InvalidQueryError(error.message);
      throw error;
    }
  }
  const audience =
    !input.audience || input.audience.kind === "self"
      ? { kind: "self" as const }
      : (
          await resolveNotificationAudience(
            prisma,
            orgId,
            senderId,
            input.audience,
          )
        ).audience;
  return prisma.notificationSchedule.create({
    data: {
      id: genId(),
      orgId,
      userId: senderId,
      audience: audience as Prisma.InputJsonObject,
      dedupeKey: input.dedupe_key ?? genId(),
      type: input.type ?? "direct_notification",
      message: input.message,
      ...(input.data ? { data: input.data as Prisma.InputJsonObject } : {}),
      inApp: input.in_app ?? true,
      channel: input.channel ?? "console",
      ...(input.deliver_at ? { deliverAt: new Date(input.deliver_at) } : {}),
      ...(input.recurrence
        ? { recurrence: input.recurrence, nextOccurrenceAt }
        : {}),
    },
  });
}

export function listNotificationSchedules(
  prisma: PrismaClient,
  orgId: string,
  senderId: string,
) {
  return prisma.notificationSchedule.findMany({
    where: { orgId, userId: senderId },
    orderBy: { createdAt: "desc" },
  });
}

export function cancelNotificationSchedule(
  prisma: PrismaClient,
  orgId: string,
  senderId: string,
  id: string,
) {
  return prisma.notificationSchedule.updateMany({
    where: {
      id,
      orgId,
      userId: senderId,
      // Portable imports are deliberately paused until an owner explicitly
      // resumes or cancels them. Keep cancellation available for that safe
      // imported state as part of the existing creator-owned API.
      status: { in: ["scheduled", "processing", "paused"] },
    },
    data: { status: "cancelled", lockedAt: null },
  });
}
