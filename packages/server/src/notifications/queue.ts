import { Prisma, type PrismaClient } from "@prisma/client";

import {
  enqueueNotification,
  extractQueuedDelivery,
  type QueuedDelivery,
} from "../db/notifications";
import { log } from "../logger";
import type { NotificationDispatcher } from "./channels";

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 30_000;
const PROCESSING_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 25;

export interface QueueNotificationInput {
  orgId: string;
  userId: string;
  scheduleId?: string;
  occurrenceAt?: Date;
  type: string;
  message: string;
  delivery: QueuedDelivery;
  data?: object;
  inApp?: boolean;
  dedupeKey?: string;
}

interface QueueRow {
  id: string;
  data: Prisma.JsonValue | null;
  attempts: number;
  errorLogs: Prisma.JsonValue | null;
}

function dueWhere(now: Date) {
  return {
    lockedAt: null,
    OR: [
      {
        status: "pending",
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      {
        status: "failed",
        nextAttemptAt: { not: null, lte: now },
      },
    ],
  };
}

function appendErrorLog(value: unknown, message: string): string[] {
  const existing = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
  return [...existing, message].slice(-10);
}

export class NotificationQueue {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  async enqueue(input: QueueNotificationInput): Promise<string> {
    const row = await enqueueNotification(this.prisma, input);
    return row.id;
  }

  async processDue(
    now = new Date(),
    batchSize = DEFAULT_BATCH_SIZE,
  ): Promise<number> {
    const staleBefore = new Date(now.getTime() - PROCESSING_STALE_AFTER_MS);
    await this.prisma.notification.updateMany({
      where: {
        status: "processing",
        lockedAt: { not: null, lt: staleBefore },
      },
      data: { status: "pending", lockedAt: null },
    });

    const rows = await this.prisma.notification.findMany({
      where: dueWhere(now),
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
      take: batchSize,
      select: {
        id: true,
        data: true,
        attempts: true,
        errorLogs: true,
      },
    });

    let processed = 0;
    for (const row of rows) {
      if (await this.processRow(row, now)) processed += 1;
    }
    return processed;
  }

  private async processRow(row: QueueRow, now: Date): Promise<boolean> {
    const claimed = await this.prisma.notification.updateMany({
      where: { id: row.id, ...dueWhere(now) },
      data: { status: "processing", lockedAt: now },
    });
    if (claimed.count === 0) return false;

    try {
      const delivery = extractQueuedDelivery(row.data);
      if (!delivery) {
        throw new Error("Notification is missing queue delivery metadata");
      }
      const delivered = await this.dispatcher.send(delivery, delivery.channels);
      if (!delivered) throw new Error("Notification delivery failed");

      await this.prisma.notification.update({
        where: { id: row.id },
        data: {
          status: "sent",
          lockedAt: null,
          nextAttemptAt: null,
          attempts: row.attempts + 1,
        },
      });
    } catch (error) {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= MAX_ATTEMPTS;
      const message =
        error instanceof Error ? error.message : "Notification delivery failed";
      log.error(
        "notifications",
        `delivery ${row.id} attempt ${attempts}/${MAX_ATTEMPTS} failed${
          exhausted
            ? "; giving up"
            : `; retrying in ${(RETRY_BACKOFF_MS * attempts) / 1000}s`
        }: ${message}`,
      );
      await this.prisma.notification.update({
        where: { id: row.id },
        data: {
          status: exhausted ? "failed" : "pending",
          lockedAt: null,
          attempts,
          nextAttemptAt: exhausted
            ? null
            : new Date(now.getTime() + RETRY_BACKOFF_MS * attempts),
          errorLogs: appendErrorLog(
            row.errorLogs,
            message,
          ) as Prisma.InputJsonValue,
        },
      });
    }
    return true;
  }
}
