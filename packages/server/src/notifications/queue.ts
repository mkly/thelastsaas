import type { Prisma, PrismaClient } from "@prisma/client";
import type { QueuedDelivery } from "../db/notifications";
import { queryProvider } from "../db/provider";
import { createNotificationQueueAdapter } from "./queue-adapter";
import type { NotificationDispatcher } from "./channels";

export interface QueueNotificationInput {
  orgId: string;
  userId: string;
  createdByUserId?: string;
  scheduleId?: string;
  occurrenceAt?: Date;
  type: string;
  message: string;
  delivery: QueuedDelivery;
  data?: object;
  inApp?: boolean;
  dedupeKey?: string;
}

/** The live worker has one delivery path: the native job adapter. */
export class NotificationQueue {
  private readonly adapter: ReturnType<typeof createNotificationQueueAdapter>;

  constructor(
    private readonly prisma: PrismaClient,
    dispatcher: NotificationDispatcher,
    provider = queryProvider(prisma),
  ) {
    this.adapter = createNotificationQueueAdapter(prisma, dispatcher, provider);
  }

  enqueue(
    input: QueueNotificationInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<string> {
    return this.adapter.enqueue(input, transaction);
  }

  async processDue(now = new Date(), batchSize = 25): Promise<number> {
    const organizations = await this.prisma.notification.findMany({
      distinct: ["orgId"],
      select: { orgId: true },
      orderBy: { orgId: "asc" },
    });
    let processed = 0;
    for (const { orgId } of organizations) {
      if (processed >= batchSize) break;
      processed += await this.adapter.processDue(
        orgId,
        now,
        batchSize - processed,
      );
    }
    return processed;
  }
}
