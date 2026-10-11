import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { SecretMetadata } from "@lastsaas/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { loadConfig, type AppConfig } from "../src/config";
import { addPolicy, removePolicy } from "../src/db/casbin";
import { registerTools } from "../src/mcp/registry";
import { createSecretService } from "../src/secrets/service";
import {
  closeServices,
  createServices,
  type AppServices,
} from "../src/services";
import { testMigrationSql } from "./test-migrations";

const plaintext = "secret-transport-sensitive-sentinel";
const base = "/v1/orgs/org_one/secrets";
const metadataKeys = [
  "created_at",
  "id",
  "key_version",
  "name",
  "organization_id",
  "updated_at",
];

describe("secret REST and MCP adapters", () => {
  let directory: string;
  let config: AppConfig;
  let services: AppServices;
  let app: ReturnType<typeof createApp>;
  const connections: Array<{ client: Client; server: McpServer }> = [];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "lastsaas-secret-transports-"));
    config = loadConfig({
      NODE_ENV: "test",
      PORT: "0",
      DATABASE_URL: `file:${join(directory, "test.sqlite")}`,
      STORAGE_PATH: join(directory, "files"),
      SECRETS_ACTIVE_KEY_VERSION: "v1",
      SECRETS_KEYRING: JSON.stringify({
        v1: Buffer.alloc(32, 17).toString("base64"),
      }),
    });
    services = await createServices(config);
    services.database!.exec(testMigrationSql);
    await services.prisma.organization.createMany({
      data: [
        { id: "org_one", name: "One", slug: "one" },
        { id: "org_two", name: "Two", slug: "two" },
      ],
    });
    for (const id of ["admin", "reader", "foreign"]) {
      await services.prisma.user.create({
        data: {
          id,
          email: `${id}@example.com`,
          name: id,
          kind: id === "reader" ? "service" : "human",
        },
      });
      await services.prisma.member.create({
        data: {
          id: `member_${id}`,
          userId: id,
          organizationId: id === "foreign" ? "org_two" : "org_one",
        },
      });
    }
    await addPolicy(services.prisma, "org_one", "admin", "/*", "*");
    await addPolicy(services.prisma, "org_two", "foreign", "/*", "*");
    // Authentication itself is covered elsewhere; exercise real membership and ACLs here.
    services.auth = {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const id = headers.get("x-test-user");
          return id
            ? { session: { id: `session_${id}` }, user: { id, name: id } }
            : null;
        },
        verifyApiKey: async ({ body }: { body: { key: string } }) => ({
          valid: true,
          key: {
            referenceId: body.key,
            metadata: { organizationId: "org_one" },
          },
        }),
      },
    } as unknown as AppServices["auth"];
    app = createApp({ config, services, logRequests: true });
  });

  afterEach(async () => {
    for (const { client, server } of connections.splice(0))
      await Promise.allSettled([client.close(), server.close()]);
    await closeServices(services);
    rmSync(directory, { recursive: true, force: true });
  });

  async function request(
    method: string,
    path = "",
    input?: unknown,
    user = "admin",
  ) {
    const response = await app.request(`${base}${path}`, {
      method,
      headers: { "x-test-user": user, "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    return {
      status: response.status,
      body: response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : await response.text(),
    };
  }
  async function connect(userId = "admin", orgId: string | null = "org_one") {
    const server = new McpServer({ name: "secrets-test", version: "1.0.0" });
    registerTools(server, { config, services, userId, orgId });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "secrets-client", version: "1.0.0" });
    await client.connect(clientTransport);
    connections.push({ client, server });
    return client;
  }
  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    const result = await client.callTool({
      name: `secrets_${name}`,
      arguments: args,
    });
    const body = result.structuredContent as {
      status: string;
      error?: string;
      secret: SecretMetadata & { value?: string };
      items: SecretMetadata[];
    };
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(body) },
    ]);
    expect(result.isError === true).toBe(body.status === "error");
    return body;
  }
  function failingPrisma(prisma: AppServices["prisma"]) {
    return new Proxy(prisma, {
      get(target, property, receiver) {
        if (property === "$transaction")
          return async () => {
            throw new Error(plaintext);
          };
        return Reflect.get(target, property, receiver);
      },
    });
  }
  async function grant(resource: string, action: string, user = "reader") {
    await addPolicy(services.prisma, "org_one", user, resource, action);
  }

  test("REST metadata and explicit POST reveal enforce independent current permissions", async () => {
    const created = await request("POST", "", {
      name: "credential",
      value: plaintext,
    });
    expect(created.status).toBe(201);
    expect(Object.keys(created.body.secret).sort()).toEqual(metadataKeys);
    await grant("/secrets/credential", "read");
    expect(
      (await request("GET", "/credential", undefined, "reader")).body,
    ).toEqual(created.body);
    const listed = await request("GET", "?limit=1", undefined, "reader");
    expect(listed.body).toEqual({
      status: "ok",
      items: [created.body.secret],
      next_cursor: null,
    });
    expect(JSON.stringify(listed.body)).not.toContain(plaintext);
    const denied = await request("POST", "/credential/reveal", {}, "reader");
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("PermissionDeniedError");
    expect(
      (await request("GET", "/credential/reveal", undefined, "reader")).status,
    ).toBe(404);
    await grant("/secrets/credential/value", "read");
    expect(
      (await request("POST", "/credential/reveal", {}, "reader")).body,
    ).toEqual({
      status: "ok",
      secret: {
        id: created.body.secret.id,
        name: "credential",
        value: plaintext,
      },
    });
    await removePolicy(
      services.prisma,
      "org_one",
      "reader",
      "/secrets/credential/value",
      "read",
    );
    expect(
      (await request("POST", "/credential/reveal", {}, "reader")).status,
    ).toBe(403);
    expect(
      JSON.stringify(await services.prisma.auditLog.findMany()),
    ).not.toContain(plaintext);
  });

  test("REST replacement, conflicts, deletion and foreign organization isolation preserve envelopes", async () => {
    await request("POST", "", { name: "credential", value: plaintext });
    expect(
      (await request("POST", "", { name: "credential", value: plaintext }))
        .status,
    ).toBe(409);
    expect(
      (
        await request(
          "PATCH",
          "/credential",
          { value: "replacement" },
          "reader",
        )
      ).status,
    ).toBe(403);
    await grant("/secrets/credential", "manage");
    const replacement = await request(
      "PATCH",
      "/credential",
      { value: "replacement" },
      "reader",
    );
    expect(replacement.status).toBe(200);
    expect(Object.keys(replacement.body.secret).sort()).toEqual(metadataKeys);
    expect(
      (await request("POST", "/credential/reveal", {}, "reader")).status,
    ).toBe(403);
    expect(
      (await request("POST", "/credential/reveal", {})).body.secret.value,
    ).toBe("replacement");
    await createSecretService(services.prisma, config.secretKeyring).create(
      {
        orgId: "org_two",
        userId: "foreign",
        userEmail: "foreign@example.com",
      },
      { name: "foreignOnly", value: plaintext },
    );
    expect((await request("GET", "/foreignOnly")).status).toBe(404);
    expect(
      (await request("DELETE", "/credential", undefined, "reader")).status,
    ).toBe(403);
    await grant("/secrets/credential", "delete");
    expect(
      (await request("DELETE", "/credential", undefined, "reader")).body,
    ).toEqual({ status: "ok" });
    expect((await request("GET", "/credential")).status).toBe(404);
  });

  test("REST validation, auth failures and unexpected errors never echo sensitive input or log it", async () => {
    const logs = [spyOn(console, "log"), spyOn(console, "error")];
    try {
      for (const input of [
        { name: "credential", value: plaintext, [plaintext]: true },
        { name: "bad/name", value: plaintext },
        { name: "credential", value: "é".repeat(32769) },
      ]) {
        const invalid = await request("POST", `?value=${plaintext}`, input);
        expect(invalid.status).toBe(400);
        expect(JSON.stringify(invalid.body)).not.toContain(plaintext);
      }
      for (const limit of ["1.5", "1e1", "0", "101", "", "-1"])
        expect((await request("GET", `?limit=${limit}`)).status).toBe(400);
      expect((await request("GET", `?${plaintext}=true`)).status).toBe(400);
      await request("POST", "", { name: "credential", value: plaintext });
      expect(
        (
          await request("POST", "/credential/reveal", {
            [plaintext]: plaintext,
          })
        ).status,
      ).toBe(400);
      const malformed = await app.request(base, {
        method: "POST",
        headers: { "x-test-user": "admin" },
        body: plaintext,
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.text()).not.toContain(plaintext);
      const unauthenticated = await app.request(`${base}/credential`);
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("cache-control")).toBe("no-store");
      const foreign = await request("GET", "/credential", undefined, "foreign");
      expect(foreign.status).toBe(403);
      const original = services.prisma;
      services.prisma = failingPrisma(original);
      try {
        const failed = await request("POST", "/credential/reveal", {});
        expect(failed.status).toBe(500);
        expect(JSON.stringify(failed.body)).not.toContain(plaintext);
      } finally {
        services.prisma = original;
      }
      for (const log of logs)
        expect(JSON.stringify(log.mock.calls)).not.toContain(plaintext);
    } finally {
      for (const log of logs) log.mockRestore();
    }
  });

  test("MCP registry exposes six secret tools with metadata-only CRUD and explicit reveal", async () => {
    const admin = await connect();
    const reader = await connect("reader");
    const names = (await admin.listTools()).tools
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("secrets_"));
    expect(names.sort()).toEqual([
      "secrets_create",
      "secrets_delete",
      "secrets_list",
      "secrets_replace",
      "secrets_reveal",
      "secrets_show",
    ]);
    const created = await call(admin, "create", {
      name: "credential",
      value: plaintext,
    });
    expect(Object.keys(created.secret).sort()).toEqual(metadataKeys);
    expect(
      (await call(admin, "create", { name: "credential", value: plaintext }))
        .error,
    ).toBe("AutomationConflictError");
    await grant("/secrets/credential", "read");
    expect(await call(reader, "show", { name: "credential" })).toEqual(created);
    expect((await call(reader, "list", { limit: 1 })).items).toEqual([
      created.secret,
    ]);
    expect((await call(reader, "reveal", { name: "credential" })).error).toBe(
      "PermissionDeniedError",
    );
    await grant("/secrets/credential/value", "read");
    expect(
      (await call(reader, "reveal", { name: "credential" })).secret.value,
    ).toBe(plaintext);
    expect(
      (await call(reader, "replace", { name: "credential", value: "new" }))
        .error,
    ).toBe("PermissionDeniedError");
    await grant("/secrets/credential", "manage");
    const replaced = await call(reader, "replace", {
      name: "credential",
      value: "new",
    });
    expect(replaced.secret.id).toBe(created.secret.id);
    expect(JSON.stringify(replaced)).not.toContain("new");
    expect(
      (await call(reader, "reveal", { name: "credential" })).secret.value,
    ).toBe("new");
    expect((await call(reader, "delete", { name: "credential" })).error).toBe(
      "PermissionDeniedError",
    );
    await grant("/secrets/credential", "delete");
    expect<unknown>(
      await call(reader, "delete", { name: "credential" }),
    ).toEqual({
      status: "ok",
    });
    expect((await call(admin, "show", { name: "credential" })).error).toBe(
      "AutomationNotFoundError",
    );
  });

  test("MCP validation, organization selection, revoked membership and internal failures are redacted", async () => {
    const admin = await connect();
    expect(
      (
        await call(admin, "create", {
          name: "credential",
          value: plaintext,
          [plaintext]: true,
        })
      ).error,
    ).toBe("SchemaValidationError");
    expect((await call(await connect("reader", null), "list")).error).toBe(
      "Unauthorized",
    );
    await call(admin, "create", { name: "credential", value: plaintext });
    const foreign = await connect("foreign", "org_two");
    expect((await call(foreign, "reveal", { name: "credential" })).error).toBe(
      "AutomationNotFoundError",
    );
    const reader = await connect("reader");
    await grant("/secrets/credential/value", "read");
    await services.prisma.member.delete({ where: { id: "member_reader" } });
    expect((await call(reader, "reveal", { name: "credential" })).error).toBe(
      "AutomationNotFoundError",
    );
    const logs = spyOn(console, "error");
    const original = services.prisma;
    services.prisma = failingPrisma(original);
    try {
      const failed = await call(admin, "reveal", { name: "credential" });
      expect(failed.error).toBe("InternalError");
      expect(JSON.stringify(failed)).not.toContain(plaintext);
      expect(JSON.stringify(logs.mock.calls)).not.toContain(plaintext);
    } finally {
      services.prisma = original;
      logs.mockRestore();
    }
  });

  test("startup without keys preserves health and metadata but REST/MCP writes and reveals return unavailable", async () => {
    const created = await request("POST", "", {
      name: "credential",
      value: plaintext,
    });
    const noKeys = loadConfig({
      NODE_ENV: "test",
      PORT: "0",
      DATABASE_URL: config.databaseUrl,
      STORAGE_PATH: join(directory, "files"),
    });
    const ordinaryServices = await createServices(noKeys);
    try {
      expect(
        (
          await createApp({
            config: noKeys,
            services: ordinaryServices,
          }).request("/health")
        ).status,
      ).toBe(200);
    } finally {
      await closeServices(ordinaryServices);
    }
    config = noKeys;
    app = createApp({ config, services });
    expect((await request("GET", "/credential")).body).toEqual(created.body);
    for (const [method, path, input] of [
      ["POST", "", { name: "another", value: plaintext }],
      ["PATCH", "/credential", { value: "new" }],
      ["POST", "/credential/reveal", {}],
    ] as const)
      expect((await request(method, path, input)).status).toBe(503);
    const client = await connect();
    expect((await call(client, "show", { name: "credential" })).secret).toEqual(
      created.body.secret,
    );
    for (const [name, input] of [
      ["create", { name: "another", value: plaintext }],
      ["replace", { name: "credential", value: "new" }],
      ["reveal", { name: "credential" }],
    ] as const)
      expect((await call(client, name, input)).error).toBe(
        "AutomationUnavailableError",
      );
    expect(await services.prisma.secret.count()).toBe(1);
  });

  test("MCP HTTP explicit reveal and auth failures carry no-store and exclude query/body values from logs", async () => {
    await request("POST", "", { name: "credential", value: plaintext });
    const logs = spyOn(console, "log");
    try {
      const response = await app.request(`/v1/mcp?value=${plaintext}`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "secrets_reveal", arguments: { name: "credential" } },
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body.result.structuredContent.secret.value).toBe(plaintext);
      expect(JSON.stringify(logs.mock.calls)).not.toContain(plaintext);
    } finally {
      logs.mockRestore();
    }
  });
});
