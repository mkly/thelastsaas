import type { PrismaClient } from "@prisma/client";
import { jobsFor, queuePolicy, workQueue } from "../jobs";

/** Libraries expire jobs; discard application receipts after backend cleanup. */
export async function maintainQueues(prisma: PrismaClient, now = new Date()) {
  const jobs = jobsFor(prisma);
  if (!jobs) return;
  await jobs.flush();
  for (const queue of await prisma.queue.findMany()) {
    await jobs.cleanup(workQueue(queue.id), queuePolicy(queue));
    const cutoff = new Date(now.getTime() - queue.retentionDays * 86400000);
    const rows = await prisma.queueEntry.findMany({
      where: { queueId: queue.id, createdAt: { lt: cutoff } },
    });
    for (const row of rows) {
      const job = await jobs.get(workQueue(queue.id), row.id);
      if (
        !(await prisma.jobOutbox.findUnique({ where: { id: row.id } })) &&
        (!job ||
          (job.completedAt && Date.parse(job.completedAt) < cutoff.getTime()))
      )
        await prisma.queueEntry.deleteMany({ where: { id: row.id } });
    }
  }
}
