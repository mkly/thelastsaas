import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { roleSubject } from "../src/db/casbin";
import {
  issueServiceAccountTokenClaim,
  SERVICE_ACCOUNT_CLAIM_TTL_MS,
} from "../src/service-account-tokens";
import { closeServices, createServices } from "../src/services";
import { testMigrationSql } from "./test-migrations";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-token-claims-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
    BETTER_AUTH_URL: "http://localhost:3000",
  });
  const services = await createServices(config);
  services.database?.exec(testMigrationSql);
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });

  await services.prisma.user.createMany({
    data: [
      {
        id: "claim_admin",
        email: "claim-admin@example.com",
        emailVerified: true,
        name: "Claim Admin",
      },
      {
        id: "claim_member",
        email: "claim-member@example.com",
        emailVerified: true,
        name: "Claim Member",
      },
    ],
  });
  await services.prisma.organization.create({
    data: { id: "org_claim", name: "Claim Org", slug: "claim-org" },
  });
  await services.prisma.member.createMany({
    data: [
      {
        id: "claim_admin_member",
        organizationId: "org_claim",
        userId: "claim_admin",
        role: "admin",
      },
      {
        id: "claim_regular_member",
        organizationId: "org_claim",
        userId: "claim_member",
        role: "member",
      },
    ],
  });
  await services.prisma.casbinRule.createMany({
    data: [
      {
        orgId: "org_claim",
        ptype: "p",
        v0: roleSubject("org_claim", "admin"),
        v1: "/*",
        v2: "*",
      },
      {
        orgId: "org_claim",
        ptype: "g",
        v0: "claim_admin",
        v1: roleSubject("org_claim", "admin"),
      },
      {
        orgId: "org_claim",
        ptype: "g",
        v0: "claim_member",
        v1: roleSubject("org_claim", "member"),
      },
    ],
  });
  await services.prisma.session.createMany({
    data: [
      {
        id: "claim_admin_session",
        userId: "claim_admin",
        token: "claim-admin-token",
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        id: "claim_member_session",
        userId: "claim_member",
        token: "claim-member-token",
        expiresAt: new Date(Date.now() + 60_000),
      },
    ],
  });

  return { app: createApp({ config, services }), config, services };
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

function tokenFromHtml(html: string): string {
  const token = html.match(/<code>([^<]+)<\/code>/)?.[1];
  if (!token) throw new Error("Expected a token in the claim page");
  return token;
}

function mcpRequest(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): RequestInit {
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
      params: { name, arguments: args },
    }),
  };
}

