import stringify from "fast-json-stable-stringify";
import { createHash } from "node:crypto";
import {
  AutomationConflictError,
  enqueueRequestSchema,
  genId,
  queuePayloadSchema,
  type AutomationContext,
  type EnqueueEntry,
  type EnqueueRequest,
  type EnqueueResult,
  type QueueEntryReceipt,
  type QueueService,
  type Schema,
} from "@lastsaas/shared";
import type { Prisma, PrismaClient, Queue, QueueEntry } from "@prisma/client";
import { queryProvider } from "../db/provider";
import { withUnitOfWork, type UnitOfWork } from "../db/unit-of-work";
import { lockQueue, parseQueueRequest } from "./config";
import { authorizeQueueAction } from "./permissions";
import { unitJobs, subscriptionPolicy, subscriptionQueue } from "../jobs";

/** Omitted availability is a stable immediate marker, never the current clock. */
function requestHash(entry: EnqueueEntry) {
  return createHash("sha256")
    .update(
      stringify({
        payload: entry.payload,
        available_at:
          entry.available_at === undefined
            ? null
            : new Date(entry.available_at).toISOString(),
      }),
    )
    .digest("hex");
}

function receipt(row: QueueEntry): QueueEntryReceipt {
  return {
    id: row.id,
    queue_id: row.queueId,
    schema_version: row.schemaVersion,
    available_at: row.availableAt.toISOString(),
    created_at: row.createdAt.toISOString(),
  };
}

/** Called only after schema and queue create authority have been validated.
 * Resolve all key conflicts before inserting anything, including in a supplied UoW. */
async function persistBatch(
  unit: UnitOfWork,
  queue: Queue,
  producerUserId: string | null,
  input: EnqueueRequest,
): Promise<EnqueueResult> {
  if (!queue.enabled) throw new AutomationConflictError("Queue is disabled");
  const subscriptions = await unit.db.queueSubscription.findMany({
    where: { queueId: queue.id, enabled: true },
  });
  if (!subscriptions.length)
    throw new AutomationConflictError("Queue has no enabled subscriptions");

  const now = new Date();
  const keys = input.entries.flatMap((entry) =>
    entry.idempotency_key === undefined ? [] : [entry.idempotency_key],
  );
  const retained = await unit.db.queueEntry.findMany({
    where: { queueId: queue.id, idempotencyKey: { in: keys } },
  });
  const byKey = new Map(retained.map((row) => [row.idempotencyKey!, row]));
  const pending = new Map<string, { hash: string; index: number }>();
  const candidates: Array<{
    input: EnqueueEntry;
    hash: string;
    retained?: QueueEntry;
    duplicate?: number;
  }> = [];
  for (const entry of input.entries) {
    const hash = requestHash(entry);
    const key = entry.idempotency_key;
    const row = key === undefined ? undefined : byKey.get(key);
    const prior = key === undefined ? undefined : pending.get(key);
    if ((row && row.idempotencyHash !== hash) || (prior && prior.hash !== hash))
      throw new AutomationConflictError(
        "Idempotency key conflicts with request",
      );
    candidates.push({
      input: entry,
      hash,
      retained: row,
      duplicate: prior?.index,
    });
    if (key !== undefined && !prior)
      pending.set(key, { hash, index: candidates.length - 1 });
  }

  const rows: QueueEntry[] = [];
  for (const candidate of candidates) {
    if (candidate.duplicate !== undefined) {
      rows.push(rows[candidate.duplicate]!);
      continue;
    }
    if (candidate.retained) {
      rows.push(candidate.retained);
      continue;
    }
    const row = await unit.db.queueEntry.create({
      data: {
        id: genId(),
        queueId: queue.id,
        payload: candidate.input.payload as Prisma.InputJsonObject,
        schemaVersion: queue.schemaVersion,
        producerUserId,
        availableAt:
          candidate.input.available_at === undefined
            ? now
            : new Date(candidate.input.available_at),
        idempotencyKey: candidate.input.idempotency_key,
        idempotencyHash:
          candidate.input.idempotency_key === undefined ? null : candidate.hash,
        createdAt: now,
      },
    });
    for (const subscription of subscriptions) {
      const id = crypto.randomUUID();
      await unit.db.queueDelivery.create({
        data: {
          id,
          queueId: queue.id,
          entryId: row.id,
          subscriptionId: subscription.id,
        },
      });
      await unitJobs(unit).send(
        {
          id,
          queue: subscriptionQueue(subscription.id),
          data: {
            entry_id: row.id,
            schema_version: row.schemaVersion,
            payload: candidate.input.payload,
          },
          availableAt: row.availableAt.toISOString(),
          policy: subscriptionPolicy(subscription),
        },
        unit.db,
      );
    }
    await unit.db.auditLog.create({
      data: {
        id: genId(),
        orgId: queue.orgId,
        userId: producerUserId ?? "system",
        action: "enqueue_queue_entry",
        resourceType: "queue_entry",
        resourceId: row.id,
        details: { queue_id: queue.id, delivery_count: subscriptions.length },
      },
    });
    rows.push(row);
  }
  return {
    entries: rows.map(receipt),
    delivery_count: await unit.db.queueDelivery.count({
      where: {
        queueId: queue.id,
        entryId: { in: [...new Set(rows.map((r) => r.id))] },
      },
    }),
  };
}

export type QueueEnqueueService = Pick<
  QueueService<UnitOfWork>,
  "enqueue" | "enqueueInTransaction"
>;

export async function enqueueQueueInTransaction(
  context: AutomationContext,
  unit: UnitOfWork,
  name: string,
  input: EnqueueRequest,
) {
  const parsed = parseQueueRequest(enqueueRequestSchema, input);
  const queue = await lockQueue(unit, context, name);
  await authorizeQueueAction(unit.db, context, name, "create");
  for (const entry of parsed.entries)
    parseQueueRequest(
      queuePayloadSchema(queue.schema as Schema),
      entry.payload,
    );
  return persistBatch(unit, queue, context.userId, parsed);
}

export function createQueueEnqueueService(
  prisma: PrismaClient,
  provider = queryProvider(prisma),
): QueueEnqueueService {
  return {
    enqueueInTransaction: enqueueQueueInTransaction,
    enqueue: (context, name, input) =>
      withUnitOfWork({ prisma, provider }, (unit) =>
        enqueueQueueInTransaction(context, unit, name, input),
      ),
  };
}
