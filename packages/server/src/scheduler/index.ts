import { Prisma, type PrismaClient } from "@prisma/client";
import { Cron } from "croner";

import type { AppConfig } from "../config";
import { databaseProvider } from "../config";
import { parseRecurrence } from "../lib/recurrence";
import type { NotificationQueue } from "../notifications/queue";

const SQLITE_POLL_PATTERN = "*/10 * * * * *";
const POSTGRES_POLL_PATTERN = "* * * * *";
const POSTGRES_QUEUE = "lastsaas-background";
const DEFAULT_BATCH_SIZE = 25;
const PROCESSING_STALE_AFTER_MS = 5 * 60_000;
const RECURRENCE_CHUNK_DAYS = 731;
const MAX_OCCURRENCES_PER_POLL = 500;
const DAY_MS = 24 * 60 * 60_000;

function dataObject(value: Prisma.JsonValue | null): object | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.JsonObject)
    : undefined;
}

function channels(value: string): string[] | undefined {
  const parsed = value
    .split(",")
    .map((channel) => channel.trim())
    .filter(Boolean);
  return parsed.length ? parsed : undefined;
}

export interface BackgroundScheduler {
  readonly name: "sqlite" | "pg-boss";
  start(): Promise<void>;
  stop(): Promise<void>;
  flushOnce(now?: Date): Promise<number>;
}

interface ScheduleRow {
  id: string;
  orgId: string;
  userId: string;
  type: string;
  message: string;
  data: Prisma.JsonValue | null;
  inApp: boolean;
  channel: string;
  deliverAt: Date | null;
  recurrence: string | null;
  nextOccurrenceAt: Date | null;
  lastEnqueuedAt: Date | null;
  user: { email: string };
}

export class NotificationScheduleProcessor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly queue: NotificationQueue,
    private readonly maxOccurrencesPerPoll = MAX_OCCURRENCES_PER_POLL,
  ) {}

  async processDue(
    now = new Date(),
    batchSize = DEFAULT_BATCH_SIZE,
  ): Promise<number> {
    const staleBefore = new Date(now.getTime() - PROCESSING_STALE_AFTER_MS);
    await this.prisma.notificationSchedule.updateMany({
      where: {
        status: "processing",
        lockedAt: { not: null, lt: staleBefore },
      },
      data: { status: "scheduled", lockedAt: null },
    });

    const rows = await this.prisma.notificationSchedule.findMany({
      where: {
        status: "scheduled",
        lockedAt: null,
        OR: [
          { recurrence: null, deliverAt: { not: null, lte: now } },
          {
            recurrence: { not: null },
            OR: [
              { nextOccurrenceAt: null },
              { nextOccurrenceAt: { lte: now } },
            ],
          },
        ],
      },
      orderBy: [
        { nextOccurrenceAt: "asc" },
        { deliverAt: "asc" },
        { createdAt: "asc" },
      ],
      take: batchSize,
      select: {
        id: true,
        orgId: true,
        userId: true,
        type: true,
        message: true,
        data: true,
        inApp: true,
        channel: true,
        deliverAt: true,
        recurrence: true,
        nextOccurrenceAt: true,
        lastEnqueuedAt: true,
        user: { select: { email: true } },
      },
    });

    let materialized = 0;
    for (const row of rows) {
      materialized += await this.processRow(row, now);
    }
    return materialized;
  }

  private async processRow(row: ScheduleRow, now: Date): Promise<number> {
    const claimed = await this.prisma.notificationSchedule.updateMany({
      where: {
        id: row.id,
        status: "scheduled",
        lockedAt: null,
        recurrence: row.recurrence,
        ...(row.recurrence !== null
          ? { nextOccurrenceAt: row.nextOccurrenceAt }
          : { deliverAt: row.deliverAt }),
      },
      data: { status: "processing", lockedAt: now },
    });
    if (claimed.count === 0) return 0;

    try {
      return row.recurrence !== null
        ? await this.processRecurringRow(row, row.recurrence, now)
        : await this.processOneShotRow(row);
    } catch (error) {
      await this.prisma.notificationSchedule.updateMany({
        where: { id: row.id, status: "processing", lockedAt: now },
        data: { status: "scheduled", lockedAt: null },
      });
      throw error;
    }
  }

  private async processOneShotRow(row: ScheduleRow): Promise<number> {
    if (!row.deliverAt) return 0;

    await this.enqueueOccurrence(row, row.deliverAt);
    await this.prisma.notificationSchedule.update({
      where: { id: row.id },
      data: {
        status: "sent",
        lockedAt: null,
        lastEnqueuedAt: row.deliverAt,
      },
    });
    return 1;
  }

  private async processRecurringRow(
    row: ScheduleRow,
    recurrence: string,
    now: Date,
  ): Promise<number> {
    const parsed = parseRecurrence(recurrence);
    const firstUnprocessed =
      row.nextOccurrenceAt ??
      parsed.rule.after(
        row.lastEnqueuedAt ?? parsed.startsAt,
        row.lastEnqueuedAt === null,
      );

    if (!firstUnprocessed || firstUnprocessed > now) {
      await this.finishRecurringClaim(
        row.id,
        row.lastEnqueuedAt,
        firstUnprocessed,
      );
      return 0;
    }

    // Bound each expansion by both window and occurrence count: a dense rule
    // (hourly or finer) with a long backlog would otherwise blow past the
    // recurrence expansion limits and wedge every poll. Either bound leaves the
    // persisted cursor on the first unprocessed occurrence, so the backlog
    // drains one chunk per poll.
    const chunkEnd = new Date(
      Math.min(
        now.getTime(),
        firstUnprocessed.getTime() + RECURRENCE_CHUNK_DAYS * DAY_MS,
      ),
    );
    const occurrences = parsed.rule.between(
      firstUnprocessed,
      chunkEnd,
      true,
      (_, count) => count < this.maxOccurrencesPerPoll,
    );

    for (const occurrence of occurrences) {
      await this.enqueueOccurrence(row, occurrence);
    }

    const lastEnqueued = occurrences.at(-1);
    const cursorFrom =
      lastEnqueued && occurrences.length >= this.maxOccurrencesPerPoll
        ? lastEnqueued
        : chunkEnd;
    const nextOccurrence = parsed.rule.after(cursorFrom, false);
    await this.finishRecurringClaim(
      row.id,
      lastEnqueued ?? row.lastEnqueuedAt,
      nextOccurrence,
    );
    return occurrences.length;
  }

  private async finishRecurringClaim(
    id: string,
    lastEnqueuedAt: Date | null,
    nextOccurrenceAt: Date | null,
  ): Promise<void> {
    await this.prisma.notificationSchedule.update({
      where: { id },
      data: {
        status: nextOccurrenceAt ? "scheduled" : "sent",
        lockedAt: null,
        lastEnqueuedAt,
        nextOccurrenceAt,
      },
    });
  }

  private async enqueueOccurrence(
    row: ScheduleRow,
    occurrenceAt: Date,
  ): Promise<void> {
    const data = dataObject(row.data);
    const deliveryChannels = channels(row.channel);
    await this.queue.enqueue({
      orgId: row.orgId,
      userId: row.userId,
      scheduleId: row.id,
      occurrenceAt,
      type: row.type,
      message: row.message,
      ...(data ? { data } : {}),
      inApp: row.inApp,
      dedupeKey: `notification-schedule:${row.id}:${occurrenceAt.toISOString()}`,
      delivery: {
        to: row.user.email,
        subject: row.message,
        text: row.message,
        ...(deliveryChannels ? { channels: deliveryChannels } : {}),
      },
    });
  }
}

