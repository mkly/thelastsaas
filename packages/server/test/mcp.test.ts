import { API_VERSION } from "@lastsaas/shared";
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
const protocolVersion = "2025-11-25";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createHarness() {
  const directory = mkdtempSync(join(tmpdir(), "lastsaas-mcp-"));
  const config = loadConfig({
    NODE_ENV: "test",
    PORT: "0",
    DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
  });
  const services = await createServices(config);
  if (!services.database) throw new Error("Expected SQLite database handle");
  services.database.exec(migration);
  const app = createApp({ config, services });
  cleanups.push(async () => {
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });

  const signUp = async (email: string, name: string) => {
    const response = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name, password: "mcp-test-password" }),
    });
    expect(response.status).toBe(200);
    const token = response.headers.get("set-auth-token");
    if (!token) throw new Error("Sign-up did not return a bearer token");
    return token;
  };

  const memberToken = await signUp("member@example.com", "MCP Member");
  const organizationResponse = await app.request("/v1/orgs", {
    method: "POST",
    headers: {
      authorization: `Bearer ${memberToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: "MCP Org", slug: "mcp-org" }),
  });
  expect(organizationResponse.status).toBe(201);
  const organizationBody = (await organizationResponse.json()) as {
    organization: { id: string };
  };
  const member = await services.prisma.user.findUnique({
    where: { email: "member@example.com" },
  });
  if (!member) throw new Error("Expected MCP member user");

  return {
    app,
    memberToken,
    memberId: member.id,
    orgId: organizationBody.organization.id,
    nonMemberToken: await signUp("outsider@example.com", "MCP Outsider"),
  };
}

function mcpRequest(token: string, id: number, method: string, params = {}) {
  return {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  };
}

describe("MCP endpoint", () => {
  test("initializes, lists tools, and calls server_info for an org member", async () => {
    const { app, memberToken, memberId, orgId } = await createHarness();
    const endpoint = `/v1/orgs/${orgId}/mcp`;

    const initialized = await app.request(
      endpoint,
      mcpRequest(memberToken, 1, "initialize", {
        protocolVersion,
        capabilities: {},
        clientInfo: { name: "lastsaas-test", version: "1.0.0" },
      }),
    );
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion,
        serverInfo: { name: "lastsaas", version: API_VERSION },
      },
    });

    const listed = await app.request(
      endpoint,
      mcpRequest(memberToken, 2, "tools/list"),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "server_info" }] },
    });

    const called = await app.request(
      endpoint,
      mcpRequest(memberToken, 3, "tools/call", {
        name: "server_info",
        arguments: {},
      }),
    );
    expect(called.status).toBe(200);
    expect(await called.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: {
        structuredContent: {
          apiVersion: API_VERSION,
          orgId,
          userId: memberId,
        },
      },
    });
  });

  test("uses the existing auth middleware for missing and non-member sessions", async () => {
    const { app, memberToken, nonMemberToken, orgId } = await createHarness();
    const endpoint = `/v1/orgs/${orgId}/mcp`;
    const request = mcpRequest(memberToken, 1, "tools/list");

    const unauthorized = await app.request(endpoint, {
      ...request,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
    });
    expect(unauthorized.status).toBe(401);

    const forbidden = await app.request(
      endpoint,
      mcpRequest(nonMemberToken, 2, "tools/list"),
    );
    expect(forbidden.status).toBe(403);
  });
});
