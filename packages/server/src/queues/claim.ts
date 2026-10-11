import {
  AutomationConflictError,
  claimRequestSchema,
  type QueueService,
} from "@lastsaas/shared";
import type { PrismaClient } from "@prisma/client";
import { queryProvider } from "../db/provider";
import { withUnitOfWork, type UnitOfWork } from "../db/unit-of-work";
import { resolveQueueConsumerGrants } from "./permissions";
import { parseQueueRequest } from "./config";
import { unitJobs, subscriptionPolicy, subscriptionQueue } from "../jobs";
import type { JsonObject } from "@lastsaas/shared";

export function createQueueClaimService(
  prisma: PrismaClient,
  provider = queryProvider(prisma),
): Pick<QueueService<UnitOfWork>, "claim"> {
  return {
    async claim(context, name, subscriptionName, input) {
      const parsed = parseQueueRequest(claimRequestSchema, input);
      const { queue, subscription, jobs } = await withUnitOfWork(
        { prisma, provider },
        async (unit) => ({
          ...(await resolveQueueConsumerGrants(
            unit.db,
            context,
            name,
            subscriptionName,
          )),
          jobs: unitJobs(unit),
        }),
      );
      if (!queue.enabled || !subscription.enabled)
        throw new AutomationConflictError("Queue or subscription is disabled");
      const claims = await jobs.claim(
        subscriptionQueue(subscription.id),
        subscriptionPolicy(subscription),
        parsed.limit,
      );
      return {
        claims: claims.map((job) => ({
          delivery_id: job.id,
          entry_id: String(job.data.entry_id),
          subscription_id: subscription.id,
          payload: job.data.payload as JsonObject,
          schema_version: Number(job.data.schema_version),
          attempts: job.attempt,
          lease_token: job.token,
          lease_expires_at: job.expiresAt,
        })),
        has_more: claims.length === parsed.limit,
      };
    },
  };
}
