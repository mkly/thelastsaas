import {
  InvalidQueryError,
  deliveryListSchema,
  entryListSchema,
  type JsonObject,
  type QueueDelivery,
  type QueueService,
  type Schema,
} from "@lastsaas/shared";
import type {
  PrismaClient,
  QueueDelivery as DeliveryRow,
  QueueEntry as EntryRow,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { queryProvider } from "../db/provider";
import { compileWhere } from "../db/query/compile";
import { queryAdapter } from "../db/query/adapters";
import { queryRows, sql } from "../db/query/kysely";
import { withUnitOfWork, type UnitOfWork } from "../db/unit-of-work";
import {
  parseQueueRequest,
  queuePageCursor,
  queuePagePosition,
} from "./config";
import { authorizeQueueAction } from "./permissions";
import { unitJobs, jobsFor, subscriptionQueue } from "../jobs";
import type { JobStatus } from "../jobs/types";

function cursorPredicate(
  unit: UnitOfWork,
  cursor: string | undefined,
  scope: string,
) {
  const position = queuePagePosition(cursor, scope);
  if (!position.OR) return sql`1=1`;
  const createdAt = position.OR[0]!.createdAt as { gt: Date };
  const id = position.OR[1]!.id as { gt: string };
  const timestamp = queryAdapter(unit.provider).candidateTimestamp(
    createdAt.gt,
  );
  return sql`(created_at > ${timestamp} OR (created_at = ${timestamp} AND id > ${id.gt}))`;
}

export function serializeQueueDelivery(
  row: DeliveryRow,
  job: JobStatus,
): QueueDelivery {
  return {
    id: row.id,
    entry_id: row.entryId,
    subscription_id: row.subscriptionId,
    state: job.state,
    attempts: job.attempts,
    available_at: job.availableAt,
    lease_expires_at: job.expiresAt,
    last_error: job.error,
    completed_at: job.completedAt,
  };
}
function serializeEntry(row: EntryRow) {
  return {
    id: row.id,
    queue_id: row.queueId,
    payload: row.payload as JsonObject,
    schema_version: row.schemaVersion,
    producer_user_id: row.producerUserId,
    available_at: row.availableAt.toISOString(),
    idempotency_key: row.idempotencyKey,
    created_at: row.createdAt.toISOString(),
  };
}
export function createQueueReadService(
  prisma: PrismaClient,
  provider = queryProvider(prisma),
): Pick<QueueService<UnitOfWork>, "listEntries" | "listDeliveries"> {
  return {
    async listEntries(context, name, input) {
      const { limit, cursor, where } = parseQueueRequest(
        entryListSchema,
        input,
      );
      return withUnitOfWork({ prisma, provider }, async (unit) => {
        const queue = await authorizeQueueAction(
          unit.db,
          context,
          name,
          "read",
        );
        const scope = JSON.stringify([
          "entries",
          queue.id,
          createHash("sha256")
            .update(JSON.stringify(where ?? null))
            .digest("hex"),
        ]);
        const compiled = compileWhere(where, queue.schema as Schema, provider, {
          payloadOnly: true,
        });
        if (compiled.postFilters.length)
          throw new InvalidQueryError(
            "Deferred recurrence conditions are not supported in queue reads",
          );
        const ids = await queryRows<{ id: string }>(
          unit.db,
          provider,
          sql`
          SELECT id FROM (SELECT id, queue_id, created_at, payload AS data FROM queue_entries) entries
          WHERE queue_id = ${queue.id} AND ${compiled.expression ?? sql`1=1`} AND ${cursorPredicate(unit, cursor, scope)}
          ORDER BY created_at ASC, id ASC LIMIT ${limit + 1}`,
        );
        const rows = await unit.db.queueEntry.findMany({
          where: { id: { in: ids.slice(0, limit).map((row) => row.id) } },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        });
        return {
          items: rows.map(serializeEntry),
          next_cursor:
            ids.length > limit ? queuePageCursor(rows.at(-1)!, scope) : null,
        };
      });
    },
    async listDeliveries(context, name, input) {
      const { limit, cursor, subscription, state } = parseQueueRequest(
        deliveryListSchema,
        input,
      );
      await jobsFor(prisma)?.flush();
      return withUnitOfWork({ prisma, provider }, async (unit) => {
        const queue = await authorizeQueueAction(
          unit.db,
          context,
          name,
          "read",
        );
        const scope = JSON.stringify([
          "deliveries",
          queue.id,
          subscription,
          state,
        ]);
        const rows = await unit.db.queueDelivery.findMany({
          where: {
            queueId: queue.id,
            ...(subscription ? { subscription: { name: subscription } } : {}),
            ...queuePagePosition(cursor, scope),
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit + 1,
        });
        const items: QueueDelivery[] = [];
        for (const row of rows.slice(0, limit)) {
          const job = await unitJobs(unit).get(
            subscriptionQueue(row.subscriptionId),
            row.id,
          );
          if (job && (!state || job.state === state))
            items.push(serializeQueueDelivery(row, job));
        }
        return {
          items,
          next_cursor:
            rows.length > limit
              ? queuePageCursor(rows[limit - 1]!, scope)
              : null,
        };
      });
    },
  };
}
