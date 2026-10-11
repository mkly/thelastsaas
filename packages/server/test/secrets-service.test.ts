import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import {
  AutomationConflictError,
  AutomationNotFoundError,
  AutomationUnavailableError,
  PermissionDeniedError,
  SchemaValidationError,
  type AutomationContext,
} from "@lastsaas/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPolicy, assignRole, removePolicy } from "../src/db/casbin";
import { loadSecretKeyring } from "../src/secrets/keyring";
import { createSecretService } from "../src/secrets/service";
import { testMigrationSql } from "./test-migrations";

const admin: AutomationContext = {
  orgId: "org-one",
  userId: "admin",
  userEmail: "admin@example.com",
};
const reader: AutomationContext = {
  orgId: "org-one",
  userId: "reader",
  userEmail: "reader@example.com",
};
const foreign: AutomationContext = {
  orgId: "org-two",
  userId: "foreign",
  userEmail: "foreign@example.com",
};
const plaintext = "private-credential-never-log";
const ring = loadSecretKeyring({
  SECRETS_ACTIVE_KEY_VERSION: "v1",
  SECRETS_KEYRING: JSON.stringify({
    v1: Buffer.alloc(32, 17).toString("base64"),
  }),
});

describe("secret service", () => {
  let directory: string;
  let database: Database;
  let prisma: PrismaClient;
  let service: ReturnType<typeof createSecretService>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "lastsaas-secret-service-"));
    const path = join(directory, "test.sqlite");
    database = new Database(path);
    database.exec("PRAGMA foreign_keys=ON");
    database.exec(testMigrationSql);
    prisma = new PrismaClient({ datasourceUrl: `file:${path}` });
    await prisma.organization.createMany({
      data: [
        { id: admin.orgId, name: "One", slug: "one" },
        { id: foreign.orgId, name: "Two", slug: "two" },
      ],
    });
    for (const context of [admin, reader, foreign]) {
      await prisma.user.create({
        data: {
          id: context.userId,
          name: context.userId,
          email: context.userEmail,
        },
      });
      await prisma.member.create({
        data: {
          id: `member_${context.userId}`,
          organizationId: context.orgId,
          userId: context.userId,
        },
      });
    }
    await addPolicy(prisma, admin.orgId, admin.userId, "/*", "*");
    await addPolicy(prisma, foreign.orgId, foreign.userId, "/*", "*");
    service = createSecretService(prisma, ring);
  });

  afterEach(async () => {
    await prisma.$disconnect();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("creation requires write on the root and grants no implicit metadata or value access", async () => {
    await expect(
      service.create(reader, { name: "credential", value: plaintext }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await addPolicy(prisma, reader.orgId, reader.userId, "/secrets", "write");
    const created = await service.create(reader, {
      name: "credential",
      value: plaintext,
    });
    expect(Object.keys(created).sort()).toEqual([
      "created_at",
      "id",
      "key_version",
      "name",
      "organization_id",
      "updated_at",
    ]);
    expect(created.key_version).toBe("v1");
    expect(JSON.stringify(created)).not.toContain(plaintext);
    await expect(service.show(reader, "credential")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(service.reveal(reader, "credential")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(
      service.create(reader, { name: "credential", value: "new" }),
    ).rejects.toBeInstanceOf(AutomationConflictError);
    expect(await prisma.secret.count()).toBe(1);
    await service.create(foreign, {
      name: "credential",
      value: "foreign-value",
    });
    expect((await service.reveal(admin, "credential")).value).toBe(plaintext);
    expect((await service.reveal(foreign, "credential")).value).toBe(
      "foreign-value",
    );
  });

  test("metadata, value, manage and delete are independent; intentional wildcards and roles work", async () => {
    await service.create(admin, { name: "credential", value: plaintext });
    await addPolicy(
      prisma,
      reader.orgId,
      reader.userId,
      "/secrets/credential",
      "read",
    );
    expect((await service.show(reader, "credential")).name).toBe("credential");
    expect((await service.list(reader, { limit: 10 })).items).toHaveLength(1);
    await expect(service.reveal(reader, "credential")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(
      service.replace(reader, "credential", { value: "changed" }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(service.delete(reader, "credential")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await removePolicy(
      prisma,
      reader.orgId,
      reader.userId,
      "/secrets/credential",
      "read",
    );
    await addPolicy(
      prisma,
      reader.orgId,
      reader.userId,
      "/secrets/credential/value",
      "read",
    );
    expect((await service.reveal(reader, "credential")).value).toBe(plaintext);
    await expect(service.show(reader, "credential")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    expect((await service.list(reader, { limit: 10 })).items).toEqual([]);
    await removePolicy(
      prisma,
      reader.orgId,
      reader.userId,
      "/secrets/credential/value",
      "read",
    );
    await addPolicy(
      prisma,
      reader.orgId,
      "org:org-one:user:workers",
      "/secrets/credential*",
      "read",
    );
    await assignRole(prisma, reader.orgId, reader.userId, "workers");
    expect((await service.reveal(reader, "credential")).value).toBe(plaintext);
    expect((await service.show(reader, "credential")).name).toBe("credential");
  });

  test("replacement uses the active key with a fresh nonce; manage does not grant read or delete", async () => {
    const original = await service.create(admin, {
      name: "credential",
      value: plaintext,
    });
    const stored = await prisma.secret.findUniqueOrThrow({
      where: { id: original.id },
    });
    const rotatedRing = loadSecretKeyring({
      SECRETS_ACTIVE_KEY_VERSION: "v2",
      SECRETS_KEYRING: JSON.stringify({
        v1: Buffer.alloc(32, 17).toString("base64"),
        v2: Buffer.alloc(32, 18).toString("base64"),
      }),
    });
    const updatedService = createSecretService(prisma, rotatedRing);
    await addPolicy(
      prisma,
      reader.orgId,
      reader.userId,
      "/secrets/credential",
      "manage",
    );
    const updated = await updatedService.replace(reader, "credential", {
      value: "replacement",
    });
    expect(updated.id).toBe(original.id);
    expect(updated.created_at).toBe(original.created_at);
    expect(updated.key_version).toBe("v2");
    expect(
      (await prisma.secret.findUniqueOrThrow({ where: { id: original.id } }))
        .nonce,
    ).not.toBe(stored.nonce);
    expect((await updatedService.reveal(admin, "credential")).value).toBe(
      "replacement",
    );
    await expect(
      updatedService.show(reader, "credential"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      updatedService.reveal(reader, "credential"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      updatedService.delete(reader, "credential"),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await removePolicy(
      prisma,
      reader.orgId,
      reader.userId,
      "/secrets/credential",
      "manage",
    );
    await expect(
      updatedService.replace(reader, "credential", { value: "denied" }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await addPolicy(
      prisma,
      reader.orgId,
      reader.userId,
      "/secrets/credential",
      "delete",
    );
    await updatedService.delete(reader, "credential");
    await expect(
      updatedService.show(admin, "credential"),
    ).rejects.toBeInstanceOf(AutomationNotFoundError);
    expect(
      (await prisma.auditLog.findMany()).map((row) => row.action),
    ).toContain("delete_secret");
  });

  test("foreign resources and revoked membership are nondisclosing, even with retained wildcard grants", async () => {
    await service.create(foreign, { name: "foreignOnly", value: plaintext });
    await expect(service.show(admin, "foreignOnly")).rejects.toBeInstanceOf(
      AutomationNotFoundError,
    );
    await expect(
      service.replace(admin, "foreignOnly", { value: "denied" }),
    ).rejects.toBeInstanceOf(AutomationNotFoundError);
    await expect(service.delete(admin, "foreignOnly")).rejects.toBeInstanceOf(
      AutomationNotFoundError,
    );
    await expect(service.reveal(admin, "foreignOnly")).rejects.toBeInstanceOf(
      AutomationNotFoundError,
    );
    expect((await service.list(admin, { limit: 10 })).items).toEqual([]);
    await prisma.member.delete({ where: { id: "member_foreign" } });
    for (const operation of [
      () => service.create(foreign, { name: "another", value: plaintext }),
      () => service.show(foreign, "foreignOnly"),
      () => service.list(foreign, { limit: 10 }),
      () => service.replace(foreign, "foreignOnly", { value: plaintext }),
      () => service.reveal(foreign, "foreignOnly"),
      () => service.delete(foreign, "foreignOnly"),
    ])
      await expect(operation()).rejects.toBeInstanceOf(AutomationNotFoundError);
    expect((await prisma.secret.findFirstOrThrow()).orgId).toBe(foreign.orgId);
  });

  test("pagination scans bounded candidates, continues empty filtered pages and rechecks current grants", async () => {
    for (const name of ["alpha", "beta", "gamma"])
      await service.create(admin, { name, value: plaintext });
    await prisma.secret.updateMany({
      data: { createdAt: new Date("2026-10-10T00:00:00Z") },
    });
    const ordered = await prisma.secret.findMany({ orderBy: { id: "asc" } });
    await addPolicy(
      prisma,
      reader.orgId,
      reader.userId,
      `/secrets/${ordered[1]!.name}`,
      "read",
    );
    const first = await service.list(reader, { limit: 1 });
    expect(first.items).toEqual([]);
    expect(first.next_cursor).not.toBeNull();
    const second = await service.list(reader, {
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.items.map((row) => row.id)).toEqual([ordered[1]!.id]);
    await removePolicy(
      prisma,
      reader.orgId,
      reader.userId,
      `/secrets/${ordered[1]!.name}`,
      "read",
    );
    expect(
      (await service.list(reader, { limit: 1, cursor: first.next_cursor! }))
        .items,
    ).toEqual([]);
    const last = await service.list(admin, {
      limit: 1,
      cursor: second.next_cursor!,
    });
    expect(last.items.map((row) => row.id)).toEqual([ordered[2]!.id]);
    expect(last.next_cursor).toBeNull();
    for (const input of [
      { limit: 101 },
      { limit: 0 },
      { limit: 1.5 },
      { limit: 1, cursor: "malformed" },
      { limit: 1, cursor: "x".repeat(2049) },
    ])
      await expect(service.list(reader, input)).rejects.toBeInstanceOf(
        SchemaValidationError,
      );
    await expect(
      service.list(foreign, { limit: 1, cursor: first.next_cursor! }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
    const wrongResource = Buffer.from(
      JSON.stringify({
        resource: "queues:v1",
        orgId: admin.orgId,
        createdAt: ordered[0]!.createdAt.toISOString(),
        id: ordered[0]!.id,
      }),
    ).toString("base64url");
    await expect(
      service.list(reader, { limit: 1, cursor: wrongResource }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
  });

  test("strict validation and the UTF-8 size cap never expose submitted values in errors", async () => {
    const failures = [
      () => service.create(admin, { name: "bad/name", value: plaintext }),
      () =>
        service.create(admin, { name: "credential", value: "é".repeat(32769) }),
      () =>
        service.create(admin, {
          name: "credential",
          value: plaintext,
          unexpected: plaintext,
        } as never),
      () =>
        service.replace(admin, "missing", {
          value: plaintext,
          unexpected: plaintext,
        } as never),
    ];
    for (const operation of failures) {
      try {
        await operation();
        throw new Error("Expected validation failure");
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaValidationError);
        expect(JSON.stringify(error)).not.toContain(plaintext);
        expect(String(error)).not.toContain(plaintext);
      }
    }
    expect(await prisma.secret.count()).toBe(0);
    await service.create(admin, { name: "boundary", value: "é".repeat(32768) });
    expect((await service.reveal(admin, "boundary")).value).toBe(
      "é".repeat(32768),
    );
  });

  test("missing keys preserve metadata access but reject writes and audited reveals without mutation", async () => {
    const created = await service.create(admin, {
      name: "credential",
      value: plaintext,
    });
    const unavailable = createSecretService(prisma, null);
    expect(await unavailable.show(admin, "credential")).toEqual(created);
    expect((await unavailable.list(admin, { limit: 1 })).items).toEqual([
      created,
    ]);
    await expect(
      unavailable.create(admin, { name: "another", value: plaintext }),
    ).rejects.toBeInstanceOf(AutomationUnavailableError);
    await expect(
      unavailable.replace(admin, "credential", { value: "replacement" }),
    ).rejects.toBeInstanceOf(AutomationUnavailableError);
    await expect(
      unavailable.reveal(admin, "credential"),
    ).rejects.toBeInstanceOf(AutomationUnavailableError);
    const audits = await prisma.auditLog.findMany({
      where: {
        orgId: admin.orgId,
        userId: admin.userId,
        action: "reveal_secret",
        resourceType: "secret",
        resourceId: created.id,
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.details).toEqual({
      outcome: "failed",
      error: "AutomationUnavailableError",
    });
    expect((await service.reveal(admin, "credential")).value).toBe(plaintext);
    await unavailable.delete(admin, "credential");
    expect(await prisma.secret.count()).toBe(0);
  });

  test("success, denied and tampered reveals audit only safe metadata and do not log plaintext", async () => {
    const logs = [
      spyOn(console, "log"),
      spyOn(console, "warn"),
      spyOn(console, "error"),
    ];
    try {
      const created = await service.create(admin, {
        name: "credential",
        value: plaintext,
      });
      await expect(service.reveal(reader, "credential")).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      expect(await service.reveal(admin, "credential")).toEqual({
        id: created.id,
        name: "credential",
        value: plaintext,
      });
      await prisma.secret.update({
        where: { id: created.id },
        data: { authTag: Buffer.alloc(16).toString("base64") },
      });
      await expect(service.reveal(admin, "credential")).rejects.toBeInstanceOf(
        AutomationUnavailableError,
      );
      const audits = await prisma.auditLog.findMany({
        where: { action: "reveal_secret" },
        orderBy: { createdAt: "asc" },
      });
      expect(audits.map((row) => row.details)).toEqual([
        { outcome: "failed", error: "PermissionDeniedError" },
        { outcome: "succeeded" },
        { outcome: "failed", error: "AutomationUnavailableError" },
      ]);
      expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(
        plaintext,
      );
      expect(JSON.stringify(await prisma.secret.findMany())).not.toContain(
        plaintext,
      );
      for (const log of logs)
        expect(JSON.stringify(log.mock.calls)).not.toContain(plaintext);
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });

  test("audit persistence failures roll back mutations and prevent unaudited plaintext responses", async () => {
    const original = await service.create(admin, {
      name: "credential",
      value: plaintext,
    });
    database.exec(
      "CREATE TRIGGER reject_secret_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    await expect(
      service.create(admin, { name: "another", value: "replacement" }),
    ).rejects.toThrow();
    await expect(
      service.replace(admin, "credential", { value: "replacement" }),
    ).rejects.toThrow();
    await expect(service.delete(admin, "credential")).rejects.toThrow();
    await expect(service.reveal(admin, "credential")).rejects.toThrow();
    expect(await prisma.secret.count()).toBe(1);
    expect(await service.show(admin, "credential")).toEqual(original);
    database.exec("DROP TRIGGER reject_secret_audit");
    expect((await service.reveal(admin, "credential")).value).toBe(plaintext);
  });
});
