import {
  AUTOMATION_LIMITS,
  AutomationConflictError,
  AutomationNotFoundError,
  FieldPermissionDeniedError,
  InvalidQueryError,
  PermissionDeniedError,
  SchemaValidationError,
  genId,
  utcTimestampSchema,
  type JsonObject,
  type ScheduleMaterializer,
  type ScheduleOccurrence,
} from "@lastsaas/shared";
import type { PrismaClient } from "@prisma/client";
import { queryProvider } from "../db/provider";
import { withUnitOfWork, type UnitOfWork } from "../db/unit-of-work";
import { nextScheduleOccurrence, retryScheduleContention } from "./occurrences";
import { createQueueEnqueueService } from "../queues/enqueue";
import { lockScheduleRow, validateScheduleDestination } from "./service";

function serialize(row: {
  id: string;
  scheduleId: string;
  occurrenceAt: Date;
  entryId: string;
  createdAt: Date;
}): ScheduleOccurrence {
  return {
    id: row.id,
    schedule_id: row.scheduleId,
    occurrence_at: row.occurrenceAt.toISOString(),
    entry_id: row.entryId,
    created_at: row.createdAt.toISOString(),
  };
}

function pauseReason(error: unknown): string | undefined {
  if (
    error instanceof PermissionDeniedError ||
    error instanceof FieldPermissionDeniedError
  )
    return "creator_authority_revoked";
  if (error instanceof AutomationNotFoundError)
    return "creator_or_destination_unavailable";
  if (
    error instanceof SchemaValidationError ||
    error instanceof InvalidQueryError
  )
    return "payload_or_grants_invalid";
  if (error instanceof AutomationConflictError)
    return "destination_unavailable";
}

export function createScheduleMaterializer(
  prisma: PrismaClient,
  provider = queryProvider(prisma),
): ScheduleMaterializer<UnitOfWork> {
  const enqueue = createQueueEnqueueService(prisma, provider);

  async function materializeOccurrence(
    unit: UnitOfWork,
    scheduleId: string,
    timestamp: string,
    through?: Date,
  ) {
    const parsed = utcTimestampSchema.safeParse(timestamp);
    if (!parsed.success)
      throw new SchemaValidationError(["Invalid occurrence time"]);
    const occurrenceAt = new Date(parsed.data);
    await lockScheduleRow(unit, scheduleId);
    const row = await unit.db.queueSchedule.findUnique({
      where: { id: scheduleId },
      include: { queue: true },
    });
    if (!row) throw new AutomationNotFoundError();
    const existing = await unit.db.queueScheduleOccurrence.findUnique({
      where: { scheduleId_occurrenceAt: { scheduleId, occurrenceAt } },
    });
    const atCursor =
      row.status === "active" &&
      row.nextOccurrenceAt?.getTime() === occurrenceAt.getTime();
    if (existing && !atCursor) return serialize(existing);
    if (!atCursor)
      throw new AutomationConflictError(
        "Occurrence is not the schedule cursor",
      );
    // Replacing timing may rewind to an already published instant. Advance past
    // its durable identity without publishing again, even after entry retention.
    const next = row.recurrence
      ? nextScheduleOccurrence(row.recurrence, through ?? occurrenceAt)
      : null;
    const advance = () =>
      unit.db.queueSchedule.update({
        where: { id: scheduleId },
        data: {
          cursorAt: occurrenceAt,
          nextOccurrenceAt: next,
          status: next ? "active" : "completed",
          pauseReason: null,
        },
      });
    if (existing) {
      await advance();
      return serialize(existing);
    }
    await validateScheduleDestination(
      unit,
      row.orgId,
      row.createdBy,
      row.queue.name,
      row.payload as JsonObject,
    );
    const creator = await unit.db.user.findUniqueOrThrow({
      where: { id: row.createdBy },
      select: { email: true },
    });
    const result = await enqueue.enqueueInTransaction(
      { orgId: row.orgId, userId: row.createdBy, userEmail: creator.email },
      unit,
      row.queue.name,
      {
        entries: [
          { payload: row.payload as JsonObject, available_at: timestamp },
        ],
      },
    );
    const occurrence = await unit.db.queueScheduleOccurrence.create({
      data: {
        id: genId(),
        scheduleId,
        occurrenceAt,
        entryId: result.jobs[0]!.id,
      },
    });
    await advance();
    return serialize(occurrence);
  }

  return {
    materializeOccurrence,
    async materialize(timestamp) {
      const parsed = utcTimestampSchema.safeParse(timestamp);
      if (!parsed.success)
        throw new SchemaValidationError(["Invalid materialization time"]);
      const now = new Date(parsed.data);
      const due = { status: "active", nextOccurrenceAt: { lte: now } };
      let enqueued = 0,
        paused = 0;
      // Bound all work across schedules, rather than 100 for every schedule.
      for (
        let scanned = 0;
        scanned < AUTOMATION_LIMITS.materializePerTick;
        scanned++
      ) {
        const candidate = await prisma.queueSchedule.findFirst({
          where: due,
          orderBy: [{ nextOccurrenceAt: "asc" }, { id: "asc" }],
          select: { id: true },
        });
        if (!candidate) break;
        const outcome = await retryScheduleContention(() =>
          withUnitOfWork({ prisma, provider }, async (unit) => {
            await lockScheduleRow(unit, candidate.id);
            const row = await unit.db.queueSchedule.findUnique({
              where: { id: candidate.id },
              include: { queue: true },
            });
            if (
              !row ||
              row.status !== "active" ||
              !row.nextOccurrenceAt ||
              row.nextOccurrenceAt > now
            )
              return "skipped";
            // Only validation errors pause. Persistence failures always roll back and
            // propagate, including failures in enqueue, occurrence insert or cursor update.
            try {
              await validateScheduleDestination(
                unit,
                row.orgId,
                row.createdBy,
                row.queue.name,
                row.payload as JsonObject,
              );
            } catch (error) {
              const reason = pauseReason(error);
              if (!reason) throw error;
              await unit.db.queueSchedule.update({
                where: { id: row.id },
                data: { status: "paused", pauseReason: reason },
              });
              await unit.db.auditLog.create({
                data: {
                  id: genId(),
                  orgId: row.orgId,
                  userId: row.createdBy,
                  action: "pause_schedule",
                  resourceType: "schedule",
                  resourceId: row.id,
                  details: { reason },
                },
              });
              return "paused";
            }
            const existing = await unit.db.queueScheduleOccurrence.findUnique({
              where: {
                scheduleId_occurrenceAt: {
                  scheduleId: row.id,
                  occurrenceAt: row.nextOccurrenceAt,
                },
              },
              select: { id: true },
            });
            await materializeOccurrence(
              unit,
              row.id,
              row.nextOccurrenceAt.toISOString(),
              now,
            );
            return existing ? "skipped" : "enqueued";
          }),
        );
        if (outcome === "enqueued") enqueued++;
        if (outcome === "paused") paused++;
      }
      return {
        enqueued,
        paused,
        has_more: (await prisma.queueSchedule.count({ where: due })) > 0,
      };
    },
  };
}
