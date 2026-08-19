import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { closeServices, createServices } from "../src/services";

const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260819015000_init/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-organizations-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
  });
  const services = await createServices(config);
  services.database?.exec(migration);
  const app = createApp({ config, services });
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });

  await app.request("http://localhost/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      name: "Organization User",
      email: "org-user@example.com",
      password: "organization-password",
    }),
  });
  const login = await app.request("http://localhost/auth/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      email: "org-user@example.com",
      password: "organization-password",
    }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Expected login cookie");
  const user = await services.prisma.user.findUnique({
    where: { email: "org-user@example.com" },
  });
  if (!user) throw new Error("Expected signed-up user");
  await services.prisma.session.create({
    data: {
      id: "session_cli_orgs",
      userId: user.id,
      token: "cli-orgs-token",
      expiresAt: new Date(Date.now() + 60_000),
      userAgent: "lastsaas-cli",
    },
  });
  return {
    app,
    services,
    headers: { Cookie: cookie },
    cliHeaders: { Authorization: "Bearer lst_cli-orgs-token" },
  };
}

describe("organization routes", () => {
  test("signup does not create an organization", async () => {
    const { app, services, headers } = await createHarness();

    const response = await app.request("http://localhost/v1/orgs", { headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      organizations: [],
    });
    expect(await services.prisma.organization.count()).toBe(0);
  });

  test("creates, lists, and bootstraps an explicitly requested organization", async () => {
    const { app, services, cliHeaders } = await createHarness();

    const created = await app.request("http://localhost/v1/orgs", {
      method: "POST",
      headers: { ...cliHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme Tools" }),
    });

    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      organization: { id: string; name: string; slug: string; role: string };
    };
    expect(body.organization).toMatchObject({
      name: "Acme Tools",
      slug: "acme-tools",
      role: "admin",
    });

    const listed = await app.request("http://localhost/v1/orgs", {
      headers: cliHeaders,
    });
    expect(await listed.json()).toMatchObject({
      status: "ok",
      organizations: [
        {
          id: body.organization.id,
          name: "Acme Tools",
          slug: "acme-tools",
          role: "admin",
        },
      ],
    });
    expect(
      await services.prisma.casbinRule.count({
        where: { orgId: body.organization.id },
      }),
    ).toBe(2);
    expect(
      await services.prisma.auditLog.count({
        where: {
          orgId: body.organization.id,
          action: "create_organization",
        },
      }),
    ).toBe(1);

    const duplicate = await app.request("http://localhost/v1/orgs", {
      method: "POST",
      headers: { ...cliHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "Another Acme", slug: "acme-tools" }),
    });
    expect(duplicate.status).toBe(409);
  });

  test("requires authentication", async () => {
    const { app } = await createHarness();
    const response = await app.request("http://localhost/v1/orgs");
    expect(response.status).toBe(401);
  });
});
