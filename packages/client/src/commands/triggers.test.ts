import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiClient, handleResponse } from "../api-client";
import { CliError, ReauthenticationRequiredError } from "../errors";
import { createProgram } from "../index";
import { registerTriggers } from "./triggers";

const mapping = {
  title: { kind: "after", field: "title" },
  old_title: { kind: "before", field: "title" },
  source: { kind: "literal", value: { label: "é", tags: [true, null, 1] } },
  record: { kind: "metadata", key: "recordId" },
};
const where = { and: [{ title: { contains: "a&b+é" } }, { closed: false }] };
const trigger = {
  id: "trigger_1",
  organization_id: "org_1",
  created_by: "creator_1",
  collection_id: "collection_1",
  queue_id: "queue_1",
  collection: "tickets",
  queue: "jobs",
  events: ["update"],
  watched_fields: ["title"],
  where,
  mapping,
  status: "paused",
  pause_reason: "Creator permissions changed",
  created_at: "2026-10-10T00:00:00Z",
  updated_at: "2026-10-10T00:00:00Z",
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
    respond(response: Response): void;
    mappingPath: string;
    wherePath: string;
    directory: string;
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
  let response = Response.json({ status: "ok", trigger });
  const directory = mkdtempSync(join(tmpdir(), "saas-triggers-"));
  const mappingPath = join(directory, "mapping.json");
  const wherePath = join(directory, "where.json");
  writeFileSync(mappingPath, JSON.stringify(mapping));
  writeFileSync(wherePath, JSON.stringify(where));
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
      mappingPath,
      wherePath,
      directory,
      respond: (value) => {
        response = value;
      },
      parse: async (args) => {
        const program = createProgram([])
          .exitOverride()
          .configureOutput({ writeErr: () => {} });
        registerTriggers(program, {
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
          ["--org", "org_1", "--token", "test-token", ...args],
          { from: "user" },
        );
      },
    });
  } finally {
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}

function createArgs(mappingPath: string) {
  return [
    "triggers",
    "create",
    "--collection",
    "tickets",
    "--queue",
    "jobs",
    "--events",
    "update",
    "--mapping-file",
    mappingPath,
  ];
}

