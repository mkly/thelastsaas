import { parseRequest as parseRequest } from "../lib/transport";
import {
  AutomationConflictError,
  AutomationNotFoundError,
  PermissionDeniedError,
  SchemaValidationError,
  genId,
  pageRequestSchema,
  queuePayloadSchema,
  scheduleCreateSchema,
  scheduleIdSchema,
  scheduleUpdateSchema,
  type AutomationContext,
  type JsonObject,
  type QueueSchedule,
  type ScheduleService,
  type ScheduleTiming,
  type Schema,
} from "@lastsaas/shared";
import type {
  Prisma,
  PrismaClient,
  QueueSchedule as ScheduleRow,
} from "@prisma/client";
import { hasPermission } from "../db/casbin";
import { queryProvider } from "../db/provider";
import { lockOccurrenceSource } from "./occurrences";
import { withUnitOfWork, type UnitOfWork } from "../db/unit-of-work";
import { InvalidRecurrenceError, parseRecurrence } from "../lib/recurrence";
import {
  auditQueueConfiguration,
  lockQueue,
  queuePageCursor,
  queuePagePosition,
  requireQueueMembership,
} from "../queues/config";
import { authorizeQueueAction } from "../queues/permissions";

/** Keep the first unprocessed occurrence, including past instants for catch-up. */
export function scheduleTimingState(timing: ScheduleTiming) {
  if (timing.kind === "once") {
    const deliverAt = new Date(timing.at);
    return {
      deliverAt,
      recurrence: null,
      timezone: null,
      nextOccurrenceAt: deliverAt,
    };
  }
  try {
    const parsed = parseRecurrence(timing.recurrence);
    return {
      deliverAt: null,
      recurrence: timing.recurrence,
      timezone: parsed.timezone,
      nextOccurrenceAt: parsed.rule.after(parsed.startsAt, true),
    };
  } catch (error) {
    if (error instanceof InvalidRecurrenceError)
      throw new SchemaValidationError(["Invalid schedule recurrence"]);
    throw error;
  }
}

