import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AutomationUnavailableError,
  PermissionDeniedError,
  type ExportData,
  type SecretKeyring,
} from "@lastsaas/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { loadConfig, type AppConfig } from "../src/config";
import { addPolicy } from "../src/db/casbin";
import { exportData, importData } from "../src/db/export-import";
import { registerOperationsTools } from "../src/mcp/tools/operations";
import { decryptSecret } from "../src/secrets/crypto";
import { createSecretService } from "../src/secrets/service";
import {
  closeServices,
  createServices,
  type AppServices,
} from "../src/services";
import { testMigrationSql } from "./test-migrations";

const values = ["backup-private-alpha", "backup-private-beta"];
const source = {
  orgId: "source",
  userId: "owner",
  userEmail: "owner@example.com",
};
const destination = { ...source, orgId: "destination" };
const keys = new Map([
  ["v1", Buffer.alloc(32, 17)],
  ["v2", Buffer.alloc(32, 29)],
  ["v3", Buffer.alloc(32, 42)],
]);
const ring: SecretKeyring = { activeVersion: "v2", keys };
const restoreRing: SecretKeyring = { activeVersion: "v3", keys };

describe("explicit encrypted organization backups", () => {
  let directory: string;
  let config: AppConfig;
  let services: AppServices;
  const connections: Array<{ client: Client; server: McpServer }> = [];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "lastsaas-secret-backup-"));
    config = loadConfig({
      NODE_ENV: "test",
      PORT: "0",
      DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
    });
    config.secretKeyring = ring;
    services = await createServices(config);
    services.database!.exec(testMigrationSql);
    await services.prisma.organization.createMany({
      data: [
        { id: "source", name: "Source", slug: "source" },
        { id: "destination", name: "Destination", slug: "destination" },
      ],
    });
    for (const id of ["owner", "reader"]) {
      await services.prisma.user.create({
        data: { id, name: id, email: `${id}@example.com` },
      });
      for (const orgId of ["source", "destination"])
        await services.prisma.member.create({
          data: { id: `${orgId}_${id}`, userId: id, organizationId: orgId },
        });
    }
    await addPolicy(services.prisma, "source", "owner", "/*", "*");
    await addPolicy(services.prisma, "destination", "owner", "/*", "*");
    await createSecretService(services.prisma, {
      ...ring,
      activeVersion: "v1",
    }).create(source, { name: "alpha", value: values[0]! });
    await createSecretService(services.prisma, ring).create(source, {
      name: "beta",
      value: values[1]!,
    });
    services.auth = {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const id = headers.get("x-test-user");
          return id
            ? { session: { id: `session_${id}` }, user: { id, name: id } }
            : null;
        },
      },
    } as unknown as AppServices["auth"];
  });

  afterEach(async () => {
    for (const { client, server } of connections.splice(0))
      await Promise.allSettled([client.close(), server.close()]);
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });

  async function backup() {
    return exportData(services.prisma, "source", {
      includeEncryptedSecrets: true,
      keyring: ring,
    });
  }

  test("ordinary exports omit secrets; remapped backups authenticate and rotate to the destination key without granting reveal", async () => {
    const ordinary = await exportData(services.prisma, "source");
    expect(ordinary).not.toHaveProperty("encrypted_secrets");
    const dump = await backup();
    const encoded = JSON.stringify(dump);
    for (const value of values) expect(encoded).not.toContain(value);
    expect(dump.encrypted_secrets!.map((secret) => secret.key_version)).toEqual(
      ["v1", "v2"],
    );
    expect(
      await importData(services.prisma, "destination", dump, {
        keyring: restoreRing,
      }),
    ).toMatchObject({ imported_secrets: 2 });
    const restored = await services.prisma.secret.findMany({
      where: { orgId: "destination" },
      orderBy: { name: "asc" },
    });
    for (const [index, row] of restored.entries()) {
      expect(row.id).not.toBe(dump.encrypted_secrets![index]!.id);
      expect(row.keyVersion).toBe("v3");
      expect(row.ciphertext).not.toBe(
        dump.encrypted_secrets![index]!.ciphertext,
      );
      expect(row.nonce).not.toBe(dump.encrypted_secrets![index]!.nonce);
      expect(decryptSecret(restoreRing, row, row)).toBe(values[index]!);
    }
    const service = createSecretService(services.prisma, restoreRing);
    const reader = {
      ...destination,
      userId: "reader",
      userEmail: "reader@example.com",
    };
    await addPolicy(
      services.prisma,
      "destination",
      "reader",
      "/secrets/alpha",
      "read",
    );
    expect(await service.show(reader, "alpha")).not.toHaveProperty("value");
    await expect(service.reveal(reader, "alpha")).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await addPolicy(
      services.prisma,
      "destination",
      "reader",
      "/secrets/alpha/value",
      "read",
    );
    expect((await service.reveal(reader, "alpha")).value).toBe(values[0]!);
    expect((await service.reveal(destination, "beta")).value).toBe(values[1]!);
    expect(
      JSON.stringify(await services.prisma.auditLog.findMany()),
    ).not.toContain(values[0]!);
  });

  test("missing, incomplete and wrong keys reject backup or restore and roll back earlier restored secrets", async () => {
    const dump = await backup();
    const incomplete = {
      activeVersion: "v1",
      keys: new Map([["v1", keys.get("v1")!]]),
    };
    const wrong = {
      ...ring,
      keys: new Map(keys).set("v2", Buffer.alloc(32, 99)),
    };
    for (const keyring of [null, incomplete, wrong]) {
      await expect(
        exportData(services.prisma, "source", {
          includeEncryptedSecrets: true,
          keyring,
        }),
      ).rejects.toBeInstanceOf(AutomationUnavailableError);
      await expect(
        importData(services.prisma, "destination", dump, { keyring }),
      ).rejects.toBeInstanceOf(AutomationUnavailableError);
      expect(
        await services.prisma.secret.count({ where: { orgId: "destination" } }),
      ).toBe(0);
    }
    // Explicit keys are unnecessary for legacy/default data.
    expect(
      await importData(
        services.prisma,
        "destination",
        await exportData(services.prisma, "source"),
      ),
    ).not.toHaveProperty("imported_secrets");
  });

  test("tampered authenticated identities, ciphertext and tags, duplicate names and existing secrets reject the whole import", async () => {
    const dump = await backup();
    for (const patch of [
      { organization_id: "tampered" },
      { id: "tampered" },
      { key_version: "v3" },
      { auth_tag: Buffer.alloc(16).toString("base64") },
      { ciphertext: "not-base64" },
      { name: "alpha" },
      { value: "unexpected-plaintext" },
    ]) {
      const broken = structuredClone(dump);
      Object.assign(broken.encrypted_secrets![1]!, patch);
      await expect(
        importData(services.prisma, "destination", broken, {
          keyring: restoreRing,
        }),
      ).rejects.toThrow();
      expect(
        await services.prisma.secret.count({ where: { orgId: "destination" } }),
      ).toBe(0);
    }
    await createSecretService(services.prisma, restoreRing).create(
      destination,
      { name: "beta", value: "existing" },
    );
    await expect(
      importData(services.prisma, "destination", dump, {
        keyring: restoreRing,
      }),
    ).rejects.toThrow("Secret name already exists");
    expect(
      await services.prisma.secret.count({ where: { orgId: "destination" } }),
    ).toBe(1);
    expect(
      (
        await createSecretService(services.prisma, restoreRing).reveal(
          destination,
          "beta",
        )
      ).value,
    ).toBe("existing");
  });

  test("REST and MCP wire the explicit export flag and configured restore keys, preserve manage gates, and redact malformed imports", async () => {
    const app = createApp({ config, services });
    const headers = {
      "x-test-user": "owner",
      "content-type": "application/json",
    };
    const ordinary = await app.request("/v1/orgs/source/export", {
      method: "POST",
      headers,
    });
    expect(ordinary.headers.get("cache-control")).toBe("no-store");
    expect(await ordinary.json()).not.toHaveProperty("encrypted_secrets");
    const exported = await app.request(
      "/v1/orgs/source/export?include_encrypted_secrets=true",
      { method: "POST", headers },
    );
    expect(exported.status).toBe(200);
    const dump = (await exported.json()) as ExportData;
    expect(dump.encrypted_secrets).toHaveLength(2);
    const denied = await app.request(
      "/v1/orgs/source/export?include_encrypted_secrets=true",
      { method: "POST", headers: { "x-test-user": "reader" } },
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(
      (
        await app.request(
          "/v1/orgs/source/export?include_encrypted_secrets=yes",
          { method: "POST", headers },
        )
      ).status,
    ).toBe(400);
    const imported = await app.request("/v1/orgs/destination/import", {
      method: "POST",
      headers,
      body: JSON.stringify(dump),
    });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({ imported_secrets: 2 });
    expect(
      (
        await createSecretService(services.prisma, ring).reveal(
          destination,
          "alpha",
        )
      ).value,
    ).toBe(values[0]!);

    const server = new McpServer({ name: "backup-test", version: "1.0.0" });
    registerOperationsTools(server, {
      config,
      services,
      userId: "owner",
      orgId: "source",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "backup-client", version: "1.0.0" });
    await client.connect(ct);
    connections.push({ client, server });
    expect(
      (await client.callTool({ name: "org_export", arguments: {} }))
        .structuredContent,
    ).not.toHaveProperty("encrypted_secrets");
    expect(
      (
        await client.callTool({
          name: "org_export",
          arguments: { include_encrypted_secrets: true },
        })
      ).structuredContent,
    ).toHaveProperty("encrypted_secrets");
    // Remove source data so an MCP restore can preserve IDs as well as round-trip AAD.
    await services.prisma.secret.deleteMany({ where: { orgId: "source" } });
    const restored = await client.callTool({
      name: "org_import",
      arguments: { data: dump, confirm: true },
    });
    expect(restored.isError).not.toBe(true);
    expect(restored.structuredContent).toMatchObject({ imported_secrets: 2 });
    expect(
      (await createSecretService(services.prisma, ring).reveal(source, "beta"))
        .value,
    ).toBe(values[1]!);
    const malformed = {
      ...dump,
      encrypted_secrets: [
        { ...dump.encrypted_secrets![0], [values[0]!]: true },
      ],
    };
    const badRest = await app.request("/v1/orgs/destination/import", {
      method: "POST",
      headers,
      body: JSON.stringify(malformed),
    });
    expect(badRest.status).toBe(400);
    expect(await badRest.text()).not.toContain(values[0]!);
    const badMcp = await client.callTool({
      name: "org_import",
      arguments: { data: malformed, confirm: true },
    });
    expect(badMcp.isError).toBe(true);
    expect(JSON.stringify(badMcp)).not.toContain(values[0]!);
  });
});