describe("trigger CLI", () => {
  test("registers commands in the active entry point and explains publication and tagged mapping", () => {
    const triggers = createProgram().commands.find(
      (command) => command.name() === "triggers",
    )!;
    expect(triggers.commands.map((command) => command.name())).toEqual([
      "create",
      "update",
      "list",
      "show",
      "pause",
      "resume",
      "delete",
    ]);
    for (const command of [
      triggers,
      triggers.commands[0]!,
      triggers.commands[1]!,
    ]) {
      let help = "";
      command.configureOutput({
        writeOut: (text) => {
          help += text;
        },
      });
      command.outputHelp();
      expect(help).toContain(
        "Triggers enqueue messages; they do not execute code",
      );
      expect(help).toContain("--mapping-file");
      expect(help).toContain("--where");
      expect(help).toContain("--watch-fields");
      expect(help).toContain("creator's current authority");
    }
  });

  test("reads tagged mapping and predicates, scopes requests and preserves response output", async () => {
    await fixture(
      async ({ parse, requests, outputs, mappingPath, wherePath }) => {
        await parse([
          "--json",
          ...createArgs(mappingPath),
          "--watch-fields",
          "title, closed",
          "--where",
          JSON.stringify(where),
        ]);
        await parse([
          ...createArgs(mappingPath),
          "--where-file",
          wherePath,
          "--enabled",
          "off",
        ]);
        expect(requests).toEqual([
          {
            method: "POST",
            path: "/v1/orgs/org_1/triggers",
            query: "",
            body: {
              collection: "tickets",
              queue: "jobs",
              events: ["update"],
              watched_fields: ["title", "closed"],
              where,
              mapping,
              enabled: true,
            },
            token: "test-token",
          },
          {
            method: "POST",
            path: "/v1/orgs/org_1/triggers",
            query: "",
            body: {
              collection: "tickets",
              queue: "jobs",
              events: ["update"],
              where,
              mapping,
              enabled: false,
            },
            token: "test-token",
          },
        ]);
        expect(outputs[0]?.value).toEqual({ status: "ok", trigger });
        expect(outputs[0]?.json).toBe(true);
        expect(outputs[1]?.human).toContain("tickets -> jobs (paused)");
        expect(outputs[1]?.human).toContain('"kind": "before"');
        expect(outputs[1]?.human).toContain('"label": "é"');
        expect(outputs[1]?.human).toContain(JSON.stringify(where));
        expect(outputs[1]?.human).toContain(
          "Pause reason: Creator permissions changed",
        );
      },
    );
  });

  test("updates only supplied controls and pauses/resumes through normal PATCH", async () => {
    await fixture(async ({ parse, requests, mappingPath, wherePath }) => {
      await parse([
        "triggers",
        "update",
        "trigger_1",
        "--mapping-file",
        mappingPath,
      ]);
      await parse([
        "triggers",
        "update",
        "trigger_1",
        "--collection",
        "Other Collection",
        "--queue",
        "new_jobs",
        "--events",
        "create, delete",
        "--where-file",
        wherePath,
        "--enabled",
        "on",
      ]);
      await parse([
        "triggers",
        "update",
        "trigger_1",
        "--watch-fields",
        "title",
      ]);
      await parse(["triggers", "pause", "trigger_1"]);
      await parse(["triggers", "resume", "trigger_1"]);
      expect(
        requests.map((request) => [request.method, request.path, request.body]),
      ).toEqual([
        ["PATCH", "/v1/orgs/org_1/triggers/trigger_1", { mapping }],
        [
          "PATCH",
          "/v1/orgs/org_1/triggers/trigger_1",
          {
            collection: "Other Collection",
            queue: "new_jobs",
            events: ["create", "delete"],
            where,
            enabled: true,
          },
        ],
        [
          "PATCH",
          "/v1/orgs/org_1/triggers/trigger_1",
          { watched_fields: ["title"] },
        ],
        ["PATCH", "/v1/orgs/org_1/triggers/trigger_1", { enabled: false }],
        ["PATCH", "/v1/orgs/org_1/triggers/trigger_1", { enabled: true }],
      ]);
    });
  });

  test("lists one page with cursors and supports show and confirmed deletion", async () => {
    await fixture(async ({ parse, respond, requests, outputs }) => {
      const page = { status: "ok", items: [trigger], next_cursor: "next-page" };
      respond(Response.json(page));
      await parse([
        "--json",
        "triggers",
        "list",
        "--limit",
        "2",
        "--cursor",
        "opaque+cursor/=",
      ]);
      expect(requests[0]?.query).toBe("?limit=2&cursor=opaque%2Bcursor%2F%3D");
      expect(outputs[0]?.value).toEqual(page);
      expect(outputs[0]?.human).toContain("Next cursor: next-page");
      respond(Response.json({ status: "ok", items: [], next_cursor: null }));
      await parse(["triggers", "list"]);
      expect(requests[1]?.query).toBe("?limit=100");
      expect(outputs[1]?.human).toBe("No items.");
      respond(
        Response.json({
          status: "ok",
          trigger: {
            ...trigger,
            watched_fields: null,
            where: null,
            status: "active",
            pause_reason: null,
          },
        }),
      );
      await parse(["triggers", "show", "trigger_1"]);
      expect(requests[2]?.method).toBe("GET");
      expect(requests[2]?.path).toBe("/v1/orgs/org_1/triggers/trigger_1");
      expect(outputs[2]?.human).toContain("any changed field");
      expect(outputs[2]?.human).not.toContain("Pause reason:");
      await expect(parse(["triggers", "delete", "trigger_1"])).rejects.toThrow(
        "--confirm",
      );
      respond(Response.json({ status: "ok" }));
      await parse(["--json", "triggers", "delete", "trigger_1", "--confirm"]);
      expect(requests[3]).toEqual({
        method: "DELETE",
        path: "/v1/orgs/org_1/triggers/trigger_1",
        query: "",
        body: null,
        token: "test-token",
      });
      expect(outputs[3]?.value).toEqual({ status: "ok" });
    });
  });

  test("rejects invalid events, watch fields, predicates, mappings and controls before HTTP", async () => {
    await fixture(
      async ({ parse, requests, outputs, mappingPath, directory }) => {
        const literalPath = join(directory, "literal.json");
        writeFileSync(
          literalPath,
          JSON.stringify({ event: { kind: "metadata", key: "event" } }),
        );
        for (const events of [
          "",
          "update,",
          "Update",
          "create,create",
          "exec",
          "create,update,delete,update",
        ]) {
          await expect(
            parse([...createArgs(literalPath), "--events", events]),
          ).rejects.toThrow("Invalid trigger definition");
        }
        for (const fields of ["", "title,title", "title,", "bad.field"]) {
          await expect(
            parse([...createArgs(mappingPath), "--watch-fields", fields]),
          ).rejects.toThrow("Invalid trigger definition");
        }
        for (const events of ["create", "delete", "create,delete"]) {
          await expect(
            parse([
              ...createArgs(literalPath),
              "--events",
              events,
              "--watch-fields",
              "title",
            ]),
          ).rejects.toThrow("Invalid trigger definition");
        }
        // before/create and after/delete mappings are rejected, even without watches.
        for (const events of ["create", "delete", "create,delete"]) {
          await expect(
            parse([...createArgs(mappingPath), "--events", events]),
          ).rejects.toThrow("Invalid trigger definition");
        }
        for (const value of [
          null,
          [],
          { kind: "sql", value: "private-invalid-value" },
          { title: { kind: "after", field: "title", extra: true } },
          { title: { kind: "metadata", key: "secret" } },
          { title: { kind: "literal", value: {}, extra: true } },
        ]) {
          writeFileSync(literalPath, JSON.stringify(value));
          await expect(parse(createArgs(literalPath))).rejects.toThrow(
            "Invalid trigger definition",
          );
        }
        for (const predicate of [
          "null",
          "[]",
          '{"title":{"sql":"private-invalid-value"}}',
        ]) {
          await expect(
            parse([...createArgs(mappingPath), "--where", predicate]),
          ).rejects.toThrow("Invalid trigger definition");
        }
        await expect(
          parse([
            ...createArgs(mappingPath),
            "--where",
            "{private-invalid-value",
          ]),
        ).rejects.toThrow("must be valid JSON");
        await expect(
          parse([
            ...createArgs(mappingPath),
            "--where",
            "{}",
            "--where-file",
            "missing",
          ]),
        ).rejects.toThrow("only one");
        await expect(
          parse([...createArgs(mappingPath), "--enabled", "true"]),
        ).rejects.toThrow("on or off");
        await expect(
          parse([...createArgs(mappingPath), "--queue", "bad/name"]),
        ).rejects.toThrow("Invalid trigger definition");
        await expect(parse(["triggers", "create"])).rejects.toThrow(
          "Invalid trigger definition",
        );
        await expect(
          parse(["triggers", "update", "trigger_1"]),
        ).rejects.toThrow("Invalid trigger definition");
        for (const events of ["create,create", "unknown"]) {
          await expect(
            parse(["triggers", "update", "trigger_1", "--events", events]),
          ).rejects.toThrow("Invalid trigger definition");
        }
        for (const limit of ["0", "101", "1.1", "1e2", "-1"]) {
          await expect(
            parse(["triggers", "list", "--limit", limit]),
          ).rejects.toThrow("limit from 1 to 100");
        }
        await expect(
          parse(["triggers", "list", "--cursor", ""]),
        ).rejects.toThrow("nonempty cursor");
        for (const id of ["", "x".repeat(129)]) {
          await expect(parse(["triggers", "show", id])).rejects.toThrow(
            "Invalid trigger ID",
          );
        }
        expect(requests).toHaveLength(0);
        expect(outputs).toHaveLength(0);
      },
    );
  });

  test("reports missing, malformed and non-UTF8 files without leaking input", async () => {
    await fixture(async ({ parse, requests, directory, mappingPath }) => {
      const badPath = join(directory, "bad.json");
      for (const flag of ["--mapping-file", "--where-file"]) {
        await expect(
          parse([...createArgs(mappingPath), flag, badPath]),
        ).rejects.toThrow(`Could not read ${flag}`);
        writeFileSync(badPath, "{private-invalid-value");
        const error = await parse([
          ...createArgs(mappingPath),
          flag,
          badPath,
        ]).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(CliError);
        expect((error as Error).message).not.toContain("private-invalid-value");
        writeFileSync(badPath, Buffer.from([0xff]));
        await expect(
          parse([...createArgs(mappingPath), flag, badPath]),
        ).rejects.toThrow("valid UTF-8");
        rmSync(badPath);
      }
      expect(requests).toHaveLength(0);
    });
  });

  test("propagates API and merged-state errors without output or retries", async () => {
    await fixture(
      async ({ parse, requests, outputs, respond, mappingPath }) => {
        const actions = [
          createArgs(mappingPath),
          ["triggers", "list"],
          ["triggers", "show", "trigger_1"],
          ["triggers", "update", "trigger_1", "--events", "create"],
          ["triggers", "pause", "trigger_1"],
          ["triggers", "resume", "trigger_1"],
          ["triggers", "delete", "trigger_1", "--confirm"],
        ];
        for (const [index, args] of actions.entries()) {
          const status = [400, 403, 404, 409, 500, 403, 404][index]!;
          respond(
            Response.json(
              { status: "error", message: `Trigger failed (${status}).` },
              { status },
            ),
          );
          await expect(parse(args)).rejects.toThrow(
            `Trigger failed (${status}).`,
          );
        }
        respond(
          Response.json(
            { status: "error", message: "no session" },
            { status: 401 },
          ),
        );
        await expect(
          parse(["triggers", "show", "trigger_1"]),
        ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
        respond(Response.json({ status: "error", message: "error envelope" }));
        await expect(parse(["triggers", "show", "trigger_1"])).rejects.toThrow(
          "error envelope",
        );
        respond(new Response("invalid JSON"));
        await expect(parse(["triggers", "show", "trigger_1"])).rejects.toThrow(
          "invalid JSON response",
        );
        expect(requests).toHaveLength(actions.length + 3);
        expect(outputs).toHaveLength(0);
      },
    );
  });

  test("turns real connection refusal into a CLI error", async () => {
    const program = createProgram([]).exitOverride();
    registerTriggers(program, {
      getOrgClient: () => ({
        client: createApiClient("http://127.0.0.1:1", "token"),
        config: { server: "http://127.0.0.1:1" },
        orgId: "org_1",
      }),
      handleResponse,
      writeOutput: () => {
        throw new Error("should not output");
      },
    });
    await expect(
      program.parseAsync(["triggers", "show", "trigger_1"], { from: "user" }),
    ).rejects.toThrow("Could not connect to The Last SaaS server");
  });
});
