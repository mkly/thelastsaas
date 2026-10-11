import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PrismaClient } from "@prisma/client";
import {
  AutomationConflictError,
  AutomationUnavailableError,
  SchemaValidationError,
  type AutomationContext,
} from "@lastsaas/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addPolicy } from "../src/db/casbin";
import { decryptSecret, encryptSecret } from "../src/secrets/crypto";
import { loadSecretKeyring } from "../src/secrets/keyring";
import { rotateSecretBatch } from "../src/secrets/rotation";
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
const encodedKeys = Object.fromEntries(
  ["v1", "v2", "v3"].map((version, i) => [
    version,
    Buffer.alloc(32, i + 17).toString("base64"),
  ]),
);
const ring = loadSecretKeyring({
  SECRETS_ACTIVE_KEY_VERSION: "v3",
  SECRETS_KEYRING: JSON.stringify(encodedKeys),
})!;

// Every behavior check uses a real, isolated SQLite database.
describe("resumable secret-key rotation", () => {
  let directory: string;
  let database: Database;
  let prisma: PrismaClient;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "lastsaas-secret-rotation-"));
    const path = join(directory, "test.sqlite");
    database = new Database(path);
    database.exec("PRAGMA foreign_keys=ON");
    database.exec(testMigrationSql);
    prisma = new PrismaClient({ datasourceUrl: `file:${path}` });
    for (const id of ["org-one", "org-two"])
      await prisma.organization.create({ data: { id, name: id, slug: id } });
    for (const context of [admin, reader]) {
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
  });

  afterEach(async () => {
    await prisma.$disconnect();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function insert(id: string, version = "v1", orgId = admin.orgId) {
    const identity = { id, orgId };
    return prisma.secret.create({
      data: {
        ...identity,
        name: id,
        ...encryptSecret(ring, identity, `private-${id}`, version),
      },
    });
  }

  test("bounded mixed-version batches resume after restart, remain readable, and are idempotent", async () => {
    for (const [id, version] of [
      ["a", "v1"],
      ["b", "v2"],
      ["c", "v3"],
      ["d", "v1"],
    ])
      await insert(id!, version!);
    const foreign = await insert("foreign", "v1", "org-two");
    const original = await prisma.secret.findMany({
      where: { orgId: admin.orgId },
    });
    const first = await rotateSecretBatch(prisma, ring, admin.orgId, {
      key_version: "v3",
      limit: 1,
    });
    expect(first.rotated).toBe(1);
    expect(first.next_cursor).not.toBeNull();
    for (const row of await prisma.secret.findMany())
      expect(decryptSecret(ring, row, row)).toBe(`private-${row.id}`);
    const rotatedA = await prisma.secret.findUniqueOrThrow({
      where: { id: "a" },
    });
    expect(rotatedA.keyVersion).toBe("v3");
    expect(rotatedA.nonce).not.toBe(
      original.find((row) => row.id === "a")!.nonce,
    );
    expect(rotatedA.createdAt).toEqual(
      original.find((row) => row.id === "a")!.createdAt,
    );
    await prisma.$disconnect();
    prisma = new PrismaClient({
      datasourceUrl: `file:${join(directory, "test.sqlite")}`,
    });
    const second = await rotateSecretBatch(prisma, ring, admin.orgId, {
      key_version: "v3",
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.rotated).toBe(1);
    expect(second.next_cursor).not.toBeNull();
    const last = await rotateSecretBatch(prisma, ring, admin.orgId, {
      key_version: "v3",
      limit: 1,
      cursor: second.next_cursor!,
    });
    expect(last).toEqual({ rotated: 1, next_cursor: null });
    expect(
      await rotateSecretBatch(prisma, ring, admin.orgId, {
        key_version: "v3",
        limit: 100,
      }),
    ).toEqual({ rotated: 0, next_cursor: null });
    expect(
      await prisma.secret.findUniqueOrThrow({ where: { id: "foreign" } }),
    ).toEqual(foreign);
    const rows = await prisma.secret.findMany({
      where: { orgId: admin.orgId },
    });
    for (const row of rows)
      expect(decryptSecret(ring, row, row)).toBe(`private-${row.id}`);
    const audits = await prisma.auditLog.findMany();
    expect(audits).toHaveLength(3);
    expect(audits.every((row) => row.action === "rotate_secret")).toBe(true);
    expect(audits.map((row) => row.details)).toEqual([
      { operator: "local", from_version: "v1", to_version: "v3" },
      { operator: "local", from_version: "v2", to_version: "v3" },
      { operator: "local", from_version: "v1", to_version: "v3" },
    ]);
    expect(JSON.stringify(audits)).not.toContain("private-");
    expect(Object.keys(last).sort()).toEqual(["next_cursor", "rotated"]);
    expect(ring.keys.size).toBe(3);
    expect(ring.activeVersion).toBe("v3");
  });

  test("unavailable old/new keys and tampered envelopes roll back the entire batch", async () => {
    await insert("a");
    await insert("b", "v2");
    const original = await prisma.secret.findMany({ orderBy: { id: "asc" } });
    const missingOld = {
      ...ring,
      keys: new Map([
        ["v1", ring.keys.get("v1")!],
        ["v3", ring.keys.get("v3")!],
      ]),
    };
    for (const keyring of [null, missingOld]) {
      await expect(
        rotateSecretBatch(prisma, keyring, admin.orgId, {
          key_version: "v3",
          limit: 100,
        }),
      ).rejects.toBeInstanceOf(AutomationUnavailableError);
      expect(await prisma.secret.findMany({ orderBy: { id: "asc" } })).toEqual(
        original,
      );
      expect(await prisma.auditLog.count()).toBe(0);
    }
    await expect(
      rotateSecretBatch(prisma, ring, admin.orgId, {
        key_version: "unknown",
        limit: 100,
      }),
    ).rejects.toBeInstanceOf(AutomationUnavailableError);
    await prisma.secret.update({
      where: { id: "b" },
      data: { authTag: Buffer.alloc(16).toString("base64") },
    });
    const tampered = await prisma.secret.findMany({ orderBy: { id: "asc" } });
    await expect(
      rotateSecretBatch(prisma, ring, admin.orgId, {
        key_version: "v3",
        limit: 100,
      }),
    ).rejects.toBeInstanceOf(AutomationUnavailableError);
    expect(await prisma.secret.findMany({ orderBy: { id: "asc" } })).toEqual(
      tampered,
    );
    expect(await prisma.auditLog.count()).toBe(0);
  });

  test("strict batch limits and cursors are bound to the organization, resource and target", async () => {
    await insert("a");
    await insert("b");
    const first = await rotateSecretBatch(prisma, ring, admin.orgId, {
      key_version: "v3",
      limit: 1,
    });
    for (const input of [
      { key_version: "v3", limit: 0 },
      { key_version: "v3", limit: 101 },
      { key_version: "v3", limit: 1.5 },
      { key_version: "v3", limit: 1, cursor: "invalid" },
      { key_version: "v2", limit: 1, cursor: first.next_cursor! },
      { key_version: "v3", limit: 1, cursor: "x".repeat(2049) },
      { key_version: "v3", limit: 1, extra: "private-input" },
    ])
      await expect(
        rotateSecretBatch(prisma, ring, admin.orgId, input as never),
      ).rejects.toBeInstanceOf(SchemaValidationError);
    await expect(
      rotateSecretBatch(prisma, ring, "org-two", {
        key_version: "v3",
        limit: 1,
        cursor: first.next_cursor!,
      }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
    const wrongResource = Buffer.from(
      JSON.stringify({
        resource: "secrets:v1",
        orgId: admin.orgId,
        keyVersion: "v3",
        id: "a",
      }),
    ).toString("base64url");
    await expect(
      rotateSecretBatch(prisma, ring, admin.orgId, {
        key_version: "v3",
        limit: 1,
        cursor: wrongResource,
      }),
    ).rejects.toBeInstanceOf(SchemaValidationError);
  });

  test("a stale snapshot cannot overwrite a replacement at the same version and timestamp", async () => {
    const stale = await insert("a");
    const replacement = await prisma.secret.update({
      where: { id: stale.id },
      data: {
        ...encryptSecret(ring, stale, "latest-replacement", "v1"),
        updatedAt: stale.updatedAt,
      },
    });
    // Deterministically model the snapshot read racing a committed replacement.
    // Actual conditional updates execute against SQLite with the newest envelope.
    const staleReader = prisma.$extends({
      query: {
        secret: {
          async findMany({ args, query }) {
            const rows = await query(args);
            return rows.map((row) => (row.id === stale.id ? stale : row));
          },
        },
      },
    });
    await expect(
      rotateSecretBatch(
        staleReader as unknown as PrismaClient,
        ring,
        admin.orgId,
        {
          key_version: "v3",
          limit: 100,
        },
      ),
    ).rejects.toBeInstanceOf(AutomationConflictError);
    expect(
      await prisma.secret.findUniqueOrThrow({ where: { id: stale.id } }),
    ).toEqual(replacement);
    expect(await prisma.auditLog.count()).toBe(0);
    expect(
      await rotateSecretBatch(prisma, ring, admin.orgId, {
        key_version: "v3",
        limit: 100,
      }),
    ).toEqual({ rotated: 1, next_cursor: null });
    const rotated = await prisma.secret.findUniqueOrThrow({
      where: { id: stale.id },
    });
    expect(decryptSecret(ring, rotated, rotated)).toBe("latest-replacement");
  });

  test("audit failure rolls back re-encryption; retry is safe", async () => {
    const original = await insert("a");
    database.exec(
      "CREATE TRIGGER reject_rotation_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    await expect(
      rotateSecretBatch(prisma, ring, admin.orgId, {
        key_version: "v3",
        limit: 100,
      }),
    ).rejects.toThrow();
    expect(
      await prisma.secret.findUniqueOrThrow({ where: { id: "a" } }),
    ).toEqual(original);
    database.exec("DROP TRIGGER reject_rotation_audit");
    expect(
      await rotateSecretBatch(prisma, ring, admin.orgId, {
        key_version: "v3",
        limit: 100,
      }),
    ).toEqual({ rotated: 1, next_cursor: null });
  });

  test("operator script runs a bounded batch and sanitizes failures", async () => {
    await insert("a");
    const script = fileURLToPath(
      new URL("../../../scripts/rotate-secrets.ts", import.meta.url),
    );
    async function run(extra: string[] = []) {
      const child = Bun.spawn(
        [
          process.execPath,
          script,
          "--org",
          admin.orgId,
          "--key-version",
          "v3",
          "--limit",
          "1",
          ...extra,
        ],
        {
          env: {
            ...process.env,
            DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
            SECRETS_ACTIVE_KEY_VERSION: "v3",
            SECRETS_KEYRING: JSON.stringify(encodedKeys),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exit, stdout, stderr };
    }
    const emptyCursor = await run(["--cursor", ""]);
    expect(emptyCursor.exit).toBe(1);
    const success = await run();
    expect(success.exit).toBe(0);
    expect(JSON.parse(success.stdout)).toEqual({
      status: "ok",
      rotated: 1,
      next_cursor: null,
    });
    expect(success.stderr).toBe("");
    const invalid = await run(["--unexpected", "private-input"]);
    expect(invalid.exit).toBe(1);
    expect(invalid.stderr).not.toContain("private-input");
    expect(invalid.stderr).not.toContain(encodedKeys.v1!);
    expect(invalid.stderr).not.toContain("private-a");
  });
});
