import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient, handleResponse } from "../api-client";
import { CliError, ReauthenticationRequiredError } from "../errors";
import { createProgram } from "../index";
import { registerQueues } from "./queues";

const queue = {
  id: "q1",
  organization_id: "org_1",
  name: "jobs",
  schema: { title: "string" },
  schema_version: 1,
  enabled: true,
  created_at: "2026-10-10T00:00:00Z",
  updated_at: "2026-10-10T00:00:00Z",
};
const subscription = {
  id: "s1",
  queue_id: "q1",
  name: "worker",
  enabled: true,
  max_attempts: 3,
  lease_seconds: 60,
  retry_delay_seconds: 30,
  retention_days: 7,
  created_at: queue.created_at,
  updated_at: queue.updated_at,
};

async function fixture(
  run: (f: {
    parse(args: string[]): Promise<void>;
    requests: Array<{
      method: string;
      path: string;
      query: string;
      body: unknown;
      token: string | null;
    }>;
    outputs: Array<{ value: unknown; json?: boolean; human?: string }>;
    respond(value: Response): void;
  }) => Promise<void>,
) {
  const requests: Array<{
    method: string;
    path: string;
    query: string;
    body: unknown;
    token: string | null;
  }> = [];
  const outputs: Array<{ value: unknown; json?: boolean; human?: string }> = [];
  let response = Response.json({ status: "ok", queue, subscription });
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        body: ["POST", "PATCH"].includes(request.method)
          ? await request.json()
          : null,
        token: request.headers.get("x-api-key"),
      });
      return response.clone();
    },
  });
  try {
    await run({
      requests,
      outputs,
      respond: (value) => {
        response = value;
      },
      parse: async (args) => {
        const program = createProgram([])
          .exitOverride()
          .configureOutput({ writeErr: () => {} });
        registerQueues(program, {
          getOrgClient: (options) => ({
            client: createApiClient(
              server.url.href,
              options?.token ?? "fallback",
              "api-token",
            ),
            config: { server: server.url.href },
            orgId: options?.org ?? "fallback",
          }),
          handleResponse,
          writeOutput: (value, options = {}, human) => {
            outputs.push({ value, json: options.json, human });
          },
        });
        await program.parseAsync(
          ["--org", "org_1", "--token", "worker-token", ...args],
          { from: "user" },
        );
      },
    });
  } finally {
    server.stop(true);
  }
}

