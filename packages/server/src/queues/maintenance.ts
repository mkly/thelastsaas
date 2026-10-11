import type { PrismaClient } from "@prisma/client";
import { jobsFor, subscriptionPolicy, subscriptionQueue } from "../jobs";

/** Libraries expire jobs; clean retained application receipts after terminal retention. */
export async function maintainQueues(prisma: PrismaClient, now = new Date()) {
  const jobs = jobsFor(prisma);
  if (!jobs) return;
  await jobs.flush();
  for (const subscription of await prisma.queueSubscription.findMany()) {
    await jobs.cleanup(
      subscriptionQueue(subscription.id),
      subscriptionPolicy(subscription),
    );
    const cutoff = new Date(
      now.getTime() - subscription.retentionDays * 86400000,
    );
    const rows = await prisma.queueDelivery.findMany({
      where: { subscriptionId: subscription.id, createdAt: { lt: cutoff } },
    });
    for (const row of rows) {
      const job = await jobs.get(subscriptionQueue(subscription.id), row.id);
      if (
        !(await prisma.jobOutbox.findUnique({ where: { id: row.id } })) &&
        (!job ||
          (job.completedAt && Date.parse(job.completedAt) < cutoff.getTime()))
      )
        await prisma.queueDelivery.deleteMany({ where: { id: row.id } });
    }
  }
  await prisma.queueEntry.deleteMany({ where: { deliveries: { none: {} } } });
}
