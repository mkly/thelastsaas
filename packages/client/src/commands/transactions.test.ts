import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { AUTOMATION_LIMITS } from "@lastsaas/shared";
import { createApiClient, handleResponse } from "../api-client";
import { CliError, ReauthenticationRequiredError } from "../errors";
import { createProgram } from "../index";
import {
  readTransactionInput,
  readTransactionStream,
  registerTransactions,
  type TransactionsCommandDependencies,
} from "./transactions";

const operations = [
  { op: "record.create", collection: "tasks", data: { title: "é\n" } },
  {
    op: "record.update",
    collection: "tasks",
    id: "literal_id",
    data: { title: "$results[0].record.id" },
  },
  { op: "record.delete", collection: "tasks", id: "literal_delete_id" },
  {
    op: "queue.enqueue",
    queue: "jobs",
    entry: { payload: { task_id: "literal_id" } },
  },
];
const result = {
  status: "ok",
  results: [
    { op: "record.create", record: { id: "new_id", data: { title: "é\n" } } },
    { op: "record.update", record: { id: "literal_id" } },
    { op: "record.delete", id: "literal_delete_id" },
    { op: "queue.enqueue", result: { entries: [], delivery_count: 1 } },
  ],
};

async function fixture(
  run: (context: {
    parse(args: string[]): Promise<void>;
    deps: TransactionsCommandDependencies;
    requests: Array<{
      method: string;
      path: string;
      body: unknown;
      auth: string | null;
    }>;
    outputs: Array<{
      value: unknown;
      options: { json?: boolean };
      human?: string;
    }>;
    respond(response: Response): void;
  }) => Promise<void>,
) {
  const requests: Array<{
    method: string;
    path: string;
    body: unknown;
    auth: string | null;
  }> = [];
  const outputs: Array<{
    value: unknown;
    options: { json?: boolean };
    human?: string;
  }> = [];
  let response = Response.json(result);
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: await request.json(),
        auth: request.headers.get("x-api-key"),
      });
      return response.clone();
    },
  });
  const deps: TransactionsCommandDependencies = {
    getOrgClient: (options) => ({
      client: createApiClient(
        server.url.href,
        options?.token ?? "token",
        "api-token",
      ),
      config: { server: server.url.href },
      orgId: options?.org ?? "org_default",
    }),
    handleResponse,
    writeOutput: (value, options = {}, human) => {
      outputs.push({ value, options, human });
    },
    readInput: (options) =>
      options.stdin
        ? readTransactionStream(
            Readable.from([Buffer.from(JSON.stringify({ operations }))]),
          )
        : readTransactionInput(options),
  };
  try {
    await run({
      requests,
      outputs,
      deps,
      respond: (value) => {
        response = value;
      },
      parse: async (args) => {
        const program = createProgram([])
          .exitOverride()
          .configureOutput({ writeErr: () => {} });
        registerTransactions(program, deps);
        await program.parseAsync(
          ["--org", "org_1", "--token", "test-token", ...args],
          { from: "user" },
        );
      },
    });
  } finally {
    server.stop(true);
  }
}

