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
