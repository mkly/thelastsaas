import { unitJobs, subscriptionQueue } from "../jobs";
import {
  AutomationConflictError,
  AutomationNotFoundError,
  pageRequestSchema,
  resourceNameSchema,
  subscriptionCreateSchema,
  subscriptionUpdateSchema,
  genId,
  type QueueService,
  type QueueSubscription,
} from "@lastsaas/shared";
import type {
  PrismaClient,
  QueueSubscription as SubscriptionRow,
} from "@prisma/client";
import { invalidateMetadata, policyCacheKey } from "../db/cache";
import { queryProvider } from "../db/provider";
import { withUnitOfWork, type UnitOfWork } from "../db/unit-of-work";
import { authorizeQueue } from "./permissions";
import {
  auditQueueConfiguration,
  lockQueue,
  parseQueueRequest,
  queueNameConflict,
  queuePageCursor,
  queuePagePosition,
  requireQueueGate,
} from "./config";

function serializeSubscription(row: SubscriptionRow): QueueSubscription {
  return {
    id: row.id,
    queue_id: row.queueId,
    name: row.name,
    enabled: row.enabled,
    max_attempts: row.maxAttempts,
    retry_delay_seconds: row.retryDelaySeconds,
    lease_seconds: row.leaseSeconds,
    retention_days: row.retentionDays,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export type QueueSubscriptionService = Pick<
  QueueService<UnitOfWork>,
  | "createSubscription"
  | "listSubscriptions"
  | "updateSubscription"
  | "deleteSubscription"
>;

export function createQueueSubscriptionService(
  prisma: PrismaClient,
  provider = queryProvider(prisma),
): QueueSubscriptionService {
  const source = { prisma, provider };
  return {
    async createSubscription(context, name, input) {
      const parsed = parseQueueRequest(subscriptionCreateSchema, input);
      try {
        return await withUnitOfWork(source, async (unit) => {
          const queue = await lockQueue(unit, context, name);
          await requireQueueGate(unit.db, context, `/queues/${name}`, "manage");
          // Only future enqueues fan out here: do not backfill retained entries.
          const row = await unit.db.queueSubscription.create({
            data: {
              id: genId(),
              queueId: queue.id,
              name: parsed.name,
              enabled: parsed.enabled,
              maxAttempts: parsed.max_attempts,
              retryDelaySeconds: parsed.retry_delay_seconds,
              leaseSeconds: parsed.lease_seconds,
              retentionDays: parsed.retention_days,
            },
          });
          await auditQueueConfiguration(
            unit.db,
            context,
            "create_queue_subscription",
            row.id,
            "queue_subscription",
          );
          return serializeSubscription(row);
        });
      } catch (error) {
        return queueNameConflict(error);
      }
    },
    async listSubscriptions(context, name, input) {
      const { limit, cursor } = parseQueueRequest(pageRequestSchema, input);
      return withUnitOfWork(source, async ({ db }) => {
        const queue = await authorizeQueue(db, context, name);
        await requireQueueGate(db, context, `/queues/${name}`, "manage");
        const scope = JSON.stringify([
          "subscriptions:v1",
          context.orgId,
          queue.id,
        ]);
        const candidates = await db.queueSubscription.findMany({
          where: { queueId: queue.id, ...queuePagePosition(cursor, scope) },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: limit + 1,
        });
        const scanned = candidates.slice(0, limit);
        return {
          items: scanned.map(serializeSubscription),
          next_cursor:
            candidates.length > limit
              ? queuePageCursor(scanned[scanned.length - 1]!, scope)
              : null,
        };
      });
    },
    async updateSubscription(context, name, subscription, input) {
      const parsed = parseQueueRequest(subscriptionUpdateSchema, input);
      parseQueueRequest(resourceNameSchema, subscription);
      return withUnitOfWork(source, async (unit) => {
        const queue = await lockQueue(unit, context, name);
        await requireQueueGate(unit.db, context, `/queues/${name}`, "manage");
        const row = await unit.db.queueSubscription.findUnique({
          where: { queueId_name: { queueId: queue.id, name: subscription } },
        });
        if (!row) throw new AutomationNotFoundError();
        const updated = await unit.db.queueSubscription.update({
          where: { id: row.id },
          data: {
            enabled: parsed.enabled,
            maxAttempts: parsed.max_attempts,
            retryDelaySeconds: parsed.retry_delay_seconds,
            leaseSeconds: parsed.lease_seconds,
            retentionDays: parsed.retention_days,
          },
        });
        await auditQueueConfiguration(
          unit.db,
          context,
          "update_queue_subscription",
          row.id,
          "queue_subscription",
        );
        return serializeSubscription(updated);
      });
    },
    async deleteSubscription(context, name, subscription) {
      parseQueueRequest(resourceNameSchema, subscription);
      await withUnitOfWork(source, async (unit) => {
        const queue = await lockQueue(unit, context, name);
        await requireQueueGate(unit.db, context, `/queues/${name}`, "manage");
        const row = await unit.db.queueSubscription.findUnique({
          where: { queueId_name: { queueId: queue.id, name: subscription } },
        });
        if (!row) throw new AutomationNotFoundError();
        const deliveries = await unit.db.queueDelivery.findMany({
          where: { subscriptionId: row.id },
        });
        for (const delivery of deliveries) {
          const job = await unitJobs(unit).get(
            subscriptionQueue(row.id),
            delivery.id,
          );
          if (
            (await unit.db.jobOutbox.findUnique({
              where: { id: delivery.id },
            })) ||
            (job && ["ready", "leased"].includes(job.state))
          )
            throw new AutomationConflictError(
              "Subscription has unfinished deliveries",
            );
        }
        await unitJobs(unit).deleteQueue(subscriptionQueue(row.id));
        await unit.db.queueSubscription.delete({ where: { id: row.id } });
        await unit.db.casbinRule.deleteMany({
          where: {
            orgId: context.orgId,
            ptype: "p",
            v1: `/queues/${name}/subscriptions/${subscription}`,
          },
        });
        await auditQueueConfiguration(
          unit.db,
          context,
          "delete_queue_subscription",
          row.id,
          "queue_subscription",
        );
      });
      await invalidateMetadata(prisma, policyCacheKey(context.orgId));
    },
  };
}
