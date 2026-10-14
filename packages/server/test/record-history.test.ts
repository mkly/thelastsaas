import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addPolicy, removePolicy } from "../src/db/casbin";
import { updateCollectionSchema } from "../src/db/collections";
import { registerDatabaseProvider } from "../src/db/provider";
import {
  insertRecord,
  insertRecords,
  updateRecord,
  deleteRecord,
} from "../src/db/records";
import { queryRecordHistory } from "../src/db/record-history";
import {
  pruneRecordHistory,
  RECORD_HISTORY_RETENTION_MS,
} from "../src/db/record-history-storage";
import { createTransactionService } from "../src/transactions/service";
import { withUnitOfWork } from "../src/db/unit-of-work";
import { insertRecordInTransaction } from "../src/db/records";
import { exportData, importData } from "../src/db/export-import";
import { testMigrationSql } from "./test-migrations";

const postgresUrl = process.env.RECORD_HISTORY_TEST_DATABASE_URL;
const provider = postgresUrl ? "postgresql" : "sqlite";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-history-"));
  const path = join(directory, "test.db");
  if (!postgresUrl) {
    const database = new Database(path);
    database.exec(testMigrationSql);
    database.close();
  }
  const prisma = new PrismaClient({
    datasourceUrl: postgresUrl ?? `file:${path}`,
  });
  registerDatabaseProvider(prisma, postgresUrl ?? `file:${path}`);
  const orgId = crypto.randomUUID();
  const admin = {
    orgId,
    userId: crypto.randomUUID(),
    userEmail: `${crypto.randomUUID()}@example.com`,
  };
  const worker = {
    orgId,
    userId: crypto.randomUUID(),
    userEmail: `${crypto.randomUUID()}@example.com`,
  };
  cleanups.push(async () => {
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.user.deleteMany({
      where: { id: { in: [admin.userId, worker.userId] } },
    });
    await prisma.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  });
  await prisma.organization.create({
    data: { id: orgId, name: "History", slug: orgId },
  });
  for (const actor of [admin, worker]) {
    await prisma.user.create({
      data: {
        id: actor.userId,
        name: "Actor",
        email: actor.userEmail,
        kind: actor === worker ? "service" : "human",
      },
    });
    await prisma.member.create({
      data: {
        id: crypto.randomUUID(),
        organizationId: orgId,
        userId: actor.userId,
      },
    });
  }
  await addPolicy(prisma, orgId, admin.userId, "/*", "*");
  const collection = await prisma.collection.create({
    data: {
      id: crypto.randomUUID(),
      orgId,
      name: "tasks",
      schema: {
        title: "string",
        owner: "string",
        secret: "string",
        meta: "json",
        due: "datetime",
      },
    },
  });
  await prisma.collection.create({
    data: {
      id: crypto.randomUUID(),
      orgId,
      name: "notes",
      schema: { title: "string" },
    },
  });
  const create = (data: Record<string, unknown>) =>
    insertRecord(prisma, orgId, "tasks", data, admin.userId);
  const update = (
    id: string,
    data: Record<string, unknown>,
    actor = admin.userId,
  ) =>
    updateRecord(
      prisma,
      orgId,
      "tasks",
      id,
      data,
      undefined,
      undefined,
      undefined,
      actor,
    );
  const remove = (id: string) =>
    deleteRecord(
      prisma,
      orgId,
      "tasks",
      id,
      undefined,
      undefined,
      admin.userId,
    );
  const history = (query = {}, actor = admin, now?: Date) =>
    queryRecordHistory(prisma, actor, "tasks", query, now);
  return {
    prisma,
    orgId,
    admin,
    worker,
    collection,
    create,
    update,
    remove,
    history,
  };
}

