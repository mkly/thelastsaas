import {
  AutomationConflictError,
  AutomationNotFoundError,
  ackRequestSchema,
  jobIdSchema,
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
import { claimTokenHash } from "./claim";
import { parseQueueRequest } from "./config";
import { unitJobs, workQueue, queuePolicy } from "../jobs";
import { serializeQueueJob } from "./read";
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
    parseQueueRequest(jobIdSchema, id);
    const { row, config, jobs } = await withUnitOfWork(
      { prisma, provider },
      async (unit) => {
        const queue = await authorizeQueueAction(
          unit.db,
          context,
          name,
          action === "cancel" || action === "redrive" ? "manage" : "read",
        );
        const row = await unit.db.queueEntry.findFirst({
          where: { id, queueId: queue.id },
        });
        if (!row) throw new AutomationNotFoundError();
        if (action !== "cancel" && action !== "redrive")
          await resolveQueueConsumerGrants(unit.db, context, name);
        return { row, config: queue, jobs: unitJobs(unit) };
      },
    );
    const queue = workQueue(row.queueId);
    await jobs.flush();
    const prior = await jobs.get(queue, id);
    if (!prior) throw new AutomationNotFoundError();
    if (
      input &&
      (row.claimedBy !== context.userId ||
        row.claimTokenHash !== claimTokenHash(input.token) ||
        row.nativeClaimToken === null ||
        prior.state !== "leased" ||
        !prior.expiresAt ||
        Date.parse(prior.expiresAt) <= Date.now())
    )
      throw new AutomationConflictError("Job claim is no longer valid");
    if (action === "ack") await jobs.complete(queue, id, row.nativeClaimToken!);
    if (action === "nack")
      await jobs.fail(queue, id, row.nativeClaimToken!, input!.error);
    if (action === "extend")
      await jobs.heartbeat(
        queue,
        id,
        row.nativeClaimToken!,
        queuePolicy(config),
      );
    if (action === "cancel") {
      if (!["ready", "leased"].includes(prior.state))
        throw new AutomationConflictError(
          "Only unfinished jobs can be cancelled",
        );
      await jobs.cancel(queue, id);
    }
    if (action === "redrive") {
      if (prior.state !== "dead")
        throw new AutomationConflictError("Only dead jobs can be redriven");
      const cleared = await prisma.queueEntry.updateMany({
        where: {
          id,
          claimTokenHash: row.claimTokenHash,
          claimedAttempt: row.claimedAttempt,
        },
        data: {
          claimedAttempt: 0,
          claimedBy: null,
          claimTokenHash: null,
          nativeClaimToken: null,
        },
      });
      if (cleared.count !== 1)
        throw new AutomationConflictError("Job claim has changed");
      await jobs.retry(queue, id);
    }
    await prisma.auditLog.create({
      data: {
        id: genId(),
        orgId: context.orgId,
        userId: context.userId,
        action: `${action}_queue_job`,
        resourceType: "queue_job",
        resourceId: id,
        details: { queue_id: row.queueId },
      },
    });
    const result = await jobs.get(queue, id);
    return serializeQueueJob(
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
