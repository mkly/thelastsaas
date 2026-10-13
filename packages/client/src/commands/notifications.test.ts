import { describe, expect, test } from "bun:test";
import { Command } from "commander";

import {
  registerNotifications,
  type NotificationsCommandDependencies,
} from "./notifications";

function testProgram(): Command {
  return new Command().exitOverride().option("--org <org-id>").option("--json");
}

function dependencies(client: Record<string, unknown>) {
  const outputs: Array<{ value: unknown; human?: string }> = [];
  const deps: NotificationsCommandDependencies = {
    getOrgClient: () => ({
      client: client as never,
      config: {} as never,
      orgId: "org_123",
    }),
    handleResponse: async (response) => response as never,
    writeOutput: (value, _options, human) => outputs.push({ value, human }),
    parseJson: <T>(value: string) => JSON.parse(value) as T,
  };
  return { deps, outputs };
}

describe("notification commands", () => {
  test("notify sends immediate, one-time and recurring team notifications", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const post = async (input: Record<string, unknown>) => {
      calls.push(input);
      return {
        status: "ok",
        kind: "immediate",
        id: null,
        ids: ["a", "b"],
        queued_count: 2,
        skipped_count: 1,
        message: "Notification queued",
      };
    };
    const { deps, outputs } = dependencies({
      v1: {
        orgs: {
          ":orgId": {
            notifications: {
              notify: { $post: post },
            },
          },
        },
      },
    });
    const commands = [
      [
        "--subject",
        "Team",
        "--to",
        "alice@example.com",
        "--to",
        "user_b",
        "--dedupe-key",
        "request-1",
      ],
      ["--at", "2026-10-11T09:00:00Z", "--subject", "All hands", "--to-all"],
      [
        "--recurrence",
        "DTSTART;TZID=UTC:20261011T090000\nRRULE:FREQ=DAILY",
        "--subject",
        "Standup",
        "--to-role",
        "engineering",
        "--to-role",
        "support",
      ],
    ];
    for (const command of commands) {
      const program = testProgram();
      registerNotifications(program, deps);
      await program.parseAsync(["notify", ...command], { from: "user" });
    }
    expect(
      calls.map((call) => (call.json as Record<string, unknown>).audience),
    ).toEqual([
      { kind: "users", users: ["alice@example.com", "user_b"] },
      { kind: "all" },
      { kind: "roles", roles: ["engineering", "support"] },
    ]);
    expect((calls[0]!.json as Record<string, unknown>).dedupe_key).toBe(
      "request-1",
    );
    expect((calls[1]!.json as Record<string, unknown>).timing).toEqual({
      kind: "once",
      at: "2026-10-11T09:00:00Z",
    });
    expect((calls[2]!.json as Record<string, unknown>).timing).toEqual({
      kind: "recurring",
      recurrence: "DTSTART;TZID=UTC:20261011T090000\nRRULE:FREQ=DAILY",
    });
    expect(outputs[0]?.human).toBe(
      "Notification queued: 2 recipients, 1 skipped",
    );
  });

  test("mixed audience selectors fail before sending a request", async () => {
    let requested = false;
    const { deps } = dependencies({
      v1: {
        orgs: {
          ":orgId": {
            notifications: {
              notify: {
                $post: async () => {
                  requested = true;
                },
              },
            },
          },
        },
      },
    });
    const program = testProgram();
    registerNotifications(program, deps);
    await expect(
      program.parseAsync(
        ["notify", "--subject", "Team", "--to", "user_a", "--to-all"],
        { from: "user" },
      ),
    ).rejects.toThrow("Choose one audience");
    expect(requested).toBe(false);
  });

  test("lists unread notifications and marks one read", async () => {
    const listCalls: unknown[] = [];
    const readCalls: unknown[] = [];
    const client = {
      v1: {
        orgs: {
          ":orgId": {
            notifications: {
              $get: async (input: unknown) => {
                listCalls.push(input);
                return {
                  status: "ok",
                  notifications: [
                    {
                      id: "notification_1",
                      type: "build",
                      message: "Build passed",
                      data: null,
                      read: false,
                      created_at: "2026-08-18T00:00:00.000Z",
                    },
                  ],
                };
              },
              ":id": {
                $patch: async (input: unknown) => {
                  readCalls.push(input);
                  return { status: "ok", read: true };
                },
              },
            },
          },
        },
      },
    };
    const { deps, outputs } = dependencies(client);
    const listProgram = testProgram();
    registerNotifications(listProgram, deps);
    await listProgram.parseAsync(["notifications", "list", "--unread"], {
      from: "user",
    });

    const readProgram = testProgram();
    registerNotifications(readProgram, deps);
    await readProgram.parseAsync(["notifications", "read", "notification_1"], {
      from: "user",
    });

    expect(listCalls).toEqual([
      { param: { orgId: "org_123" }, query: { unread: "true" } },
    ]);
    expect(readCalls).toEqual([
      {
        param: { orgId: "org_123", id: "notification_1" },
        json: { read: true },
      },
    ]);
    expect(outputs[0]?.human).toContain("Build passed");
  });

  test("rejects conflicting timing before sending a request", async () => {
    const { deps } = dependencies({});
    const program = testProgram();
    registerNotifications(program, deps);
    await expect(
      program.parseAsync(
        [
          "notify",
          "--subject",
          "Reminder",
          "--at",
          "2030-01-01T00:00:00Z",
          "--recurrence",
          "DTSTART:20300101T000000Z\nRRULE:FREQ=DAILY",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow("Choose either");
  });
});
