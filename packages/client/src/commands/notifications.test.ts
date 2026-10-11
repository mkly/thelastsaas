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
  test("queue and both schedule commands send team audiences", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const post = async (input: Record<string, unknown>) => {
      calls.push(input);
      return {
        status: "ok",
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
              queue: { $post: post },
              schedules: { $post: post },
            },
          },
        },
      },
    });
    const commands = [
      [
        "queue",
        "--subject",
        "Team",
        "--to",
        "alice@example.com",
        "--to",
        "user_b",
        "--dedupe-key",
        "request-1",
      ],
      [
        "schedules",
        "once",
        "--at",
        "2026-10-11T09:00:00Z",
        "--message",
        "All hands",
        "--to-all",
      ],
      [
        "schedules",
        "recurring",
        "--recurrence",
        "DTSTART;TZID=UTC:20261011T090000\nRRULE:FREQ=DAILY",
        "--message",
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
      await program.parseAsync(["notifications", ...command], { from: "user" });
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
    expect(outputs[0]?.human).toBe("Notification queued: 2 queued, 1 skipped");
  });

  test("mixed audience selectors fail before sending a request", async () => {
    let requested = false;
    const { deps } = dependencies({
      v1: {
        orgs: {
          ":orgId": {
            notifications: {
              queue: {
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
        [
          "notifications",
          "queue",
          "--subject",
          "Team",
          "--to",
          "user_a",
          "--to-all",
        ],
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

  test("creates one-shot and recurring schedules", async () => {
    const scheduleCalls: Array<Record<string, unknown>> = [];
    const client = {
      v1: {
        orgs: {
          ":orgId": {
            notifications: {
              schedules: {
                $post: async (input: Record<string, unknown>) => {
                  scheduleCalls.push(input);
                  return {
                    status: "ok",
                    id: `schedule_${scheduleCalls.length}`,
                  };
                },
              },
            },
          },
        },
      },
    };
    const { deps, outputs } = dependencies(client);

    const onceProgram = testProgram();
    registerNotifications(onceProgram, deps);
    await onceProgram.parseAsync(
      [
        "notifications",
        "schedules",
        "once",
        "--at",
        "2026-08-20T09:00:00Z",
        "--message",
        "Deploy now",
        "--data",
        '{"release":"v1"}',
      ],
      { from: "user" },
    );

    const recurringProgram = testProgram();
    registerNotifications(recurringProgram, deps);
    await recurringProgram.parseAsync(
      [
        "notifications",
        "schedules",
        "recurring",
        "--recurrence",
        "DTSTART;TZID=America/Los_Angeles:20260820T090000\\nRRULE:FREQ=WEEKLY",
        "--message",
        "Weekly report",
        "--in-app",
        "off",
      ],
      { from: "user" },
    );

    expect(scheduleCalls).toEqual([
      {
        param: { orgId: "org_123" },
        json: {
          message: "Deploy now",
          type: "direct_notification",
          data: { release: "v1" },
          deliver_at: "2026-08-20T09:00:00Z",
        },
      },
      {
        param: { orgId: "org_123" },
        json: {
          message: "Weekly report",
          type: "direct_notification",
          in_app: false,
          recurrence:
            "DTSTART;TZID=America/Los_Angeles:20260820T090000\\nRRULE:FREQ=WEEKLY",
        },
      },
    ]);
    expect(outputs.map((output) => output.human)).toEqual([
      "Scheduled one-shot notification schedule_1",
      "Scheduled recurring notification schedule_2",
    ]);
  });
});