describe("queue administration CLI", () => {
  test("creates from JSON or a real schema file and updates without defaulting omitted settings", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saas-queue-"));
    const path = join(directory, "schema.json");
    writeFileSync(path, JSON.stringify(queue.schema));
    try {
      await fixture(async ({ parse, requests, outputs }) => {
        await parse([
          "--json",
          "queues",
          "create",
          "jobs",
          "--schema",
          JSON.stringify(queue.schema),
        ]);
        await parse([
          "queues",
          "create",
          "jobs",
          "--schema-file",
          path,
          "--enabled",
          "off",
        ]);
        await parse(["queues", "update", "jobs", "--enabled", "on"]);
        await parse(["queues", "update", "jobs", "--schema-file", path]);
        expect(requests.map((r) => r.body)).toEqual([
          { name: "jobs", schema: queue.schema, enabled: true },
          { name: "jobs", schema: queue.schema, enabled: false },
          { enabled: true },
          { schema: queue.schema },
        ]);
        expect(requests.map((r) => [r.method, r.path, r.token])).toEqual([
          ["POST", "/v1/orgs/org_1/queues", "worker-token"],
          ["POST", "/v1/orgs/org_1/queues", "worker-token"],
          ["PATCH", "/v1/orgs/org_1/queues/jobs", "worker-token"],
          ["PATCH", "/v1/orgs/org_1/queues/jobs", "worker-token"],
        ]);
        expect(outputs[0]?.value).toEqual({
          status: "ok",
          queue,
          subscription,
        });
        expect(outputs[0]?.json).toBe(true);
        expect(outputs[1]?.human).toContain('Schema: {"title":"string"}');
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("list/show preserve envelopes and expose cursors in human and JSON output", async () => {
    await fixture(async ({ parse, requests, outputs, respond }) => {
      const result = { status: "ok", items: [queue], next_cursor: "next-page" };
      respond(Response.json(result));
      await parse([
        "--json",
        "queues",
        "list",
        "--limit",
        "2",
        "--cursor",
        "opaque+cursor/=",
      ]);
      expect(requests[0]?.query).toBe("?limit=2&cursor=opaque%2Bcursor%2F%3D");
      expect(outputs[0]?.value).toEqual(result);
      expect(outputs[0]?.human).toContain("Next cursor: next-page");
      respond(Response.json({ status: "ok", queue }));
      await parse(["queues", "show", "jobs"]);
      expect(requests[1]?.path).toBe("/v1/orgs/org_1/queues/jobs");
      expect(outputs[1]?.human).toContain("jobs (q1)");
      respond(Response.json({ status: "ok", items: [], next_cursor: null }));
      await parse(["queues", "list"]);
      expect(requests[2]?.query).toBe("?limit=100");
      expect(outputs[2]?.human).toBe("No items.");
    });
  });

  test("subscription CRUD serializes wire settings, defaults, pagination and explicit deletion", async () => {
    await fixture(async ({ parse, requests, respond }) => {
      await parse(["queues", "subscriptions", "create", "jobs", "worker"]);
      await parse([
        "queues",
        "subscriptions",
        "create",
        "jobs",
        "worker",
        "--max-attempts",
        "100",
        "--lease-seconds",
        "3600",
        "--retention-days",
        "365",
        "--enabled",
        "off",
      ]);
      await parse([
        "queues",
        "subscriptions",
        "update",
        "jobs",
        "worker",
        "--lease-seconds",
        "10",
        "--enabled",
        "on",
      ]);
      expect(requests.map((r) => r.body)).toEqual([
        {
          name: "worker",
          enabled: true,
          max_attempts: 3,
          lease_seconds: 60,
          retry_delay_seconds: 30,
          retention_days: 7,
        },
        {
          name: "worker",
          enabled: false,
          max_attempts: 100,
          lease_seconds: 3600,
          retry_delay_seconds: 30,
          retention_days: 365,
        },
        { enabled: true, lease_seconds: 10 },
      ]);
      expect(requests[2]?.method).toBe("PATCH");
      expect(requests[2]?.path).toBe(
        "/v1/orgs/org_1/queues/jobs/subscriptions/worker",
      );
      respond(
        Response.json({
          status: "ok",
          items: [subscription],
          next_cursor: "next",
        }),
      );
      await parse([
        "queues",
        "subscriptions",
        "list",
        "jobs",
        "--limit",
        "1",
        "--cursor",
        "next",
      ]);
      expect(requests[3]?.query).toBe("?limit=1&cursor=next");
      respond(Response.json({ status: "ok" }));
      await parse([
        "queues",
        "subscriptions",
        "delete",
        "jobs",
        "worker",
        "--confirm",
      ]);
      await parse(["queues", "delete", "jobs", "--confirm"]);
      expect(
        requests.slice(4).map((r) => [r.method, r.path, r.query, r.body]),
      ).toEqual([
        ["DELETE", "/v1/orgs/org_1/queues/jobs/subscriptions/worker", "", null],
        ["DELETE", "/v1/orgs/org_1/queues/jobs", "", null],
      ]);
    });
  });

  test("inspection sends JSON Where and delivery filters without altering server projection", async () => {
    await fixture(async ({ parse, requests, outputs, respond }) => {
      const page = {
        status: "ok",
        items: [{ id: "e1", payload: { title: "visible" } }],
        next_cursor: "continue",
      };
      respond(Response.json(page));
      const where = { title: { contains: "a&b+é" } };
      await parse([
        "--json",
        "queues",
        "entries",
        "jobs",
        "--where",
        JSON.stringify(where),
      ]);
      expect(new URLSearchParams(requests[0]?.query).get("where")).toBe(
        JSON.stringify(where),
      );
      expect(outputs[0]?.value).toEqual(page);
      respond(Response.json({ status: "ok", items: [], next_cursor: null }));
      await parse([
        "queues",
        "deliveries",
        "jobs",
        "--subscription",
        "worker",
        "--state",
        "dead",
        "--limit",
        "5",
      ]);
      expect(requests[1]?.query).toBe(
        "?limit=5&subscription=worker&state=dead",
      );
    });
  });

  test("invalid inputs and missing confirmations never send HTTP requests", async () => {
    await fixture(async ({ parse, requests }) => {
      for (const args of [
        ["create", "jobs"],
        ["create", "../foreign", "--schema", "{}"],
        ["show", "_system_jobs"],
        ["create", "jobs", "--schema", "{"],
        ["create", "jobs", "--schema", "[]"],
        [
          "create",
          "jobs",
          "--schema",
          '{"title":{"type":"string","required":true}}',
        ],
        ["create", "jobs", "--schema", "{}", "--schema-file", "unused"],
        ["create", "jobs", "--schema-file", "/no-such-schema"],
        ["update", "jobs"],
        ["update", "jobs", "--enabled", "false"],
        ["delete", "jobs"],
        ["list", "--limit", "0"],
        ["list", "--limit", "101"],
        ["list", "--limit", "1e2"],
        ["list", "--limit", "1.5"],
        ["list", "--cursor", ""],
        ["list", "--cursor", "x".repeat(2049)],
        ["subscriptions", "create", "jobs", "worker", "--max-attempts", "0"],
        [
          "subscriptions",
          "create",
          "jobs",
          "worker",
          "--lease-seconds",
          "3601",
        ],
        [
          "subscriptions",
          "create",
          "jobs",
          "worker",
          "--retention-days",
          "366",
        ],
        ["subscriptions", "update", "jobs", "worker"],
        ["subscriptions", "delete", "jobs", "worker"],
        ["entries", "jobs", "--where", "{"],
        ["entries", "jobs", "--where", '{"a":{"wat":1}}'],
        ["deliveries", "jobs", "--state", "unknown"],
        ["deliveries", "jobs", "--subscription", "../worker"],
      ])
        await expect(parse(["queues", ...args])).rejects.toThrow();
      expect(requests).toHaveLength(0);
    });
  });

  test("denied, conflicting, unauthenticated and malformed requests produce CLI errors with no success output", async () => {
    await fixture(async ({ parse, respond, outputs }) => {
      for (const [status, message] of [
        [403, "Queue permission denied"],
        [404, "Resource not found"],
        [409, "Queue operation conflicts with current resource state"],
      ] as const) {
        respond(
          Response.json(
            { status: "error", error: "Rejected", message },
            { status },
          ),
        );
        await expect(parse(["queues", "show", "jobs"])).rejects.toThrow(
          message,
        );
      }
      respond(Response.json({ status: "error" }, { status: 401 }));
      await expect(parse(["queues", "show", "jobs"])).rejects.toBeInstanceOf(
        ReauthenticationRequiredError,
      );
      respond(new Response("invalid JSON"));
      await expect(parse(["queues", "show", "jobs"])).rejects.toBeInstanceOf(
        CliError,
      );
      expect(outputs).toHaveLength(0);
    });
  });
  test("enqueue JSON and file payloads preserve availability and retry keys", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saas-payload-"));
    const path = join(directory, "payload.json");
    writeFileSync(path, '{"title":"é & +"}');
    try {
      await fixture(async ({ parse, requests, outputs, respond }) => {
        const receipt = {
          status: "ok",
          entries: [{ id: "e1" }],
          delivery_count: 2,
        };
        respond(Response.json(receipt, { status: 201 }));
        await parse([
          "--json",
          "queues",
          "enqueue",
          "jobs",
          "--payload",
          '{"title":"first"}',
          "--available-at",
          "2026-10-11T12:00:00Z",
          "--idempotency-key",
          "retry-1",
        ]);
        await parse(["queues", "enqueue", "jobs", "--payload-file", path]);
        expect(requests.map((request) => request.body)).toEqual([
          {
            entries: [
              {
                payload: { title: "first" },
                available_at: "2026-10-11T12:00:00Z",
                idempotency_key: "retry-1",
              },
            ],
          },
          { entries: [{ payload: { title: "é & +" } }] },
        ]);
        expect(requests.map((r) => [r.method, r.path])).toEqual([
          ["POST", "/v1/orgs/org_1/queues/jobs/entries"],
          ["POST", "/v1/orgs/org_1/queues/jobs/entries"],
        ]);
        expect(outputs[0]?.value).toEqual(receipt);
        expect(outputs[0]?.json).toBe(true);
        expect(outputs[1]?.value).toEqual(receipt);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("scripted claims preserve tokens and require a separate ack with distinct authentication", async () => {
    await fixture(async ({ parse, requests, outputs, respond }) => {
      const claim = {
        status: "ok",
        claims: [
          {
            delivery_id: "delivery_1",
            lease_token: "opaque+/lease=",
            payload: { title: "process" },
          },
        ],
        has_more: true,
      };
      respond(Response.json(claim));
      await parse([
        "--json",
        "queues",
        "claim",
        "jobs",
        "worker",
        "--limit",
        "2",
      ]);
      expect(requests).toHaveLength(1); // Claim never implicitly settles work.
      expect(outputs[0]?.value).toEqual(claim);
      expect(outputs[0]?.json).toBe(true);
      const leased = outputs[0]?.value as typeof claim;
      const result = {
        status: "ok",
        delivery: { id: "delivery_1", state: "succeeded" },
      };
      respond(Response.json(result));
      await parse([
        "--json",
        "queues",
        "ack",
        "jobs",
        leased.claims[0]!.delivery_id,
        "--lease-token",
        leased.claims[0]!.lease_token,
      ]);
      expect(requests.map((r) => [r.path, r.body, r.token])).toEqual([
        [
          "/v1/orgs/org_1/queues/jobs/subscriptions/worker/claim",
          { limit: 2 },
          "worker-token",
        ],
        [
          "/v1/orgs/org_1/queues/jobs/deliveries/delivery_1/ack",
          { token: "opaque+/lease=" },
          "worker-token",
        ],
      ]);
      expect(outputs[1]?.value).toEqual(result);
      respond(Response.json({ status: "ok", claims: [], has_more: false }));
      await parse(["queues", "claim", "jobs", "worker"]);
      expect(requests[2]?.body).toEqual({ limit: 1 });
      expect(outputs[2]?.value).toEqual({
        status: "ok",
        claims: [],
        has_more: false,
      });
    });
  });

  test("nack, extend, cancel and redrive serialize explicit lifecycle requests", async () => {
    await fixture(async ({ parse, requests, respond, outputs }) => {
      const result = {
        status: "ok",
        delivery: { id: "delivery_1", state: "ready" },
      };
      respond(Response.json(result));
      await parse([
        "queues",
        "nack",
        "jobs",
        "delivery_1",
        "--lease-token",
        "lease",
        "--error",
        "try again",
      ]);
      await parse([
        "queues",
        "nack",
        "jobs",
        "delivery_1",
        "--lease-token",
        "lease",
      ]);
      await parse([
        "queues",
        "nack",
        "jobs",
        "delivery_1",
        "--lease-token",
        "lease",
      ]);
      await parse([
        "queues",
        "extend",
        "jobs",
        "delivery_1",
        "--lease-token",
        "lease",
      ]);
      await parse(["queues", "cancel", "jobs", "delivery_1"]);
      await parse(["queues", "redrive", "jobs", "delivery_1"]);
      expect(requests.map((r) => r.body)).toEqual([
        { token: "lease", error: "try again" },
        { token: "lease" },
        { token: "lease" },
        { token: "lease" },
        {},
        {},
      ]);
      expect(requests.map((r) => r.path.split("/").at(-1))).toEqual([
        "nack",
        "nack",
        "nack",
        "extend",
        "cancel",
        "redrive",
      ]);
      expect(
        outputs.every(
          (output) => JSON.stringify(output.value) === JSON.stringify(result),
        ),
      ).toBe(true);
    });
  });

  test("lifecycle failures remain nonzero and never echo submitted lease tokens", async () => {
    await fixture(async ({ parse, outputs, respond }) => {
      for (const status of [400, 403, 404, 409, 500]) {
        respond(
          Response.json(
            { status: "error", message: "Rejected opaque+/lease= token" },
            { status },
          ),
        );
        let error: unknown;
        try {
          await parse([
            "--json",
            "queues",
            "ack",
            "jobs",
            "delivery_1",
            "--lease-token",
            "opaque+/lease=",
          ]);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(1);
        expect((error as Error).message).toBe("Rejected [redacted] token");
        expect(String(error)).not.toContain("opaque+/lease=");
      }
      respond(new Response("bad JSON"));
      await expect(
        parse([
          "queues",
          "ack",
          "jobs",
          "delivery_1",
          "--lease-token",
          "lease",
        ]),
      ).rejects.toBeInstanceOf(CliError);
      respond(Response.json({ status: "error" }, { status: 401 }));
      await expect(
        parse([
          "queues",
          "ack",
          "jobs",
          "delivery_1",
          "--lease-token",
          "lease",
        ]),
      ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
      expect(outputs).toHaveLength(0);
    });
  });

  test("worker help explains explicit settlement and authentication token separation", () => {
    const queues = createProgram().commands.find((c) => c.name() === "queues")!;
    let help = "";
    const claim = queues.commands.find((c) => c.name() === "claim")!;
    claim.configureOutput({
      writeOut: (value) => {
        help += value;
      },
    });
    claim.outputHelp();
    expect(help).toContain("never auto-ack");
    expect(help).toContain("explicitly ack");
    expect(help).toContain("at least once");
    expect(help).toContain("has_more");
    expect(
      queues.commands
        .find((c) => c.name() === "ack")!
        .helpInformation()
        .replace(/\s+/g, " "),
    ).toContain("--token is the authentication token");
  });
});
