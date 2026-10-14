import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApiClient, handleResponse } from "../api-client";
import { createProgram } from "../index";
import { registerCollections } from "./collections";
import type { DataCommandDependencies } from "./data-client";
import { registerRecords } from "./records";

interface CapturedOutput {
  value: unknown;
  options: { json?: boolean };
  human?: string;
}

const originalFetch = globalThis.fetch;
const requests: Request[] = [];
const responseBodies: unknown[] = [];
const outputs: CapturedOutput[] = [];
let requestedOrg: string | undefined;

const dependencies: DataCommandDependencies = {
  getOrgClient(options) {
    requestedOrg = options?.org;
    const config = {
      server: "https://api.example.test",
      session_token: "session-token",
    };
    return {
      client: createApiClient(config.server, config.session_token),
      config,
      orgId: options?.org ?? "org_default",
    };
  },
  handleResponse,
  writeOutput(value, options = {}, human) {
    outputs.push({ value, options, human });
  },
};

beforeEach(() => {
  requests.length = 0;
  responseBodies.length = 0;
  outputs.length = 0;
  requestedOrg = undefined;
  globalThis.fetch = (async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json(responseBodies.shift() ?? { status: "ok" });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("data command registration", () => {
  test("registers data families without restoring dropped verticals", () => {
    const program = createProgram();
    const rootNames = program.commands.map((command) => command.name());

    expect(rootNames).toContain("collections");
    expect(rootNames).toContain("records");
    for (const dropped of ["events", "forms", "pages", "tags", "folders"]) {
      expect(rootNames).not.toContain(dropped);
    }
    expect(
      program.commands
        .find((command) => command.name() === "collections")
        ?.alias(),
    ).toBe("c");
    expect(
      program.commands.find((command) => command.name() === "records")?.alias(),
    ).toBe("r");
    expect(
      program.commands
        .find((command) => command.name() === "collections")
        ?.commands.map((command) => command.name()),
    ).toEqual(["list", "create", "describe", "update-schema", "delete"]);
    expect(
      program.commands
        .find((command) => command.name() === "records")
        ?.commands.map((command) => command.name()),
    ).toEqual([
      "related",
      "history",
      "insert",
      "get",
      "update",
      "delete",
      "query",
      "count",
      "batch",
      "aggregate",
    ]);
  });
});

describe("collection commands", () => {
  test("creates a collection in the selected organization", async () => {
    responseBodies.push({
      status: "ok",
      id: "collection_1",
      name: "contacts",
    });
    const program = createProgram([
      (root) => registerCollections(root, dependencies),
    ]);

    await program.parseAsync([
      "bun",
      "saas",
      "--org",
      "org_alpha",
      "collections",
      "create",
      "contacts",
      "--schema",
      '{"email":"string"}',
      "--description",
      "People",
    ]);

    expect(requestedOrg).toBe("org_alpha");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/v1/orgs/org_alpha/collections",
    );
    expect(await requests[0]?.json()).toEqual({
      name: "contacts",
      schema: { email: "string" },
      description: "People",
    });
    expect(outputs[0]?.human).toBe(
      "Created collection 'contacts' (collection_1)",
    );
  });

  test("sends schema patches with add, remove, and update operations", async () => {
    responseBodies.push({ status: "ok", name: "contacts" });
    const program = createProgram([
      (root) => registerCollections(root, dependencies),
    ]);

    await program.parseAsync([
      "bun",
      "saas",
      "collections",
      "update-schema",
      "contacts",
      "--add",
      '{"phone":"string"}',
      "--remove",
      "nickname, legacy_id",
      "--update",
      '{"email":{"description":"Primary email"}}',
    ]);

    expect(requests[0]?.method).toBe("PATCH");
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/v1/orgs/org_default/collections/contacts/schema",
    );
    expect(await requests[0]?.json()).toEqual({
      add_fields: { phone: "string" },
      remove_fields: ["nickname", "legacy_id"],
      update_fields: { email: { description: "Primary email" } },
    });
  });
});

describe("record commands", () => {
  test("queries collection and record history with shared filters and preserves the response", async () => {
    const result = {
      status: "ok",
      items: [
        {
          id: "history_1",
          record_id: "record_1",
          operation: "delete",
          before: { title: "Old" },
          after: null,
        },
      ],
      next_cursor: "next",
    };
    responseBodies.push(result);
    const program = createProgram([
      (root) => registerRecords(root, dependencies),
    ]);
    await program.parseAsync([
      "bun",
      "saas",
      "--json",
      "--org",
      "org_alpha",
      "records",
      "history",
      "tasks",
      "record_1",
      "--since",
      "2026-10-01T00:00:00Z",
      "--until",
      "2026-10-14T00:00:00Z",
      "--change-set-id",
      "change_1",
      "--limit",
      "2",
      "--cursor",
      "current",
    ]);
    const url = new URL(requests[0]!.url);
    expect(url.pathname).toBe("/v1/orgs/org_alpha/collections/tasks/history");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      record_id: "record_1",
      since: "2026-10-01T00:00:00Z",
      until: "2026-10-14T00:00:00Z",
      change_set_id: "change_1",
      limit: "2",
      cursor: "current",
    });
    expect(outputs[0]).toMatchObject({
      value: result,
      options: { json: true },
    });
    await createProgram([
      (root) => registerRecords(root, dependencies),
    ]).parseAsync(["bun", "saas", "records", "history", "tasks"]);
    expect(new URL(requests[1]!.url).searchParams.has("record_id")).toBe(false);
  });

  test("rejects invalid history bounds locally and reports server cursor errors", async () => {
    const args = ["bun", "saas", "records", "history", "tasks"];
    const run = (...extra: string[]) =>
      createProgram([(root) => registerRecords(root, dependencies)]).parseAsync(
        [...args, ...extra],
      );
    await expect(run("--limit", "101")).rejects.toThrow();
    await expect(
      run("--since", "2026-10-14T00:00:00Z", "--until", "2026-10-01T00:00:00Z"),
    ).rejects.toThrow("since must be before until");
    expect(requests).toHaveLength(0);
    responseBodies.push({
      status: "error",
      error: "InvalidQueryError",
      message: "Invalid query",
    });
    await expect(run("--cursor", "invalid")).rejects.toThrow("Invalid query");
  });

  test("builds an occurs_between query alongside ordinary filters", async () => {
    responseBodies.push({ status: "ok", records: [], total: 0 });
    const program = createProgram([
      (root) => registerRecords(root, dependencies),
    ]);

    await program.parseAsync([
      "bun",
      "saas",
      "--json",
      "records",
      "query",
      "meetings",
      "--where",
      '{"status":"active"}',
      "--occurs-between",
      "schedule",
      "--from",
      "2026-11-01T00:00:00-07:00",
      "--to",
      "2026-11-02T00:00:00-08:00",
      "--limit",
      "12",
      "--offset",
      "2",
    ]);

    expect(requests[0]?.method).toBe("POST");
    expect(new URL(requests[0]!.url).pathname).toBe(
      "/v1/orgs/org_default/collections/meetings/records/query",
    );
    expect(await requests[0]?.json()).toEqual({
      limit: 12,
      offset: 2,
      where: {
        and: [
          { status: "active" },
          {
            schedule: {
              occurs_between: [
                "2026-11-01T00:00:00-07:00",
                "2026-11-02T00:00:00-08:00",
              ],
            },
          },
        ],
      },
    });
    expect(outputs[0]?.options.json).toBe(true);
  });

  test("posts batch inserts and aggregate requests", async () => {
    responseBodies.push(
      { status: "ok", inserted: 2 },
      { status: "ok", rows: [{ state: "open", total: 2 }] },
    );
    const batchProgram = createProgram([
      (root) => registerRecords(root, dependencies),
    ]);
    await batchProgram.parseAsync([
      "bun",
      "saas",
      "records",
      "batch",
      "tickets",
      "--data",
      '[{"state":"open"},{"state":"closed"}]',
    ]);

    const aggregateProgram = createProgram([
      (root) => registerRecords(root, dependencies),
    ]);
    await aggregateProgram.parseAsync([
      "bun",
      "saas",
      "records",
      "aggregate",
      "tickets",
      "--group-by",
      "state",
      "--metrics",
      '[{"op":"count","as":"total"}]',
    ]);

    expect(await requests[0]?.json()).toEqual({
      records: [{ state: "open" }, { state: "closed" }],
    });
    expect(await requests[1]?.json()).toEqual({
      metrics: [{ op: "count", as: "total" }],
      limit: 100,
      offset: 0,
      group_by: ["state"],
    });
  });
});

test("record relationship commands serialize expansion and reverse queries", async () => {
  const program = createProgram([
    (root) => registerRecords(root, dependencies),
  ]);
  await program.parseAsync(
    [
      "records",
      "get",
      "contacts",
      "ada",
      "--expand",
      "company.parent,partners",
    ],
    { from: "user" },
  );
  expect(new URL(requests[0]!.url).searchParams.get("expand")).toBe(
    "company.parent,partners",
  );
  await program.parseAsync(
    [
      "records",
      "related",
      "companies",
      "acme",
      "--source",
      "contacts",
      "--field",
      "company",
      "--where",
      '{"name":"Ada"}',
      "--order-by",
      "-name",
      "--expand",
      "company",
    ],
    { from: "user" },
  );
  expect(new URL(requests[1]!.url).pathname).toEndWith(
    "/collections/companies/records/acme/related",
  );
  expect(await requests[1]!.json()).toEqual({
    source_collection: "contacts",
    field: "company",
    where: { name: "Ada" },
    order_by: "-name",
    expand: ["company"],
    limit: 50,
    offset: 0,
  });
});
