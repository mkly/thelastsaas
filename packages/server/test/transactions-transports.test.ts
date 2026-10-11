import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type {
  TransactionOperation,
  TransactionRequest,
} from "@lastsaas/shared";
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
import {
  closeServices,
  createServices,
  type AppServices,
} from "../src/services";
import { testMigrationSql } from "./test-migrations";

const sentinel = "transaction-private-sentinel";
const create: TransactionOperation = {
  op: "record.create",
  collection: "tasks",
  data: { title: "Work", owner: "worker@example.com", secret: sentinel },
};
const enqueue: TransactionOperation = {
  op: "queue.enqueue",
  queue: "jobs",
  entry: { payload: { title: "Work" } },
};

for (const transport of ["REST", "MCP"] as const) {
  describe(`bounded transactions ${transport}`, () => {
    let directory: string;
    let config: AppConfig;
    let services: AppServices;
    let app: ReturnType<typeof createApp>;
    beforeEach(async () => {
      directory = mkdtempSync(
        join(tmpdir(), "lastsaas-transaction-transports-"),
      );
      config = loadConfig({
        NODE_ENV: "test",
        PORT: "0",
        DATABASE_URL: `file:${join(directory, "test.db")}`,
        STORAGE_PATH: join(directory, "files"),
      });
      services = await createServices(config);
      services.database!.exec(testMigrationSql);
      for (const id of ["one", "two"])
        await services.prisma.organization.create({
          data: { id, name: id, slug: id },
        });
      for (const id of ["admin", "worker", "foreign"]) {
        await services.prisma.user.create({
          data: {
            id,
            name: id,
            email: `${id}@example.com`,
            kind: id === "worker" ? "service" : "human",
          },
        });
        await services.prisma.member.create({
          data: {
            id: `member_${id}`,
            userId: id,
            organizationId: id === "foreign" ? "two" : "one",
          },
        });
      }
      await addPolicy(services.prisma, "one", "admin", "/*", "*");
      await addPolicy(services.prisma, "two", "foreign", "/*", "*");
      await services.prisma.collection.create({
        data: {
          id: "tasks",
          orgId: "one",
          name: "tasks",
          schema: { title: "string", owner: "string", secret: "string" },
        },
      });
      await services.prisma.queue.create({
        data: {
          id: "jobs",
          orgId: "one",
          name: "jobs",
          schema: { title: "string" },
        },
      });
      await services.prisma.queueSubscription.create({
        data: { id: "sub", queueId: "jobs", name: "workers" },
      });
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
              metadata: {
                organizationId: body.key === "foreign" ? "two" : "one",
              },
            },
          }),
        },
      } as unknown as AppServices["auth"];
      app = createApp({ config, services, logRequests: true });
    });
    afterEach(async () => {
      await closeServices(services);
      rmSync(directory, { recursive: true, force: true });
    });
    async function call(input: unknown, user = "admin", raw?: string) {
      const isMcp = transport === "MCP";
      const response = await app.request(
        `${isMcp ? "/v1/mcp" : "/v1/orgs/one/transactions"}?private=${sentinel}`,
        {
          method: "POST",
          headers: {
            "x-test-user": user,
            authorization: `Bearer ${user}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body:
            raw ??
            JSON.stringify(
              isMcp
                ? {
                    jsonrpc: "2.0",
                    id: 1,
                    method: "tools/call",
                    params: { name: "transactions_execute", arguments: input },
                  }
                : input,
            ),
        },
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      const envelope = await response.json();
      const body =
        isMcp && response.status === 200
          ? envelope.result.structuredContent
          : envelope;
      if (isMcp && response.status === 200) {
        expect(envelope.result.content).toEqual([
          { type: "text", text: JSON.stringify(body) },
        ]);
        expect(envelope.result.isError === true).toBe(body.status === "error");
      }
      return { status: response.status, body };
    }
    async function counts() {
      return Promise.all([
        services.prisma.record.count(),
        services.prisma.queueEntry.count(),
        services.prisma.queueDelivery.count(),
        services.prisma.auditLog.count(),
        services.prisma.transactionRequest.count(),
      ]);
    }
    async function grant(action: string, options = {}) {
      await addPolicy(
        services.prisma,
        "one",
        "worker",
        "/collections/tasks",
        action,
        options,
      );
    }
    test("ordered mixed operations and literal IDs commit with stable envelopes", async () => {
      const initial = await call({
        operations: [create, enqueue],
        idempotency_key: "mixed",
      });
      expect(initial.body.status).toBe("ok");
      expect(initial.body.results.map((r: { op: string }) => r.op)).toEqual([
        "record.create",
        "queue.enqueue",
      ]);
      const id = initial.body.results[0].record.id;
      const changed = await call({
        operations: [
          {
            op: "record.update",
            collection: "tasks",
            id,
            data: { title: "${results.0.id}" },
          },
          { op: "record.delete", collection: "tasks", id },
        ],
      });
      expect(changed.body.status).toBe("ok");
      expect(changed.body.results[0].record.data.title).toBe("${results.0.id}");
      expect(changed.body.results[1]).toEqual({ op: "record.delete", id });
      expect(await counts()).toEqual([0, 1, 1, 4, 1]);
      expect(
        JSON.stringify(await services.prisma.auditLog.findMany()),
      ).not.toContain(sentinel);
    });
    // Operation-count, field-denial and schema-rollback matrices live in
    // transactions-service.test.ts. Keep transport-specific permission errors,
    // ingress validation and replay projection below.
    test("later permission denial rolls back a service-account write", async () => {
      await grant("create");
      await grant("read");
      const failed = await call(
        { operations: [create, enqueue], idempotency_key: "denial" },
        "worker",
      );
      expect(failed.body.error).toBe("PermissionDeniedError");
      if (transport === "REST") expect(failed.status).toBe(403);
      expect(await counts()).toEqual([0, 0, 0, 0, 0]);
      // Preserve the distinct field-denial envelope without rebuilding the
      // service's 25-operation and rollback matrix at each transport.
      await grant("create", { fields: ["title"] });
      await removePolicy(
        services.prisma,
        "one",
        "worker",
        "/collections/tasks",
        "create",
      );
      const fieldDenied = await call({ operations: [create] }, "worker");
      expect(fieldDenied.body.error).toBe("FieldPermissionDeniedError");
      if (transport === "REST") expect(fieldDenied.status).toBe(403);
      expect(await counts()).toEqual([0, 0, 0, 0, 0]);
    });
    test("row/field constraints and revocation apply to idempotent replay", async () => {
      await grant("create");
      const readOptions = {
        where: { owner: "$user.email" },
        fields: ["title"],
      };
      await grant("read", readOptions);
      const input = { operations: [create], idempotency_key: "replay" };
      const first = await call(input, "worker");
      expect(first.body.status).toBe("ok");
      expect(first.body.results[0].record.data).toEqual(
        create.op === "record.create" ? create.data : {},
      );
      const replay = await call(input, "worker");
      expect(replay.body.results[0].record.data).toEqual({ title: "Work" });
      expect(replay.body.results[0].record.id).toBe(
        first.body.results[0].record.id,
      );
      expect((await call(input, "worker")).body).toEqual(replay.body);
      expect(
        (
          await call(
            {
              ...input,
              operations: [{ ...create, data: { title: "Changed" } }],
            },
            "worker",
          )
        ).body.error,
      ).toBe("AutomationConflictError");
      if (transport === "REST")
        expect(
          (await call({ ...input, operations: [enqueue] }, "worker")).status,
        ).toBe(409);
      await removePolicy(
        services.prisma,
        "one",
        "worker",
        "/collections/tasks",
        "read",
        readOptions,
      );
      expect((await call(input, "worker")).body.error).toBe(
        "PermissionDeniedError",
      );
      expect(await counts()).toEqual([1, 0, 0, 1, 1]);
    });
    test("idempotency is scoped to authenticated principal; identity overrides and foreign resources fail", async () => {
      await grant("create");
      await grant("read");
      const input = { operations: [create], idempotency_key: "shared" };
      const admin = await call(input);
      const worker = await call(input, "worker");
      expect(worker.body.status).toBe("ok");
      expect(worker.body.results[0].record.id).not.toBe(
        admin.body.results[0].record.id,
      );
      expect(
        (
          await call(
            { ...input, userId: "admin", orgId: "two", system: true },
            "worker",
          )
        ).body.error,
      ).toBe("SchemaValidationError");
      const foreign = await call(input, "foreign");
      if (transport === "REST") expect(foreign.status).toBe(403);
      else expect(foreign.body.error).toBe("CollectionNotFoundError");
      expect(await services.prisma.record.count()).toBe(2);
      await services.prisma.member.delete({ where: { id: "member_worker" } });
      expect((await call(input, "worker")).status).toBe(403);
    });
    test("rejects operation limits, executable/SQL operations, result references and malformed JSON without writes", async () => {
      for (const input of [
        { operations: Array.from({ length: 26 }, () => create) },
        { operations: [] },
        { operations: [{ op: "sql", query: sentinel }] },
        {
          operations: [
            {
              op: "record.update",
              collection: "tasks",
              id: { result: 0 },
              data: {},
            },
          ],
        },
        { operations: [{ ...create, execute: sentinel }] },
        { operations: [{ ...create, data: { title: "é".repeat(524289) } }] },
      ]) {
        const failed = await call(input);
        // Both adapters return the same controlled validation envelope.
        expect(["SchemaValidationError", "RequestTooLarge"]).toContain(
          failed.body.error,
        );
      }
      const malformed = await call({}, "admin", "{broken");
      expect(malformed.status).toBe(400);
      expect(await counts()).toEqual([0, 0, 0, 0, 0]);
    });
    test("standard ingress limits bound JSON and streamed requests", async () => {
      const input = { operations: [create] };
      const envelope =
        transport === "REST"
          ? input
          : {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { arguments: input, name: "transactions_execute" },
            };
      const padded =
        " ".repeat((transport === "REST" ? 1 : 16) * 1024 * 1024 + 1) +
        JSON.stringify(envelope);
      expect((await call({}, "admin", padded)).status).toBe(413);
      const chunk = new TextEncoder().encode(padded);
      const server = Bun.serve({ port: 0, fetch: app.fetch });
      try {
        const response = await fetch(
          new URL(
            transport === "REST" ? "/v1/orgs/one/transactions" : "/v1/mcp",
            server.url,
          ),
          {
            method: "POST",
            headers: {
              "x-test-user": "admin",
              authorization: "Bearer admin",
              "content-type": "application/json",
            },
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(chunk.subarray(0, 100));
                controller.enqueue(chunk.subarray(100));
                controller.close();
              },
            }),
          },
        );
        expect(response.status).toBe(413);
        expect(await response.json()).toMatchObject({
          status: "error",
          error: "RequestTooLarge",
        });
        expect(await counts()).toEqual([0, 0, 0, 0, 0]);
      } finally {
        server.stop(true);
      }
    });
    test("validation and internal failure responses and request logs omit private inputs", async () => {
      const logs = [spyOn(console, "log"), spyOn(console, "error")];
      const original = services.prisma;
      try {
        const invalid = await call({
          operations: [{ ...create, [sentinel]: true }],
        });
        expect(JSON.stringify(invalid)).not.toContain(sentinel);
        services.prisma = new Proxy(original, {
          get(target, property, receiver) {
            if (property === "$transaction")
              return async () => {
                throw new Error(sentinel);
              };
            return Reflect.get(target, property, receiver);
          },
        });
        const failed = await call({ operations: [create] });
        expect(failed.body.error).toBe("InternalError");
        if (transport === "REST") expect(failed.status).toBe(500);
        expect(JSON.stringify(failed)).not.toContain(sentinel);
        for (const log of logs)
          expect(JSON.stringify(log.mock.calls)).not.toContain(sentinel);
      } finally {
        services.prisma = original;
        for (const log of logs) log.mockRestore();
      }
    });
    if (transport === "MCP")
      test("registry advertises the additive tool and unselected organization cannot execute", async () => {
        const server = new McpServer({
          name: "transactions-test",
          version: "1.0.0",
        });
        registerTools(server, {
          config,
          services,
          userId: "admin",
          orgId: null,
        });
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        const client = new Client({
          name: "transactions-test",
          version: "1.0.0",
        });
        await client.connect(clientTransport);
        try {
          expect(
            (await client.listTools()).tools.some(
              (t) => t.name === "transactions_execute",
            ),
          ).toBe(true);
          const response = await client.callTool({
            name: "transactions_execute",
            arguments: { operations: [create] } satisfies TransactionRequest,
          });
          expect(response.isError).toBe(true);
          expect(response.structuredContent).toMatchObject({
            error: "Unauthorized",
          });
          expect(await counts()).toEqual([0, 0, 0, 0, 0]);
        } finally {
          await Promise.allSettled([client.close(), server.close()]);
        }
      });
  });
}