function serialize(
  row: ScheduleRow & { queue: { name: string } },
): QueueSchedule {
  return {
    id: row.id,
    organization_id: row.orgId,
    created_by: row.createdBy,
    queue_id: row.queueId,
    queue: row.queue.name,
    payload: row.payload as JsonObject,
    timing:
      row.recurrence !== null
        ? { kind: "recurring", recurrence: row.recurrence }
        : { kind: "once", at: row.deliverAt!.toISOString() },
    timezone: row.timezone,
    status: row.status as QueueSchedule["status"],
    pause_reason: row.pauseReason,
    cursor_at: row.cursorAt?.toISOString() ?? null,
    next_occurrence_at: row.nextOccurrenceAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function requireGate(
  db: Prisma.TransactionClient,
  context: AutomationContext,
  resource: string,
  action: "write" | "read" | "update" | "delete",
) {
  if (
    !(await hasPermission(db, context.orgId, context.userId, resource, action))
  )
    throw new PermissionDeniedError();
}

async function findSchedule(
  db: Prisma.TransactionClient,
  context: AutomationContext,
  id: string,
) {
  await requireQueueMembership(db, context);
  const row = await db.queueSchedule.findUnique({
    where: {
      orgId_id: {
        orgId: context.orgId,
        id: parseRequest(scheduleIdSchema, id),
      },
    },
    include: { queue: { select: { name: true } } },
  });
  if (!row) throw new AutomationNotFoundError();
  return row;
}

/** Same lock for CRUD and the future materializer; refetch after acquiring it.
 * Lock schedules before their destination queues to keep a consistent order. */
export async function lockScheduleRow(unit: UnitOfWork, id: string) {
  await lockOccurrenceSource(unit, "queue_schedules", id);
}

/** Validate without enqueueing. Execution must call this with the stored creator,
 * never the editing administrator. Resolve email from current database identity. */
export async function validateScheduleDestination(
  unit: UnitOfWork,
  orgId: string,
  creatorId: string,
  name: string,
  payload: JsonObject,
) {
  const creator = await unit.db.user.findUnique({
    where: { id: creatorId },
    select: { email: true },
  });
  if (!creator) throw new AutomationNotFoundError();
  const context = { orgId, userId: creatorId, userEmail: creator.email };
  const queue = await lockQueue(unit, context, name);
  await authorizeQueueAction(unit.db, context, name, "create");
  const schema = queue.schema as Schema;
  parseRequest(queuePayloadSchema(schema), payload);
  if (!queue.enabled) throw new AutomationConflictError("Queue is disabled");
  if (
    !(await unit.db.queueSubscription.count({
      where: { queueId: queue.id, enabled: true },
    }))
  )
    throw new AutomationConflictError("Queue has no enabled subscriptions");
  return queue;
}

/** Transport-independent CRUD. No implicit owner grants and no queue read gate. */
export function createScheduleService(
  prisma: PrismaClient,
  provider = queryProvider(prisma),
): ScheduleService {
  const source = { prisma, provider };
  return {
    async create(context, input) {
      const parsed = parseRequest(scheduleCreateSchema, input);
      const timing = scheduleTimingState(parsed.timing);
      return withUnitOfWork(source, async (unit) => {
        await requireQueueMembership(unit.db, context);
        await requireGate(unit.db, context, "/schedules", "write");
        const queue = await validateScheduleDestination(
          unit,
          context.orgId,
          context.userId,
          parsed.queue,
          parsed.payload,
        );
        const row = await unit.db.queueSchedule.create({
          data: {
            id: genId(),
            orgId: context.orgId,
            createdBy: context.userId,
            queueId: queue.id,
            payload: parsed.payload as Prisma.InputJsonObject,
            ...timing,
            status: !parsed.enabled
              ? "paused"
              : timing.nextOccurrenceAt
                ? "active"
                : "completed",
            pauseReason: parsed.enabled ? null : "disabled",
          },
          include: { queue: { select: { name: true } } },
        });
        await auditQueueConfiguration(
          unit.db,
          context,
          "create_schedule",
          row.id,
          "schedule",
        );
        return serialize(row);
      });
    },
    async list(context, input) {
      const { limit, cursor } = parseRequest(pageRequestSchema, input);
      // A cursor is bound to both organization and principal; scan remains bounded
      // even when few schedules are visible to this reader.
      const scope = JSON.stringify([
        "schedules:v1",
        context.orgId,
        context.userId,
      ]);
      const position = queuePagePosition(cursor, scope);
      return withUnitOfWork(source, async ({ db }) => {
        await requireQueueMembership(db, context);
        const candidates = await db.queueSchedule.findMany({
          where: { orgId: context.orgId, ...position },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit + 1,
          include: { queue: { select: { name: true } } },
        });
        const scanned = candidates.slice(0, limit);
        const items: QueueSchedule[] = [];
        for (const row of scanned)
          if (
            await hasPermission(
              db,
              context.orgId,
              context.userId,
              `/schedules/${row.id}`,
              "read",
            )
          )
            items.push(serialize(row));
        return {
          items,
          next_cursor:
            candidates.length > limit
              ? queuePageCursor(scanned[scanned.length - 1]!, scope)
              : null,
        };
      });
    },
    async show(context, id) {
      return withUnitOfWork(source, async ({ db }) => {
        const row = await findSchedule(db, context, id);
        await requireGate(db, context, `/schedules/${id}`, "read");
        return serialize(row);
      });
    },
    async update(context, id, input) {
      const parsed = parseRequest(scheduleUpdateSchema, input);
      const timing =
        parsed.timing === undefined
          ? undefined
          : scheduleTimingState(parsed.timing);
      return withUnitOfWork(source, async (unit) => {
        await findSchedule(unit.db, context, id);
        await requireGate(unit.db, context, `/schedules/${id}`, "update");
        await lockScheduleRow(unit, id);
        const row = await findSchedule(unit.db, context, id);
        const payload = parsed.payload ?? (row.payload as JsonObject);
        const queue = await validateScheduleDestination(
          unit,
          row.orgId,
          row.createdBy,
          parsed.queue ?? row.queue.name,
          payload,
        );
        const nextOccurrenceAt = timing
          ? timing.nextOccurrenceAt
          : row.nextOccurrenceAt;
        const enabled = parsed.enabled ?? row.status !== "paused";
        const status = !enabled
          ? "paused"
          : nextOccurrenceAt
            ? "active"
            : "completed";
        const updated = await unit.db.queueSchedule.update({
          where: { id },
          data: {
            queueId: queue.id,
            payload: payload as Prisma.InputJsonObject,
            ...(timing ? { ...timing, cursorAt: null } : {}),
            status,
            pauseReason:
              status === "paused"
                ? parsed.enabled === false
                  ? "disabled"
                  : row.pauseReason
                : null,
          },
          include: { queue: { select: { name: true } } },
        });
        await auditQueueConfiguration(
          unit.db,
          context,
          "update_schedule",
          id,
          "schedule",
        );
        return serialize(updated);
      });
    },
    async delete(context, id) {
      await withUnitOfWork(source, async (unit) => {
        await findSchedule(unit.db, context, id);
        await requireGate(unit.db, context, `/schedules/${id}`, "delete");
        await lockScheduleRow(unit, id);
        await findSchedule(unit.db, context, id);
        await unit.db.queueSchedule.delete({ where: { id } });
        await auditQueueConfiguration(
          unit.db,
          context,
          "delete_schedule",
          id,
          "schedule",
        );
      });
    },
  };
}
