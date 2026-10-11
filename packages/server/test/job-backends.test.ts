import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresJobs } from "../src/jobs/postgres";
import { SqliteJobs } from "../src/jobs/sqlite";
import type { JobBackend, JobMessage } from "../src/jobs/types";
import { testMigrationSql } from "./test-migrations";

const postgres = process.env.JOBS_TEST_DATABASE_URL;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const policy = {
  attempts: 2,
  leaseSeconds: 10,
  retryDelaySeconds: 0,
  retentionDays: 7,
};
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-jobs-"));
  const path = join(directory, "app.db");
  if (!postgres) {
    const db = new Database(path);
    db.exec(testMigrationSql);
    db.close();
  }
  const prisma = new PrismaClient({
    datasourceUrl: postgres ?? `file:${path}`,
  });
  const schema = `jobs_${crypto.randomUUID().replaceAll("-", "")}`;
  const backend: JobBackend = postgres
    ? new PostgresJobs(postgres, schema)
    : new SqliteJobs(prisma, join(directory, "jobs.db"));
  cleanups.push(async () => {
    await backend.close();
    if (postgres)
      await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await prisma.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  });
  await backend.start();
  const message = (): JobMessage => ({
    id: crypto.randomUUID(),
    queue: "workers",
    data: { value: 42 },
    availableAt: new Date().toISOString(),
    policy,
  });
  return { prisma, backend, message, directory };
}

test("transaction publication commits atomically and rollback leaves no claimable job", async () => {
  const { prisma, backend, message } = await fixture();
  const rolledBack = message();
  await expect(
    prisma.$transaction(async (tx) => {
      await backend.send(rolledBack, tx);
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect(await backend.claim("workers", policy, 10)).toEqual([]);
  const committed = message();
  await prisma.$transaction((tx) => backend.send(committed, tx));
  const claims = await backend.claim("workers", policy, 10);
  expect(claims.map((c) => c.id)).toEqual([committed.id]);
  expect(claims[0]!.data).toEqual(committed.data);
  await backend.heartbeat("workers", committed.id, claims[0]!.token, policy);
  await backend.complete("workers", committed.id, claims[0]!.token);
  expect(await backend.claim("workers", policy, 10)).toEqual([]);
});

test("competing claims, native retries, and stale attempt fencing", async () => {
  const { backend, message } = await fixture();
  const job = message();
  await backend.send(job);
  const claims = (
    await Promise.all([
      backend.claim("workers", policy, 1),
      backend.claim("workers", policy, 1),
    ])
  ).flat();
  expect(claims).toHaveLength(1);
  expect(claims[0]!.attempt).toBe(1);
  await backend.fail("workers", job.id, claims[0]!.token, "try again");
  let retry = await backend.claim("workers", policy, 1);
  for (let i = 0; retry.length === 0 && i < 60; i++) {
    await Bun.sleep(100);
    retry = await backend.claim("workers", policy, 1);
  }
  expect(retry).toHaveLength(1);
  expect(retry[0]!.attempt).toBe(2);
  await expect(
    backend.complete("workers", job.id, claims[0]!.token),
  ).rejects.toThrow();
  await backend.fail("workers", job.id, retry[0]!.token, "exhausted");
  expect(await backend.claim("workers", policy, 1)).toEqual([]);
  expect((await backend.get("workers", job.id))?.state).toBe("dead");
  await backend.retry("workers", job.id);
  const [redriven] = await backend.claim("workers", policy, 1);
  expect(redriven?.id).toBe(job.id);
  await backend.complete("workers", job.id, redriven!.token);
  expect((await backend.get("workers", job.id))?.state).toBe("succeeded");
});

test.skipIf(!!postgres)(
  "SQLite outbox replay survives restart without rerunning a completed job",
  async () => {
    const { prisma, backend, message, directory } = await fixture();
    const job = message();
    await prisma.$transaction((tx) => backend.send(job, tx));
    await backend.close();
    const restarted = new SqliteJobs(prisma, join(directory, "jobs.db"));
    try {
      const [claim] = await restarted.claim("workers", policy, 1);
      expect(claim!.id).toBe(job.id);
      await restarted.complete("workers", job.id, claim!.token);
      // Replay the same committed outbox message after an interrupted handoff.
      await prisma.$transaction((tx) => restarted.send(job, tx));
      expect(await restarted.claim("workers", policy, 1)).toEqual([]);
    } finally {
      await restarted.close();
    }
  },
);
