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
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-collection-auth-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "3000",
    DATABASE_URL: `file:${join(directory, "test.db")}`,
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
    BETTER_AUTH_URL: "http://localhost:3000",
  });
  const services = await createServices(config);
  if (!services.database) throw new Error("Expected SQLite database handle");
  services.database.exec(migration);
  const app = createApp({ config, services });
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });
  return { app, services };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function signUp(app: Harness["app"], email: string, name: string) {
  const response = await app.request(
    "http://localhost:3000/api/auth/sign-up/email",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name, password: "collection-password" }),
    },
  );
  expect(response.status).toBe(200);
  const token = response.headers.get("set-auth-token");
  if (!token) throw new Error("Sign-up session token was not returned");
  return token;
}

function jsonRequest(
  token: string,
  body: unknown,
  method = "POST",
): RequestInit {
  return {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function inviteAndAccept(
  app: Harness["app"],
  orgId: string,
  adminToken: string,
  memberToken: string,
  email: string,
) {
  const invitationResponse = await app.request(
    `http://localhost:3000/v1/orgs/${orgId}/invitations`,
    jsonRequest(adminToken, { email, role: "member" }),
  );
  expect(invitationResponse.status).toBe(201);
  const invitationId = (
    (await invitationResponse.json()) as { invitation_id: string }
  ).invitation_id;
  const acceptance = await app.request(
    `http://localhost:3000/v1/orgs/${orgId}/invitations/accept`,
    jsonRequest(memberToken, { invitation_id: invitationId }),
  );
  expect(acceptance.status).toBe(200);
}

describe("private collection authorization", () => {
  test("separates membership, delegated creation, creator access, and admin deletion", async () => {
    const { app, services } = await createHarness();
    const adminToken = await signUp(app, "mike@example.com", "Mike Admin");
    const creatorToken = await signUp(
      app,
      "creator@example.com",
      "Casey Creator",
    );
    const memberToken = await signUp(app, "tom@example.com", "Tom Member");

    const organizationResponse = await app.request(
      "http://localhost:3000/v1/orgs",
      jsonRequest(adminToken, { name: "Origin", slug: "origin" }),
    );
    expect(organizationResponse.status).toBe(201);
    const orgId = (
      (await organizationResponse.json()) as {
        organization: { id: string };
      }
    ).organization.id;
    const collectionsUrl = `http://localhost:3000/v1/orgs/${orgId}/collections`;

    expect(
      (
        await app.request(
          collectionsUrl,
          jsonRequest(adminToken, {
            name: "events",
            schema: { title: "string" },
          }),
        )
      ).status,
    ).toBe(200);

    await inviteAndAccept(
      app,
      orgId,
      adminToken,
      creatorToken,
      "creator@example.com",
    );
    await inviteAndAccept(
      app,
      orgId,
      adminToken,
      memberToken,
      "tom@example.com",
    );

    for (const token of [creatorToken, memberToken]) {
      const list = await app.request(collectionsUrl, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({ status: "ok", collections: [] });
      expect(
        (
          await app.request(`${collectionsUrl}/events`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await app.request(
            `${collectionsUrl}/events/records/query`,
            jsonRequest(token, {}),
          )
        ).status,
      ).toBe(403);
    }

    expect(
      (
        await app.request(
          collectionsUrl,
          jsonRequest(memberToken, {
            name: "forbidden",
            schema: { title: "string" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(
          `http://localhost:3000/v1/orgs/${orgId}/invitations`,
          jsonRequest(memberToken, {
            email: "blocked@example.com",
            role: "member",
          }),
        )
      ).status,
    ).toBe(403);

    const creator = await services.prisma.user.findUniqueOrThrow({
      where: { email: "creator@example.com" },
    });
    const permissionBase = `http://localhost:3000/v1/orgs/${orgId}/permissions`;
    expect(
      (
        await app.request(
          `${permissionBase}/policies`,
          jsonRequest(adminToken, {
            subject: "role:collection_creator",
            resource: "/collections",
            action: "write",
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request(
          `${permissionBase}/roles`,
          jsonRequest(adminToken, {
            user_id: creator.id,
            role: "collection_creator",
          }),
        )
      ).status,
    ).toBe(201);

    const createNotes = await app.request(
      collectionsUrl,
      jsonRequest(creatorToken, {
        name: "notes",
        schema: { title: "string" },
      }),
    );
    expect(createNotes.status).toBe(200);

    const creatorList = await app.request(collectionsUrl, {
      headers: { authorization: `Bearer ${creatorToken}` },
    });
    expect(creatorList.status).toBe(200);
    expect(
      (
        (await creatorList.json()) as { collections: Array<{ name: string }> }
      ).collections.map(({ name }) => name),
    ).toEqual(["notes"]);

    expect(
      (
        await app.request(
          `${collectionsUrl}/notes/schema`,
          jsonRequest(creatorToken, { add_fields: { body: "text" } }, "PATCH"),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `${collectionsUrl}/notes/records`,
          jsonRequest(creatorToken, {
            data: { title: "Private draft", body: "Creator can write" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`${collectionsUrl}/notes?confirm=true`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${creatorToken}` },
        })
      ).status,
    ).toBe(403);

    for (const path of ["stats", "audit-log", "files"]) {
      expect(
        (
          await app.request(`http://localhost:3000/v1/orgs/${orgId}/${path}`, {
            headers: { authorization: `Bearer ${creatorToken}` },
          })
        ).status,
      ).toBe(403);
    }

    expect(
      await services.prisma.casbinRule.findFirst({
        where: {
          orgId,
          ptype: "p",
          v0: `org:${orgId}:user:member`,
          v1: "/*",
          v2: "read",
        },
      }),
    ).toBeNull();
    expect(
      await services.prisma.casbinRule.findMany({
        where: {
          orgId,
          ptype: "p",
          v0: creator.id,
          v1: "/collections/notes",
        },
        orderBy: { v2: "asc" },
        select: { v2: true },
      }),
    ).toEqual([{ v2: "manage" }, { v2: "read" }, { v2: "write" }]);

    expect(
      (
        await app.request(`${collectionsUrl}/notes?confirm=true`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${adminToken}` },
        })
      ).status,
    ).toBe(200);
    expect(
      await services.prisma.casbinRule.count({
        where: { orgId, ptype: "p", v1: "/collections/notes" },
      }),
    ).toBe(0);
  });
});
