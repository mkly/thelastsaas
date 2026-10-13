import { createHash, randomBytes } from "node:crypto";
import {
  AutomationConflictError,
  claimRequestSchema,
  type JsonObject,
  type QueueService,
} from "@lastsaas/shared";
import type { PrismaClient } from "@prisma/client";
import { queryProvider } from "../db/provider";
import { withUnitOfWork, type UnitOfWork } from "../db/unit-of-work";
import { resolveQueueConsumerGrants } from "./permissions";
import { parseQueueRequest } from "./config";
import { unitJobs, queuePolicy, workQueue } from "../jobs";

export function claimTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function createQueueClaimService(
  prisma: PrismaClient,
  provider = queryProvider(prisma),
): Pick<QueueService<UnitOfWork>, "claim"> {
  return {
    async claim(context, name, input) {
      const parsed = parseQueueRequest(claimRequestSchema, input);
      const { queue, jobs } = await withUnitOfWork(
        { prisma, provider },
        async (unit) => ({
          queue: await resolveQueueConsumerGrants(unit.db, context, name),
          jobs: unitJobs(unit),
        }),
      );
      if (!queue.enabled)
        throw new AutomationConflictError("Queue is disabled");
      const claimed = await jobs.claim(
        workQueue(queue.id),
        queuePolicy(queue),
        parsed.limit,
      );
      const claims = [];
      for (const job of claimed) {
        const token = randomBytes(32).toString("base64url");
        // The backend owns state/expiry. A delayed earlier attempt cannot replace
        // the credentials of a newer claim. Public tokens never expose native tokens.
        const saved = await prisma.queueEntry.updateMany({
          where: {
            id: job.id,
            queueId: queue.id,
            claimedAttempt: { lt: job.attempt },
          },
          data: {
            claimedBy: context.userId,
            claimTokenHash: claimTokenHash(token),
            nativeClaimToken: job.token,
            claimedAttempt: job.attempt,
          },
        });
        if (saved.count !== 1) continue;
        claims.push({
          job_id: job.id,
          payload: job.data.payload as JsonObject,
          schema_version: Number(job.data.schema_version),
          attempts: job.attempt,
          lease_token: token,
          lease_expires_at: job.expiresAt,
        });
      }
      return { claims, has_more: claimed.length === parsed.limit };
    },
  };
}
