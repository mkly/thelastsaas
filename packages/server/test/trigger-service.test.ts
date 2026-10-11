import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Schema, TriggerCreate, TriggerUpdate } from "@lastsaas/shared";
import {
  addPolicy,
  removePolicy,
  assignRole,
  roleSubject,
} from "../src/db/casbin";
import { evaluateGrants } from "../src/db/resource-grants";
import {
  createTriggerService,
  validateTriggerConfiguration,
} from "../src/triggers/service";
import { testMigrationSql } from "./test-migrations";

const context = {
  orgId: "org",
  userId: "creator",
  userEmail: "creator@example.com",
};
const admin = { ...context, userId: "admin", userEmail: "admin@example.com" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-triggers-"));
  const path = join(directory, "test.db");
  const database = new Database(path);
  database.exec(testMigrationSql);
  const prisma = new PrismaClient({ datasourceUrl: `file:${path}` });
  cleanups.push(async () => {
    await prisma.$disconnect();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  for (const principal of [context, admin])
    await prisma.user.create({
      data: {
        id: principal.userId,
        email: principal.userEmail,
        name: principal.userId,
      },
    });
  for (const orgId of ["org", "foreign"]) {
    await prisma.organization.create({
      data: { id: orgId, name: orgId, slug: orgId },
    });
    for (const userId of ["creator", "admin"])
      await prisma.member.create({
        data: {
          id: `${orgId}-${userId}`,
          organizationId: orgId,
          userId,
          role: "member",
        },
      });
    await prisma.collection.create({
      data: {
        id: `${orgId}-tickets`,
        orgId,
        name: "tickets",
        schema: {
          title: "string",
          count: "integer",
          private: "string",
          kind: "enum:a,b",
          rule: "recurrence",
          id: "string",
        },
      },
    });
    await prisma.queue.create({
      data: {
        id: `${orgId}-jobs`,
        orgId,
        name: "jobs",
        schema: {
          title: "string",
          count: "number",
          kind: "enum:a,b,c",
          timestamp: "datetime",
          blob: "json",
        },
      },
    });
  }
  const grant = (resource: string, action: string, options = {}) =>
    addPolicy(prisma, context.orgId, context.userId, resource, action, options);
  const permissions = async () => {
    await grant("/triggers", "write");
    await grant("/collections/tickets", "read");
    await grant("/queues/jobs", "create");
  };
  const service = createTriggerService(prisma, "sqlite");
  const input: TriggerCreate = {
    collection: "tickets",
    queue: "jobs",
    events: ["update"],
    mapping: { title: { kind: "after", field: "title" } },
    enabled: true,
  };
  return { prisma, service, grant, permissions, input };
}

describe("collection trigger configuration", () => {
  test("stores explicit creator, defaults, mapping and pause reason with metadata-only audits", async () => {
    const { prisma, service, permissions, input } = await fixture();
    await permissions();
    const row = await service.create(context, {
      ...input,
      enabled: undefined,
    } as unknown as TriggerCreate);
    expect(row).toMatchObject({
      created_by: "creator",
      organization_id: "org",
      collection_id: "org-tickets",
      queue_id: "org-jobs",
      status: "active",
      pause_reason: null,
      watched_fields: null,
      where: null,
    });
    expect(row.created_at).toMatch(/Z$/);
    await addPolicy(prisma, "org", "admin", "/*", "*");
    const paused = await service.update(admin, row.id, {
      enabled: false,
      mapping: { title: { kind: "literal", value: "sensitive literal" } },
    });
    expect(paused).toMatchObject({
      status: "paused",
      created_by: "creator",
      pause_reason: "Paused by user",
    });
    await prisma.collectionTrigger.update({
      where: { id: row.id },
      data: { pauseReason: "Creator lost source read access" },
    });
    expect(
      (
        await service.update(admin, row.id, {
          mapping: { title: { kind: "literal", value: "sensitive literal" } },
        })
      ).pause_reason,
    ).toBe("Creator lost source read access");
    expect(
      (await service.update(admin, row.id, { enabled: true })).pause_reason,
    ).toBeNull();
    expect((await service.show(admin, row.id)).mapping).toEqual(paused.mapping);
    const audit = await prisma.auditLog.findMany();
    expect(audit.map((a) => a.userId)).toEqual([
      "creator",
      "admin",
      "admin",
      "admin",
    ]);
    expect(JSON.stringify(audit)).not.toContain("sensitive literal");
    await service.delete(admin, row.id);
    expect(await prisma.collectionTrigger.count()).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { action: "delete_trigger" } }),
    ).toBe(1);
  });

  test("strict mapping union rejects code, secret reads, passthrough and unknown control fields", async () => {
    const { prisma, service, permissions, input } = await fixture();
    await permissions();
    for (const mapping of [
      { title: { kind: "code", value: "return source" } },
      { title: { kind: "secret", name: "credential" } },
      { title: { kind: "after" } },
      { title: { kind: "after", field: "title", extra: true } },
      { title: "after.title" },
      { title: { kind: "metadata", key: "secret" } },
    ])
      await expect(
        service.create(context, {
          ...input,
          mapping,
        } as unknown as TriggerCreate),
      ).rejects.toMatchObject({ code: "SchemaValidationError" });
    await expect(
      service.create(context, {
        ...input,
        created_by: "admin",
      } as unknown as TriggerCreate),
    ).rejects.toMatchObject({ code: "SchemaValidationError" });
    expect(await prisma.collectionTrigger.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  test("validates source, predicate/watch, destination fields and incompatible dynamic/literal types", async () => {
    const { service, permissions, input, prisma } = await fixture();
    await permissions();
    for (const patch of [
      { watched_fields: ["missing"] },
      { where: { missing: "x" } },
      { mapping: { title: { kind: "after", field: "missing" } } },
      { mapping: { missing: { kind: "literal", value: "x" } } },
      { mapping: { count: { kind: "after", field: "title" } } },
      { mapping: { kind: { kind: "after", field: "title" } } },
      { mapping: { count: { kind: "literal", value: "x" } } },
      {
        where: {
          rule: {
            occurs_between: ["2026-10-10T00:00:00Z", "2026-10-11T00:00:00Z"],
          },
        },
      },
    ])
      await expect(
        service.create(context, { ...input, ...patch } as TriggerCreate),
      ).rejects.toHaveProperty("code");
    expect(await prisma.collectionTrigger.count()).toBe(0);
    const valid = await service.create(context, {
      ...input,
      mapping: {
        count: { kind: "before", field: "count" },
        kind: { kind: "after", field: "kind" },
        timestamp: { kind: "metadata", key: "occurredAt" },
        blob: { kind: "literal", value: { nested: [1, true] } },
      },
    });
    expect(valid.mapping).toHaveProperty("count");
    // C01 freezes optional/null fields and rejects a required modifier.
    await expect(
      service.create(context, { ...input, mapping: {} }),
    ).resolves.toHaveProperty("id");
    await expect(
      service.create(context, {
        ...input,
        mapping: { title: { kind: "literal", value: "x".repeat(65536) } },
      }),
    ).rejects.toMatchObject({ code: "SchemaValidationError" });
  });

  test("snapshot/event compatibility is revalidated after patches are merged", async () => {
    const { service, permissions, input, prisma, grant } = await fixture();
    await permissions();
    for (const patch of [
      {
        events: ["create"],
        mapping: { title: { kind: "before", field: "title" } },
      },
      { events: ["delete"], mapping: input.mapping },
      { events: ["create"], watched_fields: ["title"] },
    ])
      await expect(
        service.create(context, { ...input, ...patch } as TriggerCreate),
      ).rejects.toMatchObject({ code: "SchemaValidationError" });
    const row = await service.create(context, input);
    await grant(`/triggers/${row.id}`, "update");
    await expect(
      service.update(context, row.id, { events: ["delete"] }),
    ).rejects.toMatchObject({ code: "SchemaValidationError" });
    await expect(
      service.update(context, row.id, { created_by: "admin" } as TriggerUpdate),
    ).rejects.toMatchObject({ code: "SchemaValidationError" });
    await expect(service.update(context, row.id, {})).rejects.toMatchObject({
      code: "SchemaValidationError",
    });
    expect(
      (
        await prisma.collectionTrigger.findUniqueOrThrow({
          where: { id: row.id },
        })
      ).events,
    ).toEqual(["update"]);
    expect(await prisma.auditLog.count()).toBe(1);
    await expect(
      service.update(context, row.id, {
        events: ["create", "delete"],
        mapping: { title: { kind: "metadata", key: "event" } },
      }),
    ).resolves.toHaveProperty("id");
  });

  test("configuration gates never substitute for source reads or destination enqueue grants", async () => {
    const { service, grant, input, prisma } = await fixture();
    await expect(service.create(context, input)).rejects.toMatchObject({
      code: "PermissionDeniedError",
    });
    await grant("/triggers", "write");
    await expect(service.create(context, input)).rejects.toMatchObject({
      code: "PermissionDeniedError",
    });
    await grant("/collections/tickets", "read");
    await grant("/queues/jobs", "manage");
    await expect(service.create(context, input)).rejects.toMatchObject({
      code: "PermissionDeniedError",
    });
    await grant("/queues/jobs", "write");
    const row = await service.create(context, input);
    await expect(service.show(context, row.id)).rejects.toMatchObject({
      code: "PermissionDeniedError",
    });
    await expect(
      service.update(context, row.id, { enabled: false }),
    ).rejects.toMatchObject({ code: "PermissionDeniedError" });
    await expect(service.delete(context, row.id)).rejects.toMatchObject({
      code: "PermissionDeniedError",
    });
    expect((await service.list(context, { limit: 100 })).items).toEqual([]);
    await grant(`/triggers/${row.id}`, "write");
    await expect(
      service.update(context, row.id, { enabled: false }),
    ).resolves.toHaveProperty("status", "paused");
    await prisma.member.delete({ where: { id: "org-creator" } });
    await expect(service.create(context, input)).rejects.toMatchObject({
      code: "AutomationNotFoundError",
    });
  });

  test("mapped, watched and predicate fields require collection source readability", async () => {
    const { service, grant, input, prisma } = await fixture();
    await grant("/triggers", "write");
    await grant("/collections/tickets", "read", { fields: ["title"] });
    await grant("/queues/jobs", "create");
    for (const patch of [
      { mapping: { title: { kind: "after", field: "private" } } },
      { mapping: { title: { kind: "after", field: "id" } } },
      { watched_fields: ["id"] },
      { watched_fields: ["private"] },
      { where: { private: "x" } },
      { mapping: { count: { kind: "after", field: "count" } } },
    ])
      await expect(
        service.create(context, { ...input, ...patch } as TriggerCreate),
      ).rejects.toMatchObject({ code: "FieldPermissionDeniedError" });
    expect(await prisma.collectionTrigger.count()).toBe(0);
    await expect(service.create(context, input)).resolves.toHaveProperty("id");
    // Additive granting roles can expose another field; source constraints still apply per row.
    await grant("/collections/tickets", "read", { fields: ["private"] });
    await expect(
      service.create(context, {
        ...input,
        mapping: { title: { kind: "after", field: "private" } },
      }),
    ).resolves.toHaveProperty("id");
  });

  test("preserves collection row-dependent field reads and substitutions", async () => {
    const { service, grant, input, prisma } = await fixture();
    await grant("/triggers", "write");
    await grant("/collections/tickets", "read", {
      where: { private: "$user.email" },
      fields: ["title"],
    });
    await grant("/queues/jobs", "create");
    // Dynamic row checks wait for the mutation snapshot; configuration does not drop them.
    await expect(service.create(context, input)).resolves.toHaveProperty("id");
    await prisma.$transaction(async (db) => {
      const validated = await validateTriggerConfiguration(
        { db, provider: "sqlite" },
        context,
        input,
      );
      expect(JSON.stringify(validated.readWhere)).toContain(context.userEmail);
      for (const [email, expected] of [
        [context.userEmail, true],
        ["other", false],
      ] as const) {
        const result = await evaluateGrants(
          db,
          validated.readGrants,
          {
            id: "record",
            data: { title: "allowed", private: email },
            createdBy: "creator",
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          validated.collection.schema as Schema,
          "sqlite",
        );
        expect(result).toEqual([expected]);
      }
    });
  });

  test("uses legacy role row and field filters for configuration", async () => {
    const { prisma, service, grant, input } = await fixture();
    await grant("/triggers", "write");
    await grant("/queues/jobs", "create");
    await assignRole(prisma, "org", "creator", "reader");
    await addPolicy(
      prisma,
      "org",
      roleSubject("org", "reader"),
      "/collections/tickets",
      "read",
    );
    await prisma.fieldFilter.create({
      data: {
        id: "filter",
        orgId: "org",
        collectionId: "org-tickets",
        role: "reader",
        action: "read",
        readableFields: ["title"],
        writableFields: [],
      },
    });
    await prisma.rowFilter.create({
      data: {
        id: "row",
        orgId: "org",
        collectionId: "org-tickets",
        role: "reader",
        action: "read",
        condition: { private: "$user.email" },
      },
    });
    await expect(
      service.create(context, { ...input, watched_fields: ["private"] }),
    ).rejects.toMatchObject({ code: "FieldPermissionDeniedError" });
    await expect(service.create(context, input)).resolves.toHaveProperty("id");
  });

  test("admin edits retain original creator and cannot use admin grants after creator revocation", async () => {
    const { prisma, service, permissions, input } = await fixture();
    await permissions();
    const row = await service.create(context, input);
    await addPolicy(prisma, "org", "admin", "/*", "*");
    await removePolicy(prisma, "org", "creator", "/queues/jobs", "create");
    await expect(
      service.update(admin, row.id, { enabled: true }),
    ).rejects.toMatchObject({ code: "PermissionDeniedError" });
    expect((await service.show(admin, row.id)).created_by).toBe("creator");
    await addPolicy(prisma, "org", "creator", "/queues/jobs", "create");
    await prisma.member.delete({ where: { id: "org-creator" } });
    await expect(
      service.update(admin, row.id, { enabled: false }),
    ).rejects.toMatchObject({ code: "AutomationNotFoundError" });
    await service.delete(admin, row.id);
  });

  test("foreign IDs/selectors, nonmembers are nondisclosing; database relations enforce organization scope", async () => {
    const { prisma, service, permissions, input, grant } = await fixture();
    await permissions();
    await grant("/triggers/*", "*");
    const row = await service.create(context, input);
    const foreign = { ...context, orgId: "foreign" };
    for (const id of [row.id, "missing"])
      for (const operation of [
        () => service.show(foreign, id),
        () => service.update(foreign, id, { enabled: false }),
        () => service.delete(foreign, id),
      ])
        await expect(operation()).rejects.toMatchObject({
          code: "AutomationNotFoundError",
        });
    await expect(
      service.create(context, { ...input, collection: "missing" }),
    ).rejects.toMatchObject({ code: "AutomationNotFoundError" });
    await expect(
      Promise.resolve(
        prisma.collectionTrigger.create({
          data: {
            id: "cross-org",
            orgId: "org",
            createdBy: "creator",
            collectionId: "foreign-tickets",
            queueId: "org-jobs",
            events: ["create"],
            mapping: {},
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      Promise.resolve(
        prisma.collectionTrigger.update({
          where: { id: row.id },
          data: { queueId: "foreign-jobs" },
        }),
      ),
    ).rejects.toMatchObject({ code: "P2003" });
    expect(
      (
        await prisma.collectionTrigger.findUniqueOrThrow({
          where: { id: row.id },
        })
      ).queueId,
    ).toBe("org-jobs");
  });

  test("enabled cap covers create, resume and collection moves while paused triggers do not consume capacity", async () => {
    const { prisma, service, permissions, input, grant } = await fixture();
    await permissions();
    await grant("/triggers/*", "*");
    for (let n = 0; n < 25; n++) await service.create(context, input);
    await expect(service.create(context, input)).rejects.toMatchObject({
      code: "AutomationConflictError",
    });
    const paused = await service.create(context, { ...input, enabled: false });
    await expect(
      service.update(context, paused.id, { enabled: true }),
    ).rejects.toMatchObject({ code: "AutomationConflictError" });
    await prisma.collection.create({
      data: {
        id: "other",
        orgId: "org",
        name: "other",
        schema: { title: "string" },
      },
    });
    await grant("/collections/other", "read");
    const other = await service.create(context, {
      ...input,
      collection: "other",
    });
    await expect(
      service.update(context, other.id, { collection: "tickets" }),
    ).rejects.toMatchObject({ code: "AutomationConflictError" });
    // Updating an enabled trigger does not count it twice.
    const active = await prisma.collectionTrigger.findFirstOrThrow({
      where: { collectionId: "org-tickets", status: "active" },
    });
    await service.update(context, active.id, { watched_fields: ["title"] });
    await service.update(context, active.id, { enabled: false });
    await service.update(context, paused.id, { enabled: true });
    expect(
      await prisma.collectionTrigger.count({
        where: { collectionId: "org-tickets", status: "active" },
      }),
    ).toBe(25);
  });

  test("bounded list scans hidden rows and rejects cursors from other organizations/resources", async () => {
    const { prisma, service, permissions, input, grant } = await fixture();
    await permissions();
    for (let n = 0; n < 3; n++) await service.create(context, input);
    await prisma.collectionTrigger.updateMany({
      data: { createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    const rows = await prisma.collectionTrigger.findMany({
      orderBy: { id: "asc" },
    });
    await grant(`/triggers/${rows[2]!.id}`, "read");
    const first = await service.list(context, { limit: 1 });
    expect(first.items).toEqual([]);
    expect(first.next_cursor).not.toBeNull();
    const second = await service.list(context, {
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.items).toEqual([]);
    const third = await service.list(context, {
      limit: 1,
      cursor: second.next_cursor!,
    });
    expect(third.items.map((t) => t.id)).toEqual([rows[2]!.id]);
    expect(third.next_cursor).toBeNull();
    for (const request of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1, cursor: "bad" },
    ])
      await expect(service.list(context, request)).rejects.toMatchObject({
        code: "SchemaValidationError",
      });
    await expect(
      service.list(
        { ...context, orgId: "foreign" },
        { limit: 1, cursor: first.next_cursor! },
      ),
    ).rejects.toMatchObject({ code: "SchemaValidationError" });
    const unrelated = Buffer.from(
      JSON.stringify({
        scope: JSON.stringify(["queues:v1", "org"]),
        createdAt: rows[0]!.createdAt.toISOString(),
        id: rows[0]!.id,
      }),
    ).toString("base64url");
    await expect(
      service.list(context, { limit: 1, cursor: unrelated }),
    ).rejects.toMatchObject({ code: "SchemaValidationError" });
  });

  test("edits revalidate current source grants and destination schemas; legacy collection names remain supported", async () => {
    const { prisma, service, permissions, input, grant } = await fixture();
    await permissions();
    const row = await service.create(context, input);
    await grant(`/triggers/${row.id}`, "update");
    await removePolicy(
      prisma,
      "org",
      "creator",
      "/collections/tickets",
      "read",
    );
    await expect(
      service.update(context, row.id, { enabled: true }),
    ).rejects.toMatchObject({ code: "PermissionDeniedError" });
    await grant("/collections/tickets", "read");
    await prisma.queue.update({
      where: { id: "org-jobs" },
      data: { schema: { title: "number" } },
    });
    await expect(
      service.update(context, row.id, { enabled: true }),
    ).rejects.toMatchObject({ code: "SchemaValidationError" });
    await prisma.queue.update({
      where: { id: "org-jobs" },
      data: { schema: { title: "string" } },
    });
    await prisma.collection.create({
      data: {
        id: "legacy",
        orgId: "org",
        name: "old-name",
        schema: { title: "string" },
      },
    });
    await grant("/collections/old-name", "read");
    expect(
      await service.update(context, row.id, { collection: "old-name" }),
    ).toMatchObject({ collection: "old-name", created_by: "creator" });
  });

  test("configuration and audit are atomic on persistence failure", async () => {
    const { prisma, service, permissions, input } = await fixture();
    await permissions();
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER fail_trigger_audit BEFORE INSERT ON audit_log WHEN NEW.action = 'create_trigger' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    );
    await expect(service.create(context, input)).rejects.toThrow();
    expect(await prisma.collectionTrigger.count()).toBe(0);
  });
});
