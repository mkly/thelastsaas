import { PermissionDeniedError } from "@lastsaas/shared";
import type { Prisma, PrismaClient } from "@prisma/client";
import { queryProvider } from "../db/provider";
import { withUnitOfWork } from "../db/unit-of-work";
import { resolveNotificationAudience } from "../db/notification-audiences";
import {
  enqueueNotification,
  extractQueuedDelivery,
} from "../db/notifications";
import { jobsFor } from "../jobs";
import type { NotificationDispatcher } from "./channels";
import { applyRecipientPreferences } from "./preferences";
import type { QueueNotificationInput } from "./queue";

const policy = {
  attempts: 3,
  leaseSeconds: 300,
  retryDelaySeconds: 30,
  retentionDays: 7,
};
const queueName = (orgId: string) => `notifications-${orgId}`;
function successfulChannels(value: Prisma.JsonValue | null): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Array.isArray(value.succeeded)
    ? value.succeeded.filter((name): name is string => typeof name === "string")
    : [];
}

/** Private delivery adapter. The library owns delivery state; notifications own inbox and channel outcomes. */
export function createNotificationQueueAdapter(
  prisma: PrismaClient,
  dispatcher: NotificationDispatcher,
  provider = queryProvider(prisma),
) {
  const backend = () => {
    const jobs = jobsFor(prisma);
    if (!jobs) throw new Error("Notification job backend is not registered");
    return jobs;
  };
  async function enqueue(
    input: QueueNotificationInput,
    transaction?: Prisma.TransactionClient,
  ) {
    const operation = async (db: Prisma.TransactionClient) => {
      const row = await enqueueNotification(db, input);
      if (row.status === "pending")
        await backend().send(
          {
            id: row.id,
            queue: queueName(input.orgId),
            data: { notification_id: row.id },
            availableAt: new Date().toISOString(),
            policy,
          },
          db,
        );
      return row.id;
    };
    return transaction
      ? operation(transaction)
      : withUnitOfWork({ prisma, provider }, (unit) => operation(unit.db));
  }
  async function processDue(orgId: string, _now = new Date(), batchSize = 25) {
    const jobs = backend();
    const queue = queueName(orgId);
    const claims = await jobs.claim(queue, policy, batchSize);
    for (const claim of claims) {
      const row = await prisma.notification.findFirst({
        where: { id: String(claim.data.notification_id), orgId },
      });
      if (!row || row.status === "sent" || row.status === "cancelled") {
        await jobs.complete(queue, claim.id, claim.token);
        continue;
      }
      const delivery = extractQueuedDelivery(row.data);
      if (
        !delivery ||
        (!delivery.channels && !dispatcher.channelNames().length)
      ) {
        await jobs.fail(
          queue,
          claim.id,
          claim.token,
          "Notification delivery configuration is unavailable",
        );
        continue;
      }
      let inApp = row.inApp;
      let channels = delivery.channels ?? dispatcher.channelNames();
      if (row.createdByUserId) {
        try {
          // Current membership, sender authority and preferences stay domain checks.
          const { recipients } = await resolveNotificationAudience(
            prisma,
            orgId,
            row.createdByUserId,
            row.createdByUserId === row.userId
              ? { kind: "self" }
              : { kind: "users", users: [row.userId] },
            { atDelivery: true },
          );
          const recipient = recipients[0];
          if (!recipient) throw new PermissionDeniedError();
          delivery.to = recipient.email;
          const preferred = applyRecipientPreferences(
            recipient.notificationPreferences,
            row.type,
            { inApp, channels },
          );
          inApp = preferred.inApp;
          channels = preferred.muted ? [] : (preferred.channels ?? channels);
        } catch (error) {
          if (!(error instanceof PermissionDeniedError)) throw error;
          await prisma.notification.update({
            where: { id: row.id },
            data: { status: "cancelled", inApp: false },
          });
          await jobs.complete(queue, claim.id, claim.token);
          continue;
        }
      }

      const succeeded = new Set(successfulChannels(row.channelResults));
      const failed: string[] = [];
      for (const channel of [...new Set(channels)]) {
        if (succeeded.has(channel)) continue;
        await jobs.heartbeat(queue, claim.id, claim.token, policy);
        const result = await dispatcher.sendChannels(delivery, [channel]);
        if (result.succeeded.length) succeeded.add(channel);
        else failed.push(channel);
        await prisma.notification.update({
          where: { id: row.id },
          data: { channelResults: { succeeded: [...succeeded], failed } },
        });
      }
      // Checkpoint channel outcomes before settlement. Replay skips successful channels.
      await prisma.notification.update({
        where: { id: row.id },
        data: {
          inApp,
          status: failed.length
            ? claim.attempt >= policy.attempts
              ? "failed"
              : "pending"
            : "sent",
        },
      });
      if (failed.length)
        await jobs.fail(
          queue,
          claim.id,
          claim.token,
          "Notification channel delivery failed",
        );
      else await jobs.complete(queue, claim.id, claim.token);
    }
    await jobs.cleanup(queue, policy);
    return claims.length;
  }
  return { enqueue, processDue };
}