describe(`record history (${provider})`, () => {
  test("adding history storage preserves existing records, permissions and audit entries", async () => {
    const f = await fixture();
    // Reproduce the schema immediately before history was introduced.
    await f.prisma.$executeRawUnsafe('DROP TABLE "record_history"');
    const original = await f.prisma.record.create({
      data: {
        id: crypto.randomUUID(),
        orgId: f.orgId,
        collectionId: f.collection.id,
        data: { title: "Existing data" },
        createdBy: f.admin.userId,
      },
    });
    const audit = await f.prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        orgId: f.orgId,
        userId: f.admin.userId,
        action: "test",
        resourceType: "record",
      },
    });
    const grants = await f.prisma.casbinRule.findMany({
      where: { orgId: f.orgId },
    });
    if (postgresUrl) {
      // PostgreSQL deployments apply the generated schema, rather than SQLite SQL.
      const child = Bun.spawn(
        [
          "packages/server/node_modules/.bin/prisma",
          "db",
          "push",
          "--schema",
          "packages/server/prisma/schema.postgres.prisma",
          "--skip-generate",
        ],
        {
          cwd: fileURLToPath(new URL("../../../", import.meta.url)),
          env: { ...process.env, DATABASE_URL: postgresUrl },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, `${out}\n${err}`).toBe(0);
    } else {
      const migration = readFileSync(
        new URL(
          "../prisma/migrations/20261014000000_record_history/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      for (const statement of migration.split(";").filter((sql) => sql.trim()))
        await f.prisma.$executeRawUnsafe(statement);
    }
    expect(
      await f.prisma.record.findUnique({ where: { id: original.id } }),
    ).toEqual(original);
    expect(
      await f.prisma.auditLog.findUnique({ where: { id: audit.id } }),
    ).toEqual(audit);
    expect(
      await f.prisma.casbinRule.findMany({ where: { orgId: f.orgId } }),
    ).toEqual(grants);
    expect((await f.history()).items).toEqual([]);
    await f.update(original.id, { title: "First recorded change" });
    expect((await f.history()).items[0]).toMatchObject({
      before: { title: "Existing data" },
      after: { title: "First recorded change" },
    });
  }, 30_000);

  test("persists validated snapshots and actors; skips semantic no-ops and retains deletions", async () => {
    const f = await fixture();
    const row = await f.create({
      title: "Before",
      meta: { a: 1, b: 2 },
      due: "2026-10-14T12:00:00-07:00",
    });
    await f.update(row.id, {
      meta: { b: 2, a: 1 },
      due: "2026-10-14T19:00:00.000Z",
    });
    expect((await f.history()).items).toHaveLength(1);
    await f.update(row.id, { title: "After" }, f.worker.userId);
    await f.remove(row.id);
    const { items, next_cursor } = await f.history({ record_id: row.id });
    expect(next_cursor).toBeNull();
    expect(items.map((item) => item.operation)).toEqual([
      "delete",
      "update",
      "create",
    ]);
    expect(items[0]).toMatchObject({
      record_id: row.id,
      actor_id: f.admin.userId,
      before: { title: "After" },
      after: null,
    });
    expect(items[1]).toMatchObject({
      actor_id: f.worker.userId,
      changes: { title: { before: "Before", after: "After" } },
    });
    expect(items[2]).toMatchObject({
      before: null,
      after: { title: "Before", due: "2026-10-14T19:00:00.000Z" },
    });
    expect(await f.prisma.record.count({ where: { orgId: f.orgId } })).toBe(0);
  });

  test("batches correlate only committed records; mutation and history roll back together", async () => {
    const f = await fixture();
    const batch = await insertRecords(
      f.prisma,
      f.orgId,
      "tasks",
      [{ title: "A" }, { title: 2 }, { title: "B" }],
      f.admin.userId,
    );
    expect(batch.inserted).toBe(2);
    const before = await f.history();
    expect(before.items).toHaveLength(2);
    expect(new Set(before.items.map((row) => row.change_set_id)).size).toBe(1);
    await expect(
      withUnitOfWork({ prisma: f.prisma, provider }, async (unit) => {
        await insertRecordInTransaction(
          unit,
          f.orgId,
          "tasks",
          { title: "Rolled back" },
          f.admin.userId,
        );
        expect(
          await unit.db.recordHistory.count({ where: { orgId: f.orgId } }),
        ).toBe(3);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await f.history()).toEqual(before);
    expect(await f.prisma.record.count({ where: { orgId: f.orgId } })).toBe(2);
  });

  test("transactions preserve each mutation in order, across collections, with one correlation and no replay duplicates", async () => {
    const f = await fixture();
    const row = await f.create({ title: "Original" });
    const service = createTransactionService(f.prisma, provider);
    const request = {
      idempotency_key: "changes",
      operations: [
        {
          op: "record.update" as const,
          collection: "tasks",
          id: row.id,
          data: { title: "First" },
        },
        {
          op: "record.create" as const,
          collection: "notes",
          data: { title: "Other collection" },
        },
        {
          op: "record.update" as const,
          collection: "tasks",
          id: row.id,
          data: { title: "Second" },
        },
      ],
    };
    const response = await service.execute(f.admin, request);
    expect(await service.execute(f.admin, request)).toEqual(response);
    const changes = (await f.history()).items;
    expect(changes).toHaveLength(3);
    expect(changes.slice(0, 2).map((item) => item.after?.title)).toEqual([
      "Second",
      "First",
    ]);
    const changeSet = changes[0]!.change_set_id;
    const all = await f.prisma.recordHistory.findMany({
      where: { orgId: f.orgId, changeSetId: changeSet },
      orderBy: { position: "asc" },
    });
    expect(all.map((item) => item.operation)).toEqual([
      "update",
      "create",
      "update",
    ]);
    expect(all.every((item) => item.actorId === f.admin.userId)).toBe(true);
    // Equal timestamps retain the original mutation sequence.
    await f.prisma.recordHistory.updateMany({
      where: { orgId: f.orgId },
      data: { createdAt: new Date(Date.now() - 1000) },
    });
    expect(
      (await f.history({ change_set_id: changeSet })).items.map(
        (item) => item.after?.title,
      ),
    ).toEqual(["Second", "First"]);
    await expect(
      service.execute(f.admin, {
        operations: [
          ...request.operations,
          { op: "record.create", collection: "notes", data: { title: 1 } },
        ],
      }),
    ).rejects.toThrow();
    expect(
      await f.prisma.recordHistory.count({ where: { orgId: f.orgId } }),
    ).toBe(4);
    // An assistant corrects the value through the ordinary API; that correction is recorded.
    await f.update(row.id, { title: changes[1]!.before!.title });
    expect((await f.history()).items[0]).toMatchObject({
      changes: { title: { before: "Second", after: "Original" } },
    });
  });

  test("current row and field grants filter each saved version, including deleted records and hidden-only changes", async () => {
    const f = await fixture();
    await addPolicy(
      f.prisma,
      f.orgId,
      f.worker.userId,
      "/collections/tasks",
      "read",
      {
        where: { owner: "$user.id" },
        fields: ["title", "owner"],
      },
    );
    const own = await f.create({
      title: "Visible",
      owner: f.worker.userId,
      secret: "private-sentinel",
    });
    await f.update(own.id, { secret: "hidden-update-sentinel" });
    expect((await f.history({}, f.worker)).items).toHaveLength(1);
    await f.update(own.id, { title: "Restricted", owner: f.admin.userId });
    const moved = (await f.history({}, f.worker)).items[0]!;
    expect(moved.before).toEqual({ title: "Visible", owner: f.worker.userId });
    expect(moved).not.toHaveProperty("after");
    expect(JSON.stringify(moved)).not.toContain("Restricted");
    await f.update(own.id, { title: "Returned", owner: f.worker.userId });
    const returned = (await f.history({}, f.worker)).items[0]!;
    expect(returned).not.toHaveProperty("before");
    expect(returned.after).toEqual({
      title: "Returned",
      owner: f.worker.userId,
    });
    await f.remove(own.id);
    const history = await f.history({ record_id: own.id }, f.worker);
    expect(history.items[0]).toMatchObject({
      operation: "delete",
      before: { title: "Returned" },
      after: null,
    });
    expect(JSON.stringify(history)).not.toContain("sentinel");
    await f.create({ title: "Foreign row", owner: f.admin.userId });
    expect((await f.history({}, f.worker)).items).toHaveLength(4);
    await f.prisma.member.deleteMany({
      where: { organizationId: f.orgId, userId: f.worker.userId },
    });
    await expect(f.history({}, f.worker)).rejects.toThrow("Permission denied");
  });

  test("reused field names do not reinterpret incompatible historical values for permissions", async () => {
    const f = await fixture();
    const old = await f.create({
      title: "Historical",
      owner: "private-account",
      secret: "hidden",
    });
    await f.remove(old.id);
    await updateCollectionSchema(f.prisma, f.orgId, "tasks", undefined, [
      "owner",
    ]);
    await updateCollectionSchema(f.prisma, f.orgId, "tasks", {
      owner: "integer",
    });
    const current = await f.create({ title: "Current", owner: 0 });
    await addPolicy(
      f.prisma,
      f.orgId,
      f.worker.userId,
      "/collections/tasks",
      "read",
      {
        where: { owner: { lt: 1 } },
        fields: ["title"],
      },
    );
    const filtered = await f.history({}, f.worker);
    expect(filtered.items.map((item) => item.record_id)).toEqual([current.id]);
    // An independent matching grant still authorizes old versions without coercion.
    await addPolicy(
      f.prisma,
      f.orgId,
      f.worker.userId,
      "/collections/tasks",
      "read",
      {
        where: { title: "Historical" },
        fields: ["title"],
      },
    );
    const allowed = await f.history({}, f.worker);
    expect(allowed.items.map((item) => item.record_id)).toEqual([
      current.id,
      old.id,
      old.id,
    ]);
    expect(JSON.stringify(allowed)).not.toContain("private-account");
    expect(JSON.stringify(allowed)).not.toContain("hidden");
    expect((await f.history()).items[1]!.before).toMatchObject({
      owner: "private-account",
    });
  });

  test("history uses the same recurrence validation as record writes for conditional grants", async () => {
    const f = await fixture();
    await updateCollectionSchema(f.prisma, f.orgId, "tasks", {
      schedule: "recurrence",
    });
    const schedule = [
      "DTSTART;TZID=America/New_York:20260817T090000",
      "RRULE:FREQ=DAILY",
      "EXDATE;TZID=America/New_York:20260818T090000",
      "EXDATE;TZID=America/New_York:20260819T090000",
    ].join("\n");
    const row = await f.create({ title: "Recurring", schedule });
    await addPolicy(
      f.prisma,
      f.orgId,
      f.worker.userId,
      "/collections/tasks",
      "read",
      {
        where: { schedule },
        fields: ["title"],
      },
    );
    expect((await f.history({}, f.worker)).items).toMatchObject([
      { record_id: row.id, after: { title: "Recurring" } },
    ]);
  });

  test("change-set correlation does not widen access; read revocation also applies to history", async () => {
    const f = await fixture();
    const service = createTransactionService(f.prisma, provider);
    await service.execute(f.admin, {
      operations: [
        {
          op: "record.create",
          collection: "tasks",
          data: { title: "Visible", secret: "hidden" },
        },
        {
          op: "record.create",
          collection: "notes",
          data: { title: "Other collection" },
        },
      ],
    });
    const options = {
      where: { created_by: f.admin.userId },
      fields: ["title"],
    };
    await addPolicy(
      f.prisma,
      f.orgId,
      f.worker.userId,
      "/collections/tasks",
      "read",
      options,
    );
    const changeSet = (await f.history()).items[0]!.change_set_id;
    const visible = await f.history({ change_set_id: changeSet }, f.worker);
    expect(visible.items).toHaveLength(1);
    expect(visible.items[0]!.after).toEqual({ title: "Visible" });
    await expect(
      queryRecordHistory(f.prisma, f.worker, "notes", {
        change_set_id: changeSet,
      }),
    ).rejects.toThrow("Permission denied");
    await removePolicy(
      f.prisma,
      f.orgId,
      f.worker.userId,
      "/collections/tasks",
      "read",
      options,
    );
    await expect(f.history({}, f.worker)).rejects.toThrow("Permission denied");
  });

  test("pagination scans past hidden rows and returns only visible cursors without totals", async () => {
    const f = await fixture();
    await addPolicy(
      f.prisma,
      f.orgId,
      f.worker.userId,
      "/collections/tasks",
      "read",
      { where: { owner: "$user.id" }, fields: ["title"] },
    );
    await f.create({ title: "Oldest", owner: f.worker.userId });
    await insertRecords(
      f.prisma,
      f.orgId,
      "tasks",
      Array.from({ length: 105 }, () => ({
        title: "Hidden",
        owner: f.admin.userId,
      })),
      f.admin.userId,
    );
    await f.create({ title: "Newest", owner: f.worker.userId });
    const first = await f.history({ limit: 1 }, f.worker);
    expect(first.items.map((item) => item.after?.title)).toEqual(["Newest"]);
    expect(first.next_cursor).toBeString();
    expect(first).not.toHaveProperty("total");
    const second = await f.history(
      { limit: 1, cursor: first.next_cursor! },
      f.worker,
    );
    expect(second.items.map((item) => item.after?.title)).toEqual(["Oldest"]);
    expect(second.next_cursor).toBeNull();
    await expect(
      f.history(
        { record_id: first.items[0]!.record_id, cursor: first.next_cursor! },
        f.worker,
      ),
    ).rejects.toThrow("Invalid history cursor");
    await expect(f.history({ cursor: "invalid" })).rejects.toThrow(
      "Invalid history cursor",
    );
  });

  test("time bounds are inclusive/exclusive and expired history stays hidden before bounded cleanup", async () => {
    const f = await fixture();
    await f.create({ title: "Kept" });
    const now = new Date();
    const entry = await f.prisma.recordHistory.findFirstOrThrow({
      where: { orgId: f.orgId },
    });
    const time = new Date(now.getTime() - 1000);
    await f.prisma.recordHistory.update({
      where: { id: entry.id },
      data: { createdAt: time },
    });
    expect(
      (await f.history({ since: time.toISOString() }, f.admin, now)).items,
    ).toHaveLength(1);
    expect(
      (await f.history({ until: time.toISOString() }, f.admin, now)).items,
    ).toHaveLength(0);
    await expect(
      f.history({ since: now.toISOString(), until: time.toISOString() }),
    ).rejects.toThrow();
    await f.prisma.recordHistory.createMany({
      data: Array.from({ length: 501 }, () => ({
        id: crypto.randomUUID(),
        orgId: f.orgId,
        collectionId: f.collection.id,
        recordId: entry.recordId,
        operation: "create",
        actorId: f.admin.userId,
        changeSetId: crypto.randomUUID(),
        after: entry.after!,
        createdAt: new Date(now.getTime() - RECORD_HISTORY_RETENTION_MS),
      })),
    });
    await f.prisma.auditLog.create({
      data: {
        id: crypto.randomUUID(),
        orgId: f.orgId,
        userId: f.admin.userId,
        action: "test",
        resourceType: "record",
        createdAt: new Date(0),
      },
    });
    expect((await f.history({}, f.admin, now)).items).toHaveLength(1);
    expect(await pruneRecordHistory(f.prisma, now)).toBe(500);
    expect(
      await f.prisma.recordHistory.count({ where: { orgId: f.orgId } }),
    ).toBe(2);
    expect(await pruneRecordHistory(f.prisma, now)).toBe(1);
    expect(await f.prisma.auditLog.count({ where: { orgId: f.orgId } })).toBe(
      1,
    );
  });

  test("imports record new creation history with the importing actor and preserve original record metadata", async () => {
    const f = await fixture();
    const row = await f.create({ title: "Imported" });
    const dump = await exportData(f.prisma, f.orgId);
    await importData(f.prisma, f.orgId, dump, { actorId: f.worker.userId });
    const items = (await f.history()).items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      operation: "create",
      actor_id: f.worker.userId,
      after: row.data,
    });
    expect(items[0]!.record_id).not.toBe(row.id);
  });
});
