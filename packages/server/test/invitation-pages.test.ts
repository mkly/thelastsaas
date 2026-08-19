import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app";
import type { AuthEmail } from "../src/auth";
import { loadConfig } from "../src/config";
import { roleSubject } from "../src/db/casbin";
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
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-invitation-pages-"));
  const emails: AuthEmail[] = [];
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "3000",
    DATABASE_URL: `file:${join(directory, "test.db")}`,
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
    BETTER_AUTH_URL: "http://localhost:3000",
  });
  const services = await createServices(config, async (email) => {
    emails.push(email);
  });
  if (!services.database) throw new Error("Expected SQLite database handle");
  services.database.exec(migration);
  const app = createApp({ config, services });
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, emails, services };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function signUp(
  app: Harness["app"],
  email: string,
  name: string,
): Promise<{ cookie: string; token: string }> {
  const response = await app.request(
    "http://localhost:3000/api/auth/sign-up/email",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name, password: "invitation-password" }),
    },
  );
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  if (!token || !cookie) throw new Error("Sign-up session was not returned");
  return { cookie, token };
}

function jsonRequest(token: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

describe("browser organization invitations", () => {
  test("returns the recipient through login and accepts with app invariants", async () => {
    const { app, emails, services } = await createHarness();
    const admin = await signUp(app, "admin@example.com", "Ada Admin");
    await signUp(app, "invitee@example.com", "Ivy Invitee");
    const wrongUser = await signUp(app, "wrong@example.com", "Wrong User");

    const createOrg = await app.request(
      "http://localhost:3000/v1/orgs",
      jsonRequest(admin.token, { name: "Origin", slug: "origin" }),
    );
    expect(createOrg.status).toBe(201);
    const orgId = ((await createOrg.json()) as { organization: { id: string } })
      .organization.id;

    const createInvitation = await app.request(
      `http://localhost:3000/v1/orgs/${orgId}/invitations`,
      jsonRequest(admin.token, {
        email: "invitee@example.com",
        role: "member",
      }),
    );
    expect(createInvitation.status).toBe(201);
    const invitationId = (
      (await createInvitation.json()) as { invitation_id: string }
    ).invitation_id;
    const invitationPath = `/auth/invitations/${invitationId}`;
    const invitationEmail = emails.find((email) => email.type === "invitation");
    expect(invitationEmail?.url).toBe(`http://localhost:3000${invitationPath}`);

    const loggedOut = await app.request(
      `http://localhost:3000${invitationPath}`,
    );
    expect(loggedOut.status).toBe(302);
    expect(loggedOut.headers.get("location")).toBe(
      `/auth/login?next=${encodeURIComponent(invitationPath)}`,
    );

    const wrongRecipient = await app.request(
      `http://localhost:3000${invitationPath}`,
      { headers: { cookie: wrongUser.cookie } },
    );
    expect(wrongRecipient.status).toBe(400);
    const wrongRecipientHtml = await wrongRecipient.text();
    expect(wrongRecipientHtml).toContain(
      "invalid, expired, or belongs to another account",
    );
    expect(wrongRecipientHtml).not.toContain("Origin");

    const login = await app.request(
      `http://localhost:3000/auth/login?next=${encodeURIComponent(invitationPath)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          email: "invitee@example.com",
          password: "invitation-password",
        }),
      },
    );
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe(invitationPath);
    const inviteeCookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(inviteeCookie).toBeTruthy();

    const page = await app.request(`http://localhost:3000${invitationPath}`, {
      headers: { cookie: inviteeCookie },
    });
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Origin");
    expect(pageHtml).toContain("admin@example.com");
    expect(pageHtml).toContain("Accept Invitation");

    const accepted = await app.request(
      `http://localhost:3000${invitationPath}`,
      {
        method: "POST",
        headers: {
          cookie: inviteeCookie,
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost:3000",
        },
        body: "",
      },
    );
    expect(accepted.status).toBe(302);
    expect(accepted.headers.get("location")).toBe(
      "/auth/dashboard?message=Invitation+accepted.",
    );

    const invitee = await services.prisma.user.findUniqueOrThrow({
      where: { email: "invitee@example.com" },
    });
    expect(
      await services.prisma.member.findUnique({
        where: {
          organizationId_userId: { organizationId: orgId, userId: invitee.id },
        },
      }),
    ).toMatchObject({ role: "member" });
    expect(
      await services.prisma.casbinRule.findFirst({
        where: {
          orgId,
          ptype: "g",
          v0: invitee.id,
          v1: roleSubject(orgId, "member"),
        },
      }),
    ).not.toBeNull();
    expect(
      await services.prisma.auditLog.findFirst({
        where: {
          orgId,
          userId: invitee.id,
          action: "accept_invitation",
          resourceId: invitationId,
        },
      }),
    ).not.toBeNull();
  });
});