describe("transaction CLI", () => {
  test("is registered with input limits and literal operation help", () => {
    const transactions = createProgram().commands.find(
      (command) => command.name() === "transactions",
    )!;
    expect(transactions.commands.map((command) => command.name())).toEqual([
      "execute",
    ]);
    let help = "";
    const execute = transactions.commands[0]!;
    execute.configureOutput({
      writeOut: (text) => {
        help += text;
      },
    });
    execute.outputHelp();
    expect(help).toContain("1 MiB");
    expect(help).toContain("1..25");
    expect(help).toContain("results cannot be referenced");
    expect(help).toContain("--stdin");
  });

  test("submits a real file as one typed request and preserves ordered results", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saas-transactions-"));
    const path = join(directory, "request.json");
    writeFileSync(path, JSON.stringify({ operations }, null, 2));
    try {
      await fixture(async ({ parse, requests, outputs }) => {
        await parse([
          "--json",
          "transactions",
          "execute",
          "--input",
          path,
          "--idempotency-key",
          "batch-1",
        ]);
        expect(requests).toEqual([
          {
            method: "POST",
            path: "/v1/orgs/org_1/transactions",
            body: { operations, idempotency_key: "batch-1" },
            auth: "test-token",
          },
        ]);
        expect(outputs).toEqual([
          {
            value: result,
            options: expect.objectContaining({ json: true }),
            human: undefined,
          },
        ]);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("submits stdin without a key and emits the full response in default output", async () => {
    await fixture(async ({ parse, requests, outputs }) => {
      await parse(["transactions", "execute", "--stdin"]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toEqual({ operations });
      expect(outputs[0]?.value).toEqual(result);
      expect(outputs[0]?.human).toBeUndefined();
    });
  });

  test("preserves an input key, accepts a matching flag, rejects conflicting keys", async () => {
    await fixture(async ({ parse, deps, requests }) => {
      deps.readInput = async () =>
        JSON.stringify({ operations, idempotency_key: "  exact key  " });
      await parse(["transactions", "execute", "--stdin"]);
      await parse([
        "transactions",
        "execute",
        "--stdin",
        "--idempotency-key",
        "  exact key  ",
      ]);
      for (const request of requests)
        expect(request.body).toEqual({
          operations,
          idempotency_key: "  exact key  ",
        });
      await expect(
        parse([
          "transactions",
          "execute",
          "--stdin",
          "--idempotency-key",
          "other",
        ]),
      ).rejects.toThrow("conflicts");
      expect(requests).toHaveLength(2);
    });
  });

  test("rejects missing/conflicting input before reading or making requests", async () => {
    await fixture(async ({ parse, deps, requests }) => {
      deps.readInput = async () => {
        throw new Error("should not read");
      };
      for (const args of [[], ["--stdin", "--input", "unused"]]) {
        await expect(
          parse(["transactions", "execute", ...args]),
        ).rejects.toThrow("exactly one");
      }
      expect(requests).toHaveLength(0);
    });
  });

  test("rejects malformed envelopes and operations before HTTP without echoing payloads", async () => {
    await fixture(async ({ parse, deps, requests, outputs }) => {
      const privateValue = "private-invalid-value";
      for (const value of [
        null,
        [],
        operations,
        { operations: [] },
        { operations: Array(26).fill(operations[2]) },
        { operations, extra: privateValue },
        { operations, organization_id: "foreign" },
        { operations: [{ op: "sql", sql: privateValue }] },
        { operations: [{ ...operations[2], id: { result: 0 } }] },
        {
          operations: [{ op: "record.update", collection: "tasks", data: {} }],
        },
        {
          operations: [
            {
              op: "queue.enqueue",
              queue: "jobs",
              entry: { payload: { text: "é".repeat(32769) } },
            },
          ],
        },
        { operations, idempotency_key: "" },
        { operations, idempotency_key: "k".repeat(257) },
      ]) {
        deps.readInput = async () => JSON.stringify(value);
        await expect(
          parse(["transactions", "execute", "--stdin"]),
        ).rejects.toThrow("Invalid transaction request");
      }
      deps.readInput = async () => `{${privateValue}`;
      await expect(
        parse(["transactions", "execute", "--stdin"]),
      ).rejects.toThrow("must be valid JSON");
      for (const key of ["", "k".repeat(257)]) {
        deps.readInput = async () => JSON.stringify({ operations });
        await expect(
          parse([
            "transactions",
            "execute",
            "--stdin",
            "--idempotency-key",
            key,
          ]),
        ).rejects.toThrow("Invalid transaction request");
      }
      expect(requests).toHaveLength(0);
      expect(outputs).toHaveLength(0);
    });
  });

  test("allows 25 operations without splitting or chaining requests", async () => {
    await fixture(async ({ parse, deps, requests }) => {
      const batch = Array(25).fill(operations[2]);
      deps.readInput = async () => JSON.stringify({ operations: batch });
      await parse(["transactions", "execute", "--stdin"]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toEqual({ operations: batch });
    });
  });

  test("enforces raw and final request byte limits, including added key overhead", async () => {
    await fixture(async ({ parse, deps, requests }) => {
      const base = JSON.stringify({
        operations: [
          { op: "record.create", collection: "tasks", data: { text: "" } },
        ],
      });
      const boundary = base.replace(
        '"text":""',
        `"text":"${"a".repeat(AUTOMATION_LIMITS.transactionBytes - Buffer.byteLength(base))}"`,
      );
      expect(Buffer.byteLength(boundary)).toBe(
        AUTOMATION_LIMITS.transactionBytes,
      );
      deps.readInput = async () => boundary;
      await parse(["transactions", "execute", "--stdin"]);
      await expect(
        parse([
          "transactions",
          "execute",
          "--stdin",
          "--idempotency-key",
          "key",
        ]),
      ).rejects.toThrow("Invalid transaction request");
      deps.readInput = async () => boundary + " ";
      await expect(
        parse(["transactions", "execute", "--stdin"]),
      ).rejects.toThrow("exceeds 1 MiB");
      expect(requests).toHaveLength(1);
    });
  });

  test("propagates server failures with no output, retry or partial fallback", async () => {
    await fixture(async ({ parse, requests, outputs, respond }) => {
      for (const status of [400, 403, 404, 409, 413, 500]) {
        respond(
          Response.json(
            {
              status: "error",
              error: "Failure",
              message: `Transaction failed (${status}).`,
            },
            { status },
          ),
        );
        await expect(
          parse(["transactions", "execute", "--stdin"]),
        ).rejects.toThrow(`Transaction failed (${status}).`);
      }
      respond(
        Response.json(
          { status: "error", message: "no session" },
          { status: 401 },
        ),
      );
      await expect(
        parse(["transactions", "execute", "--stdin"]),
      ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
      respond(Response.json({ status: "error", message: "error envelope" }));
      await expect(
        parse(["transactions", "execute", "--stdin"]),
      ).rejects.toThrow("error envelope");
      respond(new Response("invalid JSON"));
      await expect(
        parse(["transactions", "execute", "--stdin"]),
      ).rejects.toThrow("invalid JSON response");
      expect(requests).toHaveLength(9);
      expect(outputs).toHaveLength(0);
    });
  });

  test("converts connection failures to CLI errors", async () => {
    await fixture(async ({ parse, deps }) => {
      deps.getOrgClient = () => ({
        client: createApiClient("http://127.0.0.1:1", "token"),
        config: { server: "http://127.0.0.1:1" },
        orgId: "org_1",
      });
      await expect(
        parse(["transactions", "execute", "--stdin"]),
      ).rejects.toBeInstanceOf(CliError);
    });
  });
});

describe("transaction input", () => {
  test("decodes split Unicode bytes and accepts exactly the raw byte limit", async () => {
    const bytes = Buffer.from(JSON.stringify({ operations }));
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    expect(
      await readTransactionStream(
        Readable.from([bytes.subarray(0, split), bytes.subarray(split)]),
      ),
    ).toBe(bytes.toString());
    expect(
      (
        await readTransactionStream(
          Readable.from([Buffer.alloc(AUTOMATION_LIMITS.transactionBytes, 32)]),
        )
      ).length,
    ).toBe(AUTOMATION_LIMITS.transactionBytes);
  });

  test("stops reading oversized streams and rejects invalid UTF-8 and read errors", async () => {
    const stream = Readable.from([
      Buffer.alloc(AUTOMATION_LIMITS.transactionBytes, 32),
      Buffer.from(" "),
      Buffer.from("unused"),
    ]);
    await expect(readTransactionStream(stream)).rejects.toThrow(
      "exceeds 1 MiB",
    );
    expect(stream.destroyed).toBe(true);
    await expect(
      readTransactionStream(Readable.from([Buffer.from([0xff])])),
    ).rejects.toThrow("valid UTF-8");
    await expect(
      readTransactionStream(Readable.from([Buffer.from([0xc3])])),
    ).rejects.toThrow("valid UTF-8");
    const broken = new Readable({
      read() {
        this.destroy(new Error("private read error"));
      },
    });
    await expect(readTransactionStream(broken)).rejects.toThrow(
      "Could not read transaction input",
    );
  });

  test("rejects missing files and invalid or oversized actual files before HTTP", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saas-transactions-bad-"));
    const path = join(directory, "request.json");
    try {
      await fixture(async ({ parse, requests }) => {
        await expect(
          parse([
            "transactions",
            "execute",
            "--input",
            join(directory, "missing.json"),
          ]),
        ).rejects.toThrow("Could not read transaction input");
        writeFileSync(path, Buffer.from([0xff]));
        await expect(
          parse(["transactions", "execute", "--input", path]),
        ).rejects.toThrow("valid UTF-8");
        writeFileSync(path, " ".repeat(AUTOMATION_LIMITS.transactionBytes + 1));
        await expect(
          parse(["transactions", "execute", "--input", path]),
        ).rejects.toThrow("exceeds 1 MiB");
        expect(requests).toHaveLength(0);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reads actual piped stdin", async () => {
    const modulePath = join(import.meta.dir, "transactions.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { readTransactionInput } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await readTransactionInput({ stdin: true })));`,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const text = JSON.stringify({ operations }, null, 2);
    child.stdin.write(text);
    child.stdin.end();
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toBe(text);
    expect(await new Response(child.stderr).text()).toBe("");
  });
});
