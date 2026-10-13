import type { PrismaClient } from "@prisma/client";
import { PostgresJobs } from "./postgres";
import { SqliteJobs } from "./sqlite";
import type { JobBackend, JobPolicy } from "./types";
import type { UnitOfWork } from "../db/unit-of-work";

const backends = new WeakMap<PrismaClient, JobBackend>();
export function registerJobs(prisma: PrismaClient, url: string) {
  if (!backends.has(prisma))
    backends.set(
      prisma,
      url.startsWith("file:")
        ? new SqliteJobs(
            prisma,
            url.slice(5) === ":memory:" ? ":memory:" : `${url.slice(5)}.jobs`,
          )
        : new PostgresJobs(url, postgresJobSchema(url)),
    );
}
export function jobsFor(prisma: PrismaClient) {
  return backends.get(prisma);
}
export function unitJobs(unit: UnitOfWork): JobBackend {
  if (!unit.jobs)
    throw new Error(
      "Job backend has not been registered for this Prisma client",
    );
  return unit.jobs;
}
export function queuePolicy(row: {
  maxAttempts: number;
  leaseSeconds: number;
  retryDelaySeconds: number;
  retentionDays: number;
}): JobPolicy {
  return {
    attempts: row.maxAttempts,
    leaseSeconds: row.leaseSeconds,
    retryDelaySeconds: row.retryDelaySeconds,
    retentionDays: row.retentionDays,
  };
}
export const workQueue = (id: string) => `queue-${id}`;

export function postgresJobSchema(url: string) {
  const schema = new URL(url).searchParams.get("schema");
  return schema ? `${schema}_jobs` : "pgboss";
}