abstract class BaseBackgroundScheduler implements BackgroundScheduler {
  abstract readonly name: "sqlite" | "pg-boss";

  private readonly schedules: NotificationScheduleProcessor;

  constructor(
    prisma: PrismaClient,
    protected readonly queue: NotificationQueue,
  ) {
    this.schedules = new NotificationScheduleProcessor(prisma, queue);
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  async flushOnce(now = new Date()): Promise<number> {
    const materialized = await this.schedules.processDue(now);
    await this.queue.processDue(now);
    return materialized;
  }

  protected logError(error: unknown): void {
    console.error(`[Scheduler:${this.name}] background flush failed`, error);
  }
}

export class SqliteBackgroundScheduler extends BaseBackgroundScheduler {
  readonly name = "sqlite" as const;
  private job: Cron | null = null;

  async start(): Promise<void> {
    if (this.job) return;
    await this.flushOnce();
    this.job = new Cron(
      SQLITE_POLL_PATTERN,
      { protect: true },
      () => void this.flushOnce().catch((error) => this.logError(error)),
    );
  }

  async stop(): Promise<void> {
    this.job?.stop();
    this.job = null;
  }
}

type PgBossInstance = InstanceType<(typeof import("pg-boss"))["PgBoss"]>;

export class PgBossBackgroundScheduler extends BaseBackgroundScheduler {
  readonly name = "pg-boss" as const;
  private boss: PgBossInstance | null = null;

  constructor(
    prisma: PrismaClient,
    queue: NotificationQueue,
    private readonly databaseUrl: string,
  ) {
    super(prisma, queue);
  }

  async start(): Promise<void> {
    if (this.boss) return;

    const { PgBoss } = await import("pg-boss");
    const boss = new PgBoss({ connectionString: this.databaseUrl });
    boss.on("error", (error: Error) => this.logError(error));
    await boss.start();
    try {
      if (!(await boss.getQueue(POSTGRES_QUEUE))) {
        await boss.createQueue(POSTGRES_QUEUE, {
          retryLimit: 3,
          retryDelay: 30,
          retryBackoff: true,
        });
      }
      await boss.work(POSTGRES_QUEUE, async () => {
        await this.flushOnce();
      });
      await boss.schedule(POSTGRES_QUEUE, POSTGRES_POLL_PATTERN);
      await boss.send(POSTGRES_QUEUE, { reason: "startup" });
      this.boss = boss;
    } catch (error) {
      await boss.stop({ graceful: true });
      throw error;
    }
  }

  async stop(): Promise<void> {
    const boss = this.boss;
    if (!boss) return;
    this.boss = null;
    await boss.offWork(POSTGRES_QUEUE);
    await boss.stop({ graceful: true });
  }
}

export function createBackgroundScheduler(
  prisma: PrismaClient,
  queue: NotificationQueue,
  config: AppConfig,
): BackgroundScheduler {
  return databaseProvider(config.databaseUrl) === "postgresql"
    ? new PgBossBackgroundScheduler(prisma, queue, config.databaseUrl)
    : new SqliteBackgroundScheduler(prisma, queue);
}
