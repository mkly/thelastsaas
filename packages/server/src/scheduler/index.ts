import { pruneRecordHistory } from "../db/record-history-storage";
import { postgresJobSchema } from "../jobs";
import { InvalidQueryError, PermissionDeniedError } from "@lastsaas/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { Cron } from "croner";

import type { AppConfig } from "../config";
import { databaseProvider } from "../config";
import type { DbProvider } from "../db/query/adapters/types";
import {
  resolveNotificationAudience,
  type NotificationRecipient,
} from "../db/notification-audiences";
import { queryProvider } from "../db/provider";
import { withUnitOfWork } from "../db/unit-of-work";
import { notificationDeliveryInput } from "../db/notifications";
import { parseRecurrence } from "../lib/recurrence";
import { log } from "../logger";
import type { NotificationQueue } from "../notifications/queue";
import { maintainQueues } from "../queues/maintenance";
import { createScheduleMaterializer } from "../schedules/materialize";
import {
  lockOccurrenceSource,
  nextScheduleOccurrence,
  retryScheduleContention,
} from "../schedules/occurrences";

const SQLITE_POLL_PATTERN = "*/10 * * * * *";
const POSTGRES_POLL_PATTERN = "* * * * *";
const POSTGRES_QUEUE = "lastsaas-background";
const DEFAULT_BATCH_SIZE = 25;
const PROCESSING_STALE_AFTER_MS = 5 * 60_000;

function dataObject(value: Prisma.JsonValue | null): object | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Prisma.JsonObject)
    : undefined;
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
  audience: Prisma.JsonValue | null;
  type: string;
  message: string;
  data: Prisma.JsonValue | null;
  subject: string;
  deliverAt: Date | null;
  recurrence: string | null;
  nextOccurrenceAt: Date | null;
  lastEnqueuedAt: Date | null;
}

export class NotificationScheduleProcessor {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly queue: NotificationQueue,
    private readonly provider: DbProvider = queryProvider(prisma),
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
      select: { id: true },
    });

    let materialized = 0;
    for (const row of rows) {
      materialized += await this.processRow(row.id, now);
    }
    return materialized;
  }

  private async processRow(id: string, now: Date): Promise<number> {
    let materialized = 0;
    {
      const outcome = await retryScheduleContention(() =>
        withUnitOfWork(
          { prisma: this.prisma, provider: this.provider },
          async (unit) => {
            await lockOccurrenceSource(unit, "notification_schedules", id);
            // A competing worker or cancellation may have changed this cursor.
            const row = await unit.db.notificationSchedule.findUnique({
              where: { id },
            });
            if (!row || row.status !== "scheduled" || row.lockedAt)
              return false;
            const parsed = row.recurrence
              ? parseRecurrence(row.recurrence)
              : null;
            const occurrence = parsed
              ? (row.nextOccurrenceAt ??
                parsed.rule.after(
                  row.lastEnqueuedAt ?? parsed.startsAt,
                  row.lastEnqueuedAt === null,
                ))
              : row.deliverAt;
            if (!occurrence || occurrence > now) {
              if (row.recurrence)
                await unit.db.notificationSchedule.update({
                  where: { id },
                  data: {
                    nextOccurrenceAt: occurrence,
                    status: occurrence ? "scheduled" : "sent",
                  },
                });
              return false;
            }
            let recipients: NotificationRecipient[];
            try {
              // Self schedules also lose authority when their owner leaves the org.
              const member = await unit.db.member.findUnique({
                where: {
                  organizationId_userId: {
                    organizationId: row.orgId,
                    userId: row.userId,
                  },
                },
              });
              if (!member) throw new PermissionDeniedError();
              ({ recipients } = await resolveNotificationAudience(
                unit.db,
                row.orgId,
                row.userId,
                row.audience,
                { atDelivery: true },
              ));
            } catch (error) {
              if (!(
                error instanceof PermissionDeniedError ||
                error instanceof InvalidQueryError
              ))
                throw error;
              await unit.db.notificationSchedule.update({
                where: { id },
                data: {
                  status: "cancelled",
                  lockedAt: null,
                },
              });
              log.info(
                "scheduler",
                `Cancelled notification schedule ${id}: authority or audience invalid`,
              );
              return false;
            }
            const next = row.recurrence
              ? nextScheduleOccurrence(row.recurrence, now)
              : null;
            await this.enqueueOccurrence(row, occurrence, unit.db, recipients);
            await unit.db.notificationSchedule.update({
              where: { id },
              data: {
                status: next ? "scheduled" : "sent",
                lockedAt: null,
                lastEnqueuedAt: occurrence,
                nextOccurrenceAt: next,
              },
            });
            return true;
          },
          { maxWait: 5000, timeout: 30_000 },
        ),
      );
      if (outcome) materialized++;
    }
    return materialized;
  }

  private async enqueueOccurrence(
    row: ScheduleRow,
    occurrenceAt: Date,
    transaction: Prisma.TransactionClient,
    recipients: NotificationRecipient[],
  ): Promise<void> {
    const data = dataObject(row.data);
    for (const recipient of recipients) {
      const input = notificationDeliveryInput(
        row.orgId,
        row.userId,
        recipient,
        {
          type: row.type,
          message: row.message,
          subject: row.subject,
          ...(data ? { data } : {}),
          dedupeKey: `notification-schedule:${row.id}:${occurrenceAt.toISOString()}`,
        },
      );
      if (input)
        await this.queue.enqueue(
          { ...input, scheduleId: row.id, occurrenceAt },
          transaction,
        );
    }
  }
}

abstract class BaseBackgroundScheduler implements BackgroundScheduler {
  abstract readonly name: "sqlite" | "pg-boss";

  private readonly schedules: NotificationScheduleProcessor;
  private readonly prisma: PrismaClient;
  private readonly materializer: ReturnType<typeof createScheduleMaterializer>;

  constructor(
    prisma: PrismaClient,
    protected readonly queue: NotificationQueue,
    provider: DbProvider = "sqlite",
  ) {
    this.schedules = new NotificationScheduleProcessor(prisma, queue, provider);
    this.prisma = prisma;
    this.materializer = createScheduleMaterializer(prisma, provider);
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  async flushOnce(now = new Date()): Promise<number> {
    await this.prisma.transactionRequest.deleteMany({
      where: { expiresAt: { lte: now } },
    });
    await maintainQueues(this.prisma, now);
    await pruneRecordHistory(this.prisma, now);
    // A failed queue producer must not stall independent notification delivery.
    // Log fixed metadata only: persistence diagnostics may contain payload values.
    const general = await this.materializer
      .materialize(now.toISOString())
      .catch(() => {
        log.error(`scheduler:${this.name}`, "schedule materialization failed");
        return { enqueued: 0 };
      });
    const materialized = await this.schedules.processDue(now);
    await this.queue.processDue(now);
    return materialized + general.enqueued;
  }

  protected logError(error: unknown): void {
    log.error(`scheduler:${this.name}`, "background flush failed", error);
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
    super(prisma, queue, "postgresql");
  }

  async start(): Promise<void> {
    if (this.boss) return;

    const { PgBoss } = await import("pg-boss");
    const boss = new PgBoss({
      connectionString: this.databaseUrl,
      schema: postgresJobSchema(this.databaseUrl),
    });
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
