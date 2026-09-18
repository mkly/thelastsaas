import { MemoryCache } from "../src/cache";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { createServices, closeServices } from "../src/services";
import {
  createCollection,
  getCollection,
  updateCollectionSchema,
  dropCollection,
} from "../src/db/collections";
import {
  addPolicy,
  assignRole,
  unassignRole,
  hasPermission,
  removePolicy,
  removeMemberAccess,
  getOrgRules,
} from "../src/db/casbin";
import { testMigrationSql } from "./test-migrations";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "metadata-cache-"));
  let loads = 0;
  class CountingCache extends MemoryCache {
    override remember<T>(key: string, ttl: number, load: () => Promise<T>) {
      return super.remember(key, ttl, async () => {
        loads++;
        return load();
      });
    }
  }
  const services = await createServices(
    loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: `file:${join(directory, "db.sqlite")}`,
    }),
    undefined,
    new CountingCache(),
  );
  services.database!.exec(testMigrationSql);
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  for (const id of ["one", "two"])
    await services.prisma.organization.create({
      data: { id, name: id, slug: id },
    });
  return { ...services, getLoads: () => loads };
}

test("collection cache avoids repeat DB reads, separates tenants and invalidates schema changes and deletion", async () => {
  const { prisma, getLoads } = await fixture();
  await createCollection(prisma, "one", null, "tasks", { title: "string" });
  await createCollection(prisma, "two", null, "tasks", { number: "number" });
  const first = await getCollection(prisma, "one", "tasks");
  expect((await getCollection(prisma, "one", "tasks")).id).toBe(first.id);
  expect(getLoads()).toBe(1);
  expect(first.createdAt).toBeInstanceOf(Date);
  expect((await getCollection(prisma, "two", "tasks")).schema).toEqual({
    number: "number",
  });
  await updateCollectionSchema(prisma, "one", "tasks", { done: "boolean" });
  expect((await getCollection(prisma, "one", "tasks")).schema).toEqual({
    title: "string",
    done: "boolean",
  });
  await dropCollection(prisma, "one", "tasks");
  await expect(getCollection(prisma, "one", "tasks")).rejects.toThrow(
    "not found",
  );
  await createCollection(prisma, "one", null, "tasks", {
    replacement: "string",
  });
  expect((await getCollection(prisma, "one", "tasks")).schema).toEqual({
    replacement: "string",
  });
});

test("rule cache avoids repeat reads and invalidates grants, roles, member removal and collection creator grants", async () => {
  const { prisma, getLoads } = await fixture();
  expect(
    await hasPermission(prisma, "one", "alice", "/collections/tasks", "read"),
  ).toBe(false);
  await getOrgRules(prisma, "one");
  expect(getLoads()).toBe(1);
  await addPolicy(prisma, "one", "alice", "/collections/tasks", "read");
  expect(
    await hasPermission(prisma, "one", "alice", "/collections/tasks", "read"),
  ).toBe(true);
  expect(
    await hasPermission(prisma, "two", "alice", "/collections/tasks", "read"),
  ).toBe(false);
  await removePolicy(prisma, "one", "alice", "/collections/tasks", "read");
  expect(
    await hasPermission(prisma, "one", "alice", "/collections/tasks", "read"),
  ).toBe(false);
  await addPolicy(
    prisma,
    "one",
    "org:one:user:reader",
    "/collections/tasks",
    "read",
  );
  await assignRole(prisma, "one", "alice", "reader");
  expect(
    await hasPermission(prisma, "one", "alice", "/collections/tasks", "read"),
  ).toBe(true);
  await unassignRole(prisma, "one", "alice", "reader");
  expect(
    await hasPermission(prisma, "one", "alice", "/collections/tasks", "read"),
  ).toBe(false);
  await createCollection(prisma, "one", "alice", "tasks", {
    title: "string",
  });
  expect(
    await hasPermission(prisma, "one", "alice", "/collections/tasks", "read"),
  ).toBe(true);
  await dropCollection(prisma, "one", "tasks");
  expect(
    await hasPermission(prisma, "one", "alice", "/collections/tasks", "read"),
  ).toBe(false);
  await assignRole(prisma, "one", "alice", "reader");
  expect(
    await hasPermission(prisma, "one", "alice", "/collections/tasks", "read"),
  ).toBe(false);
  await addPolicy(
    prisma,
    "one",
    "org:one:user:reader",
    "/collections/tasks",
    "read",
  );
  expect(
    await hasPermission(prisma, "one", "alice", "/collections/tasks", "read"),
  ).toBe(true);
  await removeMemberAccess(prisma, "one", "alice");
  expect(
    await hasPermission(prisma, "one", "alice", "/collections/tasks", "read"),
  ).toBe(false);
});
