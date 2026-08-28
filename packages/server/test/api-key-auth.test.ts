import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { createOrganizationForUser } from "../src/organizations";
import { closeServices, createServices } from "../src/services";

const migrations = [
  "../prisma/migrations/20260819015000_init/migration.sql",
  "../prisma/migrations/20260828190000_add_api_keys/migration.sql",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));

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
  for (const migration of migrations) services.database?.exec(migration);
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
  organizationId?: string,
) {
  return services.auth.api.createApiKey({
    body: {
      name: "automation",
      userId,
      ...(organizationId ? { metadata: { organizationId } } : {}),
    },
  });
}

function protectedUrl(organizationId: string): string {
  return `http://localhost/v1/orgs/${organizationId}/permissions`;
}

function mcpRequest(token: string): RequestInit {
  return {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "server_info", arguments: {} },
    }),
  };
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

  test("accepts a bearer API key on MCP and scopes it to its bound organization", async () => {
    const { app, organization, services, user } = await createHarness();
    const created = await createKey(services, user.id, organization.id);

    const response = await app.request("/v1/mcp", mcpRequest(created.key));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result?: { structuredContent?: Record<string, unknown> };
    };
    expect(body.result?.structuredContent).toMatchObject({
      orgId: organization.id,
      userId: user.id,
    });
    expect(created.metadata).toEqual({ organizationId: organization.id });
  });

  test("rejects invalid and revoked bearer API keys on MCP", async () => {
    const { app, organization, services, user } = await createHarness();

    const invalid = await app.request(
      "/v1/mcp",
      mcpRequest("not-a-valid-api-key"),
    );
    expect(invalid.status).toBe(401);

    const revokedKey = await createKey(services, user.id, organization.id);
    await services.prisma.apikey.update({
      where: { id: revokedKey.id },
      data: { enabled: false },
    });
    const revoked = await app.request("/v1/mcp", mcpRequest(revokedKey.key));
    expect(revoked.status).toBe(401);
  });
});
