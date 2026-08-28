import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createOrganizationForUser } from "../src/organizations";
import { closeServices, createServices } from "../src/services";
import { testMigrationSql } from "./test-migrations";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-api-key-auth-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
  });
  const services = await createServices(config);
  services.database?.exec(testMigrationSql);
  const app = createApp({ config, services });
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });

  const user = await services.prisma.user.create({
    data: {
      id: "api_key_user",
      email: "api-key-user@example.com",
      emailVerified: true,
      name: "API Key User",
    },
  });
  const organization = await createOrganizationForUser(services, user.id, {
    name: "API Key Organization",
    slug: "api-key-organization",
  });

  return { app, organization, services, user };
}

async function createKey(
  services: Awaited<ReturnType<typeof createHarness>>["services"],
  userId: string,
) {
  return services.auth.api.createApiKey({
    body: { name: "automation", userId },
  });
}

function protectedUrl(organizationId: string): string {
  return `http://localhost/v1/orgs/${organizationId}/permissions`;
}

describe("API key authentication", () => {
  test("authenticates the owning user and passes organization permissions", async () => {
    const { app, organization, services, user } = await createHarness();
    const created = await createKey(services, user.id);

    const response = await app.request(protectedUrl(organization.id), {
      headers: { "x-api-key": created.key },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });

    const stored = await services.prisma.apikey.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.referenceId).toBe(user.id);
    expect(stored.key).not.toBe(created.key);
    expect(stored.key).not.toContain(created.key);
  });

  test("rejects invalid, revoked, and expired keys", async () => {
    const { app, organization, services, user } = await createHarness();
    const url = protectedUrl(organization.id);

    const invalid = await app.request(url, {
      headers: { "x-api-key": "not-a-valid-api-key" },
    });
    expect(invalid.status).toBe(401);

    const revokedKey = await createKey(services, user.id);
    await services.prisma.apikey.update({
      where: { id: revokedKey.id },
      data: { enabled: false },
    });
    const revoked = await app.request(url, {
      headers: { "x-api-key": revokedKey.key },
    });
    expect(revoked.status).toBe(401);

    const expiredKey = await createKey(services, user.id);
    await services.prisma.apikey.update({
      where: { id: expiredKey.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expired = await app.request(url, {
      headers: { "x-api-key": expiredKey.key },
    });
    expect(expired.status).toBe(401);
  });
});
