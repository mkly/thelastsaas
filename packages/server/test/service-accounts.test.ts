import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
} from "../src/db/notification-preferences";
import {
  createServiceAccount,
  serviceAccountPlaceholderEmail,
} from "../src/db/service-accounts";
import { closeServices, createServices } from "../src/services";
import { testMigrationSql } from "./test-migrations";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-service-accounts-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
    BETTER_AUTH_URL: "https://app.example.com",
  });
  const services = await createServices(config);
  services.database?.exec(testMigrationSql);
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });

  const organization = await services.prisma.organization.create({
    data: { id: "org_service", name: "Service Org", slug: "service-org" },
  });
  return { config, organization, services };
}

describe("service accounts", () => {
  test("generates a placeholder email and creates membership without credentials", async () => {
    const { config, organization, services } = await createHarness();

    const created = await createServiceAccount(
      services.prisma,
      config.betterAuthUrl,
      organization.id,
      { name: "Release Bot", role: "member" },
    );

    expect(created.user).toMatchObject({
      kind: "service",
      name: "Release Bot",
      email: "release-bot@service.app.example.com",
      emailVerified: false,
    });
    expect(created.member).toMatchObject({
      organizationId: organization.id,
      userId: created.user.id,
      role: "member",
    });
    expect(
      await services.prisma.account.count({
        where: { userId: created.user.id },
      }),
    ).toBe(0);
    expect(
      await services.prisma.casbinRule.findFirst({
        where: {
          orgId: organization.id,
          ptype: "g",
          v0: created.user.id,
          v1: `org:${organization.id}:user:member`,
        },
      }),
    ).not.toBeNull();
  });

  test("accepts a real email and defaults email notifications off", async () => {
    const { config, organization, services } = await createHarness();
    const { user } = await createServiceAccount(
      services.prisma,
      config.betterAuthUrl,
      organization.id,
      { name: "Inbox Bot", email: "inbox-bot@example.com" },
    );

    expect(user.email).toBe("inbox-bot@example.com");
    expect(user.emailVerified).toBe(true);
    expect(await getNotificationPreferences(services.prisma, user.id)).toEqual({
      default: { in_app: true, email: false },
      by_kind: {},
    });
    expect(
      await updateNotificationPreferences(services.prisma, user.id, {
        default: { email: true },
      }),
    ).toEqual({
      default: { in_app: true, email: true },
      by_kind: {},
    });
  });

  test("rejects interactive sign-in after an existing user becomes a service account", async () => {
    const { services } = await createHarness();
    await services.auth.api.signUpEmail({
      body: {
        name: "Converted Bot",
        email: "converted-bot@example.com",
        password: "converted-bot-password",
      },
    });
    await services.prisma.user.update({
      where: { email: "converted-bot@example.com" },
      data: { kind: "service", emailVerified: true },
    });

    await expect(
      services.auth.api.signInEmail({
        body: {
          email: "converted-bot@example.com",
          password: "converted-bot-password",
        },
      }),
    ).rejects.toThrow();
    expect(
      await services.prisma.session.count({
        where: {
          user: { email: "converted-bot@example.com" },
        },
      }),
    ).toBe(0);
  });

  test("builds placeholder addresses from an explicit slug and app domain", () => {
    expect(
      serviceAccountPlaceholderEmail(
        "deploy-agent",
        "https://console.example.com:8443/path",
      ),
    ).toBe("deploy-agent@service.console.example.com");
  });
});
