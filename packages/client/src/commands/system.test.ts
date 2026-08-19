import { describe, expect, test } from "bun:test";
import { Command } from "commander";

import {
  registerSystemCommands,
  type SystemCommandDependencies,
} from "./system";

function testProgram(): Command {
  return new Command().exitOverride().option("--org <org-id>").option("--json");
}

function dependencies(client: Record<string, unknown>) {
  const outputs: Array<{ value: unknown; human?: string }> = [];
  const writes: Array<{ path: string; content: string }> = [];
  const deps: SystemCommandDependencies = {
    getOrgClient: () => ({
      client: client as never,
      config: {} as never,
      orgId: "org_123",
    }),
    handleResponse: async (response) => response as never,
    writeOutput: (value, _options, human) => outputs.push({ value, human }),
    readTextFile: () => '{"version":1,"collections":[]}',
    writeTextFile: (path, content) => writes.push({ path, content }),
    exists: (path) => path === "dump.json",
  };
  return { deps, outputs, writes };
}

describe("system operations commands", () => {
  test("forwards audit filters and renders stats", async () => {
    const auditCalls: unknown[] = [];
    const statsCalls: unknown[] = [];
    const client = {
      v1: {
        orgs: {
          ":orgId": {
            "audit-log": {
              $get: async (input: unknown) => {
                auditCalls.push(input);
                return { status: "ok", entries: [] };
              },
            },
            stats: {
              $get: async (input: unknown) => {
                statsCalls.push(input);
                return {
                  status: "ok",
                  collections: 2,
                  records: 8,
                  files: 3,
                  storage_bytes: 1024,
                };
              },
            },
          },
        },
      },
    };
    const { deps, outputs } = dependencies(client);

    const auditProgram = testProgram();
    registerSystemCommands(auditProgram, deps);
    await auditProgram.parseAsync(
      [
        "audit",
        "--limit",
        "10",
        "--action",
        "create",
        "--resource-type",
        "record",
      ],
      { from: "user" },
    );

    const statsProgram = testProgram();
    registerSystemCommands(statsProgram, deps);
    await statsProgram.parseAsync(["stats"], { from: "user" });

    expect(auditCalls).toEqual([
      {
        param: { orgId: "org_123" },
        query: { limit: "10", action: "create", resource_type: "record" },
      },
    ]);
    expect(statsCalls).toEqual([{ param: { orgId: "org_123" } }]);
    expect(outputs[0]?.human).toBe("No audit entries.");
    expect(outputs[1]?.human).toContain("Records:     8");
  });

  test("exports and imports portable JSON dumps", async () => {
    const exportCalls: unknown[] = [];
    const importCalls: unknown[] = [];
    const client = {
      v1: {
        orgs: {
          ":orgId": {
            export: {
              $post: async (input: unknown) => {
                exportCalls.push(input);
                return { status: "ok", version: 1, collections: [] };
              },
            },
            import: {
              $post: async (input: unknown) => {
                importCalls.push(input);
                return {
                  status: "ok",
                  imported_collections: 0,
                  imported_records: 0,
                  imported_files: 0,
                };
              },
            },
          },
        },
      },
    };
    const { deps, writes } = dependencies(client);

    const exportProgram = testProgram();
    registerSystemCommands(exportProgram, deps);
    await exportProgram.parseAsync(["export", "--output", "backup.json"], {
      from: "user",
    });

    const importProgram = testProgram();
    registerSystemCommands(importProgram, deps);
    await importProgram.parseAsync(["import", "dump.json"], { from: "user" });

    expect(exportCalls).toEqual([{ param: { orgId: "org_123" } }]);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!.content)).toEqual({
      status: "ok",
      version: 1,
      collections: [],
    });
    expect(importCalls).toEqual([
      {
        param: { orgId: "org_123" },
        json: { version: 1, collections: [] },
      },
    ]);
  });
});
