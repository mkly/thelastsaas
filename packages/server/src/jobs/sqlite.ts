import { QueueManager } from "bunqueue/queue";
type JobId = Parameters<QueueManager["getJob"]>[0];
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  AutomationConflictError,
  AutomationNotFoundError,
  type JsonObject,
} from "@lastsaas/shared";
import type { JobBackend, JobMessage, JobPolicy, JobStatus } from "./types";

/** Embedded Bunqueue owns its SQLite file. The application DB owns only the outbox. */
export class SqliteJobs implements JobBackend {
  private instance?: QueueManager;
  get manager() {
    return (this.instance ??= new QueueManager({ dataPath: this.dataPath }));
  }
  private flushing?: Promise<void>;
  private closed = false;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly dataPath: string,
  ) {}
  async start() {}
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.flushing;
    this.instance?.shutdown();
  }
  async send(message: JobMessage, transaction?: Prisma.TransactionClient) {
    if (transaction) {
      await transaction.jobOutbox.upsert({
        where: { id: message.id },
        update: {},
        create: {
          id: message.id,
          message: message as unknown as Prisma.InputJsonValue,
        },
      });
    } else await this.publish(message);
  }
  private async publish(message: JobMessage) {
    // Bunqueue permits reuse of terminal custom IDs; outbox replay must not.
    if (await this.manager.getJob(message.id as JobId)) return;
    await this.manager.push(message.queue, {
      data: message.data,
      customId: message.id,
      delay: Math.max(0, Date.parse(message.availableAt) - Date.now()),
      maxAttempts: message.policy.attempts,
      backoff: {
        type: "exponential",
        delay: message.policy.retryDelaySeconds * 1000,
        maxDelay: 3600000,
      },
      durable: true,
    });
  }
  flush() {
    return (this.flushing ??= this.drainOutbox().finally(() => {
      this.flushing = undefined;
    }));
  }
  private async drainOutbox() {
    const pending = await this.prisma.jobOutbox.findMany({
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    for (const row of pending) {
      // Stable job IDs make a crash between publish and delete safe to replay.
      await this.publish(row.message as unknown as JobMessage);
      await this.prisma.jobOutbox.deleteMany({ where: { id: row.id } });
    }
  }
  async claim(name: string, policy: JobPolicy, limit: number) {
    await this.flush();
    const { jobs, tokens } = await this.manager.pullBatchWithLock(
      name,
      limit,
      "api",
      0,
      policy.leaseSeconds * 1000,
    );
    return jobs.map((job, index) => ({
      id: String(job.id),
      data: job.data as JsonObject,
      attempt: job.attempts + 1,
      token: tokens[index]!,
      expiresAt: new Date(
        Date.now() + policy.leaseSeconds * 1000,
      ).toISOString(),
    }));
  }
  private async job(queue: string, id: string, token: string) {
    const job = await this.manager.getJob(id as JobId);
    if (!job || job.queue !== queue) throw new AutomationNotFoundError();
    if (!this.manager.verifyLock(job.id, token))
      throw new AutomationConflictError("Job claim is no longer valid");
    return job;
  }
  async complete(queue: string, id: string, token: string) {
    const job = await this.job(queue, id, token);
    const result = await this.manager.ack(job.id, null, token);
    if (result?.applied === false)
      throw new AutomationConflictError("Job claim is no longer valid");
  }
  async fail(queue: string, id: string, token: string, reason?: string) {
    const job = await this.job(queue, id, token);
    const result = await this.manager.fail(
      job.id,
      reason ?? "Worker failed",
      token,
    );
    if (result?.applied === false)
      throw new AutomationConflictError("Job claim is no longer valid");
  }
  async heartbeat(queue: string, id: string, token: string, policy: JobPolicy) {
    const job = await this.job(queue, id, token);
    if (
      !(await this.manager.extendLock(
        job.id,
        token,
        policy.leaseSeconds * 1000,
      ))
    )
      throw new AutomationConflictError("Job claim is no longer valid");
  }
  async get(queue: string, id: string): Promise<JobStatus | null> {
    const job = await this.manager.getJob(id as JobId);
    if (!job || job.queue !== queue) return null;
    const state = await this.manager.getJobState(job.id);
    const status =
      state === "active"
        ? "leased"
        : state === "completed"
          ? "succeeded"
          : state === "failed"
            ? "dead"
            : "ready";
    const lock = this.manager.getLockInfo(job.id);
    return {
      state: status,
      attempts:
        job.attempts + (status === "leased" || status === "succeeded" ? 1 : 0),
      availableAt: new Date(job.runAt).toISOString(),
      expiresAt: lock ? new Date(lock.expiresAt).toISOString() : null,
      completedAt: job.completedAt
        ? new Date(job.completedAt).toISOString()
        : null,
      error:
        [...job.timeline].reverse().find((item) => item.error)?.error ?? null,
    };
  }
  async cancel(queue: string, id: string) {
    if (!(await this.get(queue, id))) throw new AutomationNotFoundError();
    await this.manager.cancel(id as JobId);
  }
  async retry(queue: string, id: string) {
    if (!(await this.get(queue, id))) throw new AutomationNotFoundError();
    if (!this.manager.retryDlq(queue, id as JobId))
      throw new AutomationConflictError("Job cannot be retried");
  }
  async deleteQueue(queue: string) {
    this.manager.obliterate(queue);
  }
  async cleanup(queue: string, policy: JobPolicy) {
    for (const state of ["completed", "failed"])
      this.manager.clean(queue, policy.retentionDays * 86400000, state, 100);
  }
}
