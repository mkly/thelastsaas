import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createApiClient } from "../api-client";
import { CliError, ReauthenticationRequiredError } from "../errors";
import { createProgram } from "../index";
import { handleSecretResponse } from "./secret-response";
import {
  readSecretStream,
  readSecretValue,
  registerSecrets,
  type SecretsCommandDependencies,
} from "./secrets";

const metadata = {
  id: "secret_1",
  organization_id: "org_1",
  name: "worker_key",
  key_version: "v1",
  created_at: "2026-10-10T00:00:00.000Z",
  updated_at: "2026-10-10T00:00:00.000Z",
};
const sensitive = "private test value\n";

async function fixture(
  run: (fixture: {
    parse(args: string[]): Promise<void>;
    requests: Array<{
      method: string;
      path: string;
      query: string;
      body: unknown;
      auth: string | null;
    }>;
    outputs: Array<{
      value: unknown;
      options: { json?: boolean };
      human?: string;
    }>;
    deps: SecretsCommandDependencies;
    values: string[];
    respond: (response: Response) => void;
  }) => Promise<void>,
) {
  const requests: Array<{
    method: string;
    path: string;
    query: string;
    body: unknown;
    auth: string | null;
  }> = [];
  const outputs: Array<{
    value: unknown;
    options: { json?: boolean };
    human?: string;
  }> = [];
  const values: string[] = [];
  let response = Response.json({
    status: "ok",
    secret: {
      ...metadata,
      value: sensitive,
      ciphertext: sensitive,
      nonce: sensitive,
      auth_tag: sensitive,
    },
    unexpected: sensitive,
  });
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
        auth: request.headers.get("x-api-key"),
      });
      return response.clone();
    },
  });
  const deps: SecretsCommandDependencies = {
    getOrgClient: (options) => ({
      client: createApiClient(
        server.url.href,
        options?.token ?? "test-api-token",
        "api-token",
      ),
      config: { server: server.url.href },
      orgId: options?.org ?? "org_default",
    }),
    handleResponse: handleSecretResponse,
    readValue: async (options) =>
      options.stdin
        ? readSecretStream(Readable.from([Buffer.from(sensitive)]))
        : readSecretValue(options),
    writeOutput: (value, options = {}, human) => {
      outputs.push({ value, options, human });
    },
    writeValue: (value) => {
      values.push(value);
    },
  };
  try {
    await run({
      requests,
      outputs,
      deps,
      values,
      respond: (value) => {
        response = value;
      },
      parse: async (args) => {
        const program = createProgram([])
          .exitOverride()
          .configureOutput({ writeErr: () => {} });
        registerSecrets(program, deps);
        await program.parseAsync(
          ["--org", "org_1", "--token", "test-api-token", ...args],
          { from: "user" },
        );
      },
    });
  } finally {
    server.stop(true);
  }
}