describe("service-account token claims", () => {
  test("sends unauthenticated claimants through login with a return path", async () => {
    const { app } = await createHarness();
    const response = await app.request(
      "http://localhost/tokens/claim/unclaimed-code",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/auth/login?next=%2Ftokens%2Fclaim%2Funclaimed-code",
    );
  });

  test("admin creation returns only a one-time claim URL", async () => {
    const { app, services } = await createHarness();
    const created = await app.request(
      "http://localhost/v1/orgs/org_claim/service-accounts",
      {
        method: "POST",
        headers: {
          ...bearer("claim-admin-token"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Deploy Bot", role: "member" }),
      },
    );

    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "ok", role: "member" });
    expect(body.token).toBeUndefined();
    expect(body.key).toBeUndefined();
    expect(body.claim_url).toStartWith("http://localhost:3000/tokens/claim/");

    const storedKey = await services.prisma.apikey.findFirstOrThrow({
      where: { referenceId: String(body.service_account_id) },
    });
    expect(JSON.parse(storedKey.metadata!)).toEqual({
      organizationId: "org_claim",
    });

    const claimed = await app.request(String(body.claim_url), {
      headers: bearer("claim-admin-token"),
    });
    expect(claimed.status).toBe(200);
    expect(claimed.headers.get("cache-control")).toContain("no-store");
    const rawToken = tokenFromHtml(await claimed.text());
    expect(storedKey.key).not.toBe(rawToken);

    const authenticated = await app.request(
      "http://localhost/v1/orgs/org_claim/members",
      { headers: { "x-api-key": rawToken } },
    );
    expect(authenticated.status).toBe(200);

    const claimedAgain = await app.request(String(body.claim_url), {
      headers: bearer("claim-admin-token"),
    });
    expect(claimedAgain.status).toBe(404);
  });

  test("lists, rotates, and revokes service-account keys across REST and MCP", async () => {
    const { app } = await createHarness();
    const created = await app.request(
      "http://localhost/v1/orgs/org_claim/service-accounts",
      {
        method: "POST",
        headers: {
          ...bearer("claim-admin-token"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Lifecycle Bot", role: "member" }),
      },
    );
    expect(created.status).toBe(201);
    const account = (await created.json()) as {
      service_account_id: string;
      api_key_id?: string;
      claim_url: string;
    };
    const initialClaim = await app.request(account.claim_url, {
      headers: bearer("claim-admin-token"),
    });
    const initialToken = tokenFromHtml(await initialClaim.text());

    const members = await app.request(
      "http://localhost/v1/orgs/org_claim/members",
      { headers: { "x-api-key": initialToken } },
    );
    expect(members.status).toBe(200);
    expect(await members.json()).toMatchObject({
      members: expect.arrayContaining([
        expect.objectContaining({
          user_id: account.service_account_id,
          kind: "service",
          member_role: "member",
        }),
      ]),
    });

    const listUrl = `http://localhost/v1/orgs/org_claim/service-accounts/${account.service_account_id}/api-keys`;
    const listed = await app.request(listUrl, {
      headers: bearer("claim-admin-token"),
    });
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      api_keys: Array<Record<string, unknown>>;
    };
    expect(listBody.api_keys).toHaveLength(1);
    expect(listBody.api_keys[0]).toMatchObject({ enabled: true });
    expect(listBody.api_keys[0]).not.toHaveProperty("key");
    expect(listBody.api_keys[0]).not.toHaveProperty("token");
    const initialKeyId = String(listBody.api_keys[0]!.id);

    const initialMcp = await app.request(
      "/v1/mcp",
      mcpRequest(initialToken, "members_list"),
    );
    expect(initialMcp.status).toBe(200);
    const forbiddenMcp = await app.request(
      "/v1/mcp",
      mcpRequest(initialToken, "members_remove", {
        member_id: "claim_regular_member",
      }),
    );
    expect(forbiddenMcp.status).toBe(200);
    expect(await forbiddenMcp.json()).toMatchObject({
      result: { isError: true },
    });

    const rotated = await app.request(`${listUrl}/${initialKeyId}/rotate`, {
      method: "POST",
      headers: bearer("claim-admin-token"),
    });
    expect(rotated.status).toBe(200);
    const rotation = (await rotated.json()) as {
      api_key_id: string;
      claim_url: string;
    };
    expect(rotation.api_key_id).not.toBe(initialKeyId);
    expect(
      await app.request("http://localhost/v1/orgs/org_claim/members", {
        headers: { "x-api-key": initialToken },
      }),
    ).toHaveProperty("status", 401);
    expect(
      await app.request("/v1/mcp", mcpRequest(initialToken, "members_list")),
    ).toHaveProperty("status", 401);

    const replacementClaim = await app.request(rotation.claim_url, {
      headers: bearer("claim-admin-token"),
    });
    const replacementToken = tokenFromHtml(await replacementClaim.text());
    expect(
      await app.request("http://localhost/v1/orgs/org_claim/members", {
        headers: { "x-api-key": replacementToken },
      }),
    ).toHaveProperty("status", 200);
    expect(
      await app.request(
        "/v1/mcp",
        mcpRequest(replacementToken, "members_list"),
      ),
    ).toHaveProperty("status", 200);

    const revoked = await app.request(`${listUrl}/${rotation.api_key_id}`, {
      method: "DELETE",
      headers: bearer("claim-admin-token"),
    });
    expect(revoked.status).toBe(200);
    expect(
      await app.request("http://localhost/v1/orgs/org_claim/members", {
        headers: { "x-api-key": replacementToken },
      }),
    ).toHaveProperty("status", 401);
    expect(
      await app.request(
        "/v1/mcp",
        mcpRequest(replacementToken, "members_list"),
      ),
    ).toHaveProperty("status", 401);
  });

  test("rejects non-admin create and claim attempts without consuming the claim", async () => {
    const { app, config, services } = await createHarness();
    const rejectedCreate = await app.request(
      "http://localhost/v1/orgs/org_claim/service-accounts",
      {
        method: "POST",
        headers: {
          ...bearer("claim-member-token"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Forbidden Bot" }),
      },
    );
    expect(rejectedCreate.status).toBe(403);

    const issued = await issueServiceAccountTokenClaim(
      services,
      config,
      "org_claim",
      { name: "Protected Bot" },
    );
    const rejectedClaim = await app.request(issued.claimUrl, {
      headers: bearer("claim-member-token"),
    });
    expect(rejectedClaim.status).toBe(403);

    const adminClaim = await app.request(issued.claimUrl, {
      headers: bearer("claim-admin-token"),
    });
    expect(adminClaim.status).toBe(200);
  });

  test("expires a claim and disables its unclaimed key", async () => {
    const { app, config, services } = await createHarness();
    const issued = await issueServiceAccountTokenClaim(
      services,
      config,
      "org_claim",
      { name: "Expired Bot" },
      new Date(Date.now() - SERVICE_ACCOUNT_CLAIM_TTL_MS - 1_000),
    );

    const expired = await app.request(issued.claimUrl, {
      headers: bearer("claim-admin-token"),
    });
    expect(expired.status).toBe(410);
    expect(
      await services.prisma.apikey.findUniqueOrThrow({
        where: { id: issued.apiKeyId },
        select: { enabled: true },
      }),
    ).toEqual({ enabled: false });
  });
});
