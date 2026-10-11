import { PgBoss, fromPrisma, type CommandResponse } from "pg-boss";
import type { Prisma } from "@prisma/client";
import type { JsonObject } from "@lastsaas/shared";
import { AutomationConflictError } from "@lastsaas/shared";
import type { JobBackend, JobMessage, JobPolicy, JobStatus } from "./types";

export class PostgresJobs implements JobBackend {
  readonly boss: PgBoss;
  private starting?: Promise<PgBoss>;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(url: string, schema = "pgboss") {
    this.boss = new PgBoss({ connectionString: url, schema });
    this.boss.on("error", (error) => console.error("Job backend error", error));
  }
  async start() {
    await (this.starting ??= this.boss.start());
  }
  async close() {
    if (this.starting) {
      await this.starting;
      await this.boss.stop();
    }
  }
  async flush() {}

  private async ensureQueue(name: string) {
    await this.start();
    let ready = this.queues.get(name);
    if (!ready) {
      ready = this.boss.createQueue(name).catch((error) => {
        this.queues.delete(name);
        throw error;
      });
      this.queues.set(name, ready);
    }
    return ready;
  }

  async send(message: JobMessage, transaction?: Prisma.TransactionClient) {
    await this.ensureQueue(message.queue);
    await this.boss.send(message.queue, message.data, {
      id: message.id,
      startAfter: new Date(message.availableAt),
      retryLimit: message.policy.attempts - 1,
      retryDelay: message.policy.retryDelaySeconds,
      retryBackoff: true,
      retryDelayMax: 3600,
      // pg-boss also enforces its maximum 24-hour execution deadline.
      expireInSeconds: 86400,
      heartbeatSeconds: message.policy.leaseSeconds,
      retentionSeconds: message.policy.retentionDays * 86400,
      deleteAfterSeconds: message.policy.retentionDays * 86400,
      ...(transaction ? { db: fromPrisma(transaction) } : {}),
    });
  }

  async claim(queue: string, _policy: JobPolicy, limit: number) {
    await this.ensureQueue(queue);
    const jobs = await this.boss.fetch<JsonObject>(queue, {
      batchSize: limit,
      includeMetadata: true,
    });
    return jobs.map((job) => ({
      id: job.id,
      data: job.data,
      attempt: job.retryCount + 1,
      token: String(job.retryCount),
      expiresAt: new Date(
        (job.heartbeatOn ?? job.startedOn).getTime() +
          job.heartbeatSeconds! * 1000,
      ).toISOString(),
    }));
  }

  private attempt(id: string, token: string) {
    const retryCount = Number(token);
    if (!/^\d+$/.test(token) || !Number.isSafeInteger(retryCount))
      throw new AutomationConflictError("Invalid job attempt");
    return { id, retryCount };
  }
  private settled(result: CommandResponse) {
    // pg-boss 12.37 returns affected but omits it from CommandResponse's declaration.
    if (!("affected" in result) || result.affected !== 1)
      throw new AutomationConflictError("Job claim is no longer valid");
  }
  async complete(queue: string, id: string, token: string) {
    this.settled(await this.boss.complete(queue, this.attempt(id, token)));
  }
  async fail(queue: string, id: string, token: string, reason?: string) {
    this.settled(
      await this.boss.fail(queue, this.attempt(id, token), {
        error: reason ?? "Worker failed",
      }),
    );
  }
  async heartbeat(
    queue: string,
    id: string,
    token: string,
    _policy: JobPolicy,
  ) {
    this.settled(await this.boss.touch(queue, this.attempt(id, token)));
  }
  async get(queue: string, id: string): Promise<JobStatus | null> {
    await this.ensureQueue(queue);
    const [job] = await this.boss.findJobs(queue, { id });
    if (!job) return null;
    const states = {
      created: "ready",
      retry: "ready",
      active: "leased",
      completed: "succeeded",
      failed: "dead",
      cancelled: "cancelled",
    } as const;
    return {
      state: states[job.state],
      attempts: job.startedOn ? job.retryCount + 1 : 0,
      availableAt: job.startAfter.toISOString(),
      completedAt: job.completedOn?.toISOString() ?? null,
      expiresAt:
        job.state === "active"
          ? new Date(
              (job.heartbeatOn ?? job.startedOn).getTime() +
                job.heartbeatSeconds! * 1000,
            ).toISOString()
          : null,
      error:
        job.output && "error" in job.output ? String(job.output.error) : null,
    };
  }
  async cancel(queue: string, id: string) {
    this.settled(await this.boss.cancel(queue, id));
  }
  async retry(queue: string, id: string) {
    this.settled(await this.boss.retry(queue, id));
  }
  async deleteQueue(queue: string) {
    await this.start();
    await this.boss.deleteQueue(queue);
    this.queues.delete(queue);
  }
  async cleanup(_queue: string, _policy: JobPolicy) {} // pg-boss supervises its own retention.
}