describe("secret CLI", () => {
  test("is registered and help separates metadata, reveal and encryption keys", () => {
    const secrets = createProgram().commands.find(
      (command) => command.name() === "secrets",
    )!;
    expect(secrets.commands.map((command) => command.name())).toEqual([
      "create",
      "replace",
      "list",
      "show",
      "delete",
      "reveal",
    ]);
    let help = "";
    secrets.configureOutput({
      writeOut: (text) => {
        help += text;
      },
    });
    secrets.outputHelp();
    expect(help).toContain("/secrets/<name>/value");
    expect(help).toContain("server-configured keys");
    expect(help).toContain("not an API token or a secret value");
    expect(help).not.toContain(sensitive);
  });

  test("creates from stdin and replaces from a real file with exact request bodies", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saas-secret-"));
    const path = join(directory, "value.txt");
    writeFileSync(path, sensitive);
    try {
      await fixture(async ({ parse, requests, outputs }) => {
        await parse(["--json", "secrets", "create", "worker_key", "--stdin"]);
        await parse(["secrets", "replace", "worker_key", "--file", path]);
        expect(requests).toEqual([
          {
            method: "POST",
            path: "/v1/orgs/org_1/secrets",
            query: "",
            body: { name: "worker_key", value: sensitive },
            auth: "test-api-token",
          },
          {
            method: "PATCH",
            path: "/v1/orgs/org_1/secrets/worker_key",
            query: "",
            body: { value: sensitive },
            auth: "test-api-token",
          },
        ]);
        expect(outputs[0]?.options.json).toBe(true);
        for (const output of outputs) {
          expect(output.value).toEqual({ status: "ok", secret: metadata });
          expect(JSON.stringify(output)).not.toContain("private test value");
        }
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("list/show project metadata in human and JSON output, with pagination", async () => {
    await fixture(async ({ parse, requests, outputs, respond }) => {
      respond(
        Response.json({
          status: "ok",
          items: [{ ...metadata, value: sensitive, ciphertext: sensitive }],
          next_cursor: "next",
          value: sensitive,
        }),
      );
      await parse([
        "--json",
        "secrets",
        "list",
        "--limit",
        "2",
        "--cursor",
        "opaque+cursor",
      ]);
      expect(requests[0]?.query).toBe("?limit=2&cursor=opaque%2Bcursor");
      expect(outputs[0]?.value).toEqual({
        status: "ok",
        items: [metadata],
        next_cursor: "next",
      });
      respond(
        Response.json({
          status: "ok",
          secret: { ...metadata, value: sensitive, ciphertext: sensitive },
        }),
      );
      await parse(["secrets", "show", "worker_key"]);
      await parse(["--json", "secrets", "show", "worker_key"]);
      expect(requests.slice(1).map((request) => request.method)).toEqual([
        "GET",
        "GET",
      ]);
      expect(JSON.stringify(outputs)).not.toContain("private test value");
      expect(outputs[1]?.human).toContain("Encryption key version: v1");
    });
  });

  test("only explicit reveal prints values, posts an empty body and supports JSON", async () => {
    await fixture(async ({ parse, requests, outputs, values }) => {
      await parse(["secrets", "show", "worker_key"]);
      await parse(["secrets", "reveal", "worker_key"]);
      await parse(["--json", "secrets", "reveal", "worker_key"]);
      expect(JSON.stringify(outputs[0])).not.toContain("private test value");
      // Human reveal writes the value byte-for-byte, with no added newline.
      expect(values).toEqual([sensitive]);
      expect(outputs).toHaveLength(2);
      expect(outputs[1]?.value).toEqual({
        status: "ok",
        secret: { id: metadata.id, name: metadata.name, value: sensitive },
      });
      expect(
        requests
          .slice(1)
          .map(({ method, path, body }) => ({ method, path, body })),
      ).toEqual([
        {
          method: "POST",
          path: "/v1/orgs/org_1/secrets/worker_key/reveal",
          body: {},
        },
        {
          method: "POST",
          path: "/v1/orgs/org_1/secrets/worker_key/reveal",
          body: {},
        },
      ]);
      await expect(
        parse(["secrets", "show", "worker_key", "--reveal"]),
      ).rejects.toThrow();
      expect(requests).toHaveLength(3);
    });
  });

  test("requires deletion confirmation and omits unexpected response fields", async () => {
    await fixture(async ({ parse, requests, outputs }) => {
      await expect(parse(["secrets", "delete", "worker_key"])).rejects.toThrow(
        "--confirm",
      );
      expect(requests).toHaveLength(0);
      await parse(["--json", "secrets", "delete", "worker_key", "--confirm"]);
      expect(requests[0]?.method).toBe("DELETE");
      expect(outputs[0]?.value).toEqual({ status: "ok" });
    });
  });

  test("rejects missing/conflicting input, invalid selectors and oversized values before HTTP", async () => {
    await fixture(async ({ parse, requests, deps }) => {
      for (const args of [
        ["create", "worker_key"],
        ["replace", "worker_key", "--stdin", "--file", "unused"],
        ["create", "../foreign", "--stdin"],
        ["list", "--limit", "0"],
        ["list", "--limit", "101"],
        ["list", "--limit", "1.5"],
        ["list", "--limit", "1e2"],
        ["list", "--cursor", ""],
        ["create", "worker_key", "--file", "/does-not-exist/private-value"],
      ])
        await expect(parse(["secrets", ...args])).rejects.toThrow();
      deps.readValue = async () => "é".repeat(32769);
      await expect(
        parse(["secrets", "create", "worker_key", "--stdin"]),
      ).rejects.toThrow("64 KiB");
      expect(requests).toHaveLength(0);
    });
  });

  test("permission, authentication, unavailable and malformed errors reveal no values", async () => {
    await fixture(async ({ parse, outputs, values, respond }) => {
      for (const [status, expected] of [
        [403, "Secret permission denied"],
        [404, "Secret not found"],
        [409, "Secret name already exists"],
        [503, "Secrets are unavailable"],
        [500, "Secret operation failed"],
      ] as const) {
        respond(
          Response.json({ status: "error", message: sensitive }, { status }),
        );
        await expect(
          parse(["secrets", "reveal", "worker_key"]),
        ).rejects.toThrow(expected);
      }
      respond(
        Response.json({ status: "error", message: sensitive }, { status: 401 }),
      );
      await expect(
        parse(["secrets", "show", "worker_key"]),
      ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
      respond(new Response(sensitive));
      await expect(parse(["secrets", "show", "worker_key"])).rejects.toThrow(
        "Secret operation failed",
      );
      respond(Response.json({ status: "ok", secret: null }));
      await expect(parse(["secrets", "show", "worker_key"])).rejects.toThrow(
        "Secret operation failed",
      );
      expect(outputs).toHaveLength(0);
      expect(values).toHaveLength(0);
    });
  });

  test("unexpected connection and input diagnostics are redacted", async () => {
    await fixture(async ({ parse, deps }) => {
      deps.readValue = async () => {
        throw new Error(sensitive);
      };
      await expect(
        parse(["secrets", "create", "worker_key", "--stdin"]),
      ).rejects.toThrow("Secret operation failed");
      const client = createApiClient("http://127.0.0.1:1", "token");
      deps.getOrgClient = () => ({
        client,
        config: { server: "http://127.0.0.1:1" },
        orgId: "org_1",
      });
      await expect(
        parse(["secrets", "show", "worker_key"]),
      ).rejects.toBeInstanceOf(CliError);
    });
  });
});

describe("secret input", () => {
  test("preserves Unicode, newlines, BOM and empty values", async () => {
    for (const value of ["", "  é\n\r\n", "\ufeffcontent"]) {
      const bytes = Buffer.from(value);
      expect(
        await readSecretStream(
          Readable.from([bytes.subarray(0, 1), bytes.subarray(1)]),
        ),
      ).toBe(value);
    }
    expect(
      (await readSecretStream(Readable.from([Buffer.alloc(65536, 97)]))).length,
    ).toBe(65536);
  });

  test("rejects oversized bytes, invalid UTF-8 and stream errors safely", async () => {
    await expect(
      readSecretStream(Readable.from([Buffer.alloc(65537, 97)])),
    ).rejects.toThrow("64 KiB");
    await expect(
      readSecretStream(Readable.from([Buffer.from([0xff])])),
    ).rejects.toThrow("valid UTF-8");
    const stream = new Readable({
      read() {
        this.destroy(new Error(sensitive));
      },
    });
    await expect(readSecretStream(stream)).rejects.toThrow(
      "Could not read secret input",
    );
  });

  test("reads actual piped stdin without trimming", async () => {
    const modulePath = join(import.meta.dir, "secrets.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { readSecretValue } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await readSecretValue({ stdin: true })));`,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child.stdin.write(sensitive);
    child.stdin.end();
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toBe(sensitive);
    expect(await new Response(child.stderr).text()).toBe("");
  });
});
