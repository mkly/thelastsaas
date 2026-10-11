import {
  AutomationConflictError,
  AutomationNotFoundError,
  ackRequestSchema,
  deliveryIdSchema,
  extendRequestSchema,
  nackRequestSchema,
  genId,
  type QueueService,
} from "@lastsaas/shared";
import type { PrismaClient } from "@prisma/client";
import { queryProvider } from "../db/provider";
import { withUnitOfWork, type UnitOfWork } from "../db/unit-of-work";
import {
  authorizeQueueAction,
  resolveQueueConsumerGrants,
} from "./permissions";
import { parseQueueRequest } from "./config";
import { unitJobs, subscriptionQueue, subscriptionPolicy } from "../jobs";
import { serializeQueueDelivery } from "./read";
import type { AutomationContext } from "@lastsaas/shared";

export function createQueueSettlementService(
  prisma: PrismaClient,
  provider = queryProvider(prisma),
): Pick<
  QueueService<UnitOfWork>,
  "ack" | "nack" | "extend" | "cancel" | "redrive"
> {
  async function settle(
    context: AutomationContext,
    name: string,
    id: string,
    action: "ack" | "nack" | "extend" | "cancel" | "redrive",
    input?: { token: string; error?: string },
  ) {
    parseQueueRequest(deliveryIdSchema, id);
    const { row, jobs } = await withUnitOfWork(
      { prisma, provider },
      async (unit) => {
        const queue = await authorizeQueueAction(
          unit.db,
          context,
          name,
          action === "cancel" || action === "redrive" ? "manage" : "read",
        );
        const row = await unit.db.queueDelivery.findFirst({
          where: { id, queueId: queue.id },
          include: { subscription: true },
        });
        if (!row) throw new AutomationNotFoundError();
        if (action !== "cancel" && action !== "redrive")
          await resolveQueueConsumerGrants(
            unit.db,
            context,
            name,
            row.subscription.name,
          );
        return { row, jobs: unitJobs(unit) };
      },
    );
    const queue = subscriptionQueue(row.subscriptionId);
    await jobs.flush();
    const prior = await jobs.get(queue, id);
    if (!prior) throw new AutomationNotFoundError();
    if (action === "ack") await jobs.complete(queue, id, input!.token);
    if (action === "nack")
      await jobs.fail(queue, id, input!.token, input!.error);
    if (action === "extend")
      await jobs.heartbeat(
        queue,
        id,
        input!.token,
        subscriptionPolicy(row.subscription),
      );
    if (action === "cancel") {
      if (!["ready", "leased"].includes(prior.state))
        throw new AutomationConflictError(
          "Only unfinished deliveries can be cancelled",
        );
      await jobs.cancel(queue, id);
    }
    if (action === "redrive") {
      if (prior.state !== "dead")
        throw new AutomationConflictError(
          "Only dead deliveries can be redriven",
        );
      await jobs.retry(queue, id);
    }
    await prisma.auditLog.create({
      data: {
        id: genId(),
        orgId: context.orgId,
        userId: context.userId,
        action: `${action}_queue_delivery`,
        resourceType: "queue_delivery",
        resourceId: id,
        details: { queue_id: row.queueId, subscription_id: row.subscriptionId },
      },
    });
    const result = await jobs.get(queue, id);
    return serializeQueueDelivery(
      row,
      result ?? {
        ...prior,
        state: "cancelled",
        completedAt: new Date().toISOString(),
        expiresAt: null,
      },
    );
  }
  return {
    ack: (c, n, d, i) =>
      settle(c, n, d, "ack", parseQueueRequest(ackRequestSchema, i)),
    nack: (c, n, d, i) =>
      settle(c, n, d, "nack", parseQueueRequest(nackRequestSchema, i)),
    extend: (c, n, d, i) =>
      settle(c, n, d, "extend", parseQueueRequest(extendRequestSchema, i)),
    cancel: (c, n, d) => settle(c, n, d, "cancel"),
    redrive: (c, n, d) => settle(c, n, d, "redrive"),
  };
}
