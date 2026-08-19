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
