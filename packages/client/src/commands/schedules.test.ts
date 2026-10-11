import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueSchedule } from "@lastsaas/shared";
import { createApiClient, handleResponse } from "../api-client";
import { CliError, ReauthenticationRequiredError } from "../errors";
import { createProgram } from "../index";
import { registerSchedules } from "./schedules";

const at = "2026-10-11T12:00:00Z";
const recurrence =
  "DTSTART;TZID=America/Los_Angeles:20261011T090000\nRRULE:FREQ=DAILY;COUNT=2";
const schedule: QueueSchedule = {
  id: "schedule_1",
  organization_id: "org_1",
  created_by: "user_1",
  queue_id: "queue_1",
  queue: "jobs",
  payload: { title: "é & +" },
  timing: { kind: "once", at },
  timezone: null,
  status: "active",
  pause_reason: null,
  cursor_at: null,
  next_occurrence_at: at,
  created_at: at,
  updated_at: at,
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
  let response = Response.json({ status: "ok", schedule });
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
        registerSchedules(program, {
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

describe("general schedules CLI", () => {
  test("entry point registers all commands and explains timezone and pagination", () => {
    const commands = createProgram().commands.find(
      (command) => command.name() === "schedules",
    )!;
    expect(commands.commands.map((command) => command.name())).toEqual([
      "create",
      "update",
      "list",
      "show",
      "pause",
      "resume",
      "delete",
    ]);
    let help = "";
    commands.configureOutput({
      writeOut: (value) => {
        help += value;
      },
    });
    commands.outputHelp();
    expect(help).toContain("DTSTART;TZID");
    expect(help).toContain("--cursor");
    expect(help).toContain("creator's queue authority");
  });

  test("creates once and recurring schedules from inline/file JSON with timezone preserved", async () => {
    const directory = mkdtempSync(join(tmpdir(), "saas-schedule-"));
    const path = join(directory, "payload.json");
    writeFileSync(path, JSON.stringify(schedule.payload));
    try {
      await fixture(async ({ parse, requests, outputs, respond }) => {
        await parse([
          "--json",
          "schedules",
          "create",
          "--queue",
          "jobs",
          "--payload",
          JSON.stringify(schedule.payload),
          "--at",
          at,
        ]);
        const recurringSchedule = {
          ...schedule,
          timing: { kind: "recurring", recurrence },
          timezone: "America/Los_Angeles",
          status: "paused",
        };
        respond(Response.json({ status: "ok", schedule: recurringSchedule }));
        await parse([
          "schedules",
          "create",
          "--queue",
          "jobs",
          "--payload-file",
          path,
          "--recurrence",
          recurrence,
          "--enabled",
          "off",
        ]);
        await parse([
          "schedules",
          "create",
          "--queue",
          "jobs",
          "--payload",
          "{}",
          "--recurrence",
          recurrence.replace(";TZID=America/Los_Angeles", ""),
          "--timezone",
          "America/Los_Angeles",
        ]);
        expect(requests.map((request) => request.body)).toEqual([
          {
            queue: "jobs",
            payload: schedule.payload,
            timing: { kind: "once", at },
            enabled: true,
          },
          {
            queue: "jobs",
            payload: schedule.payload,
            timing: { kind: "recurring", recurrence },
            enabled: false,
          },
          {
            queue: "jobs",
            payload: {},
            timing: { kind: "recurring", recurrence },
            enabled: true,
          },
        ]);
        expect(
          requests.every(
            (request) =>
              request.method === "POST" &&
              request.path === "/v1/orgs/org_1/schedules" &&
              request.token === "worker-token",
          ),
        ).toBe(true);
        expect(outputs[0]).toMatchObject({
          json: true,
          value: { status: "ok", schedule },
        });
        expect(outputs[1]?.human).toContain("schedule_1: jobs (paused)");
        expect(outputs[1]?.human).toContain(`Recurrence:\n${recurrence}`);
        expect(outputs[1]?.human).toContain("Timezone: America/Los_Angeles");
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("updates omit unchanged fields, replace timing, and pause/resume through PATCH", async () => {
    await fixture(async ({ parse, requests, outputs, respond }) => {
      await parse([
        "schedules",
        "update",
        "schedule_1",
        "--payload",
        '{"count":2}',
      ]);
      await parse([
        "schedules",
        "update",
        "schedule_1",
        "--recurrence",
        recurrence,
        "--timezone",
        "America/Los_Angeles",
      ]);
      await parse([
        "schedules",
        "update",
        "schedule_1",
        "--queue",
        "other_jobs",
        "--at",
        at,
      ]);
      respond(
        Response.json({
          status: "ok",
          schedule: {
            ...schedule,
            status: "paused",
            pause_reason: "Destination permission revoked",
            next_occurrence_at: null,
          },
        }),
      );
      await parse(["--json", "schedules", "pause", "schedule_1"]);
      await parse(["schedules", "resume", "schedule_1"]);
      expect(requests.map((request) => request.body)).toEqual([
        { payload: { count: 2 } },
        { timing: { kind: "recurring", recurrence } },
        { queue: "other_jobs", timing: { kind: "once", at } },
        { enabled: false },
        { enabled: true },
      ]);
      expect(
        requests.every(
          (request) =>
            request.method === "PATCH" &&
            request.path === "/v1/orgs/org_1/schedules/schedule_1",
        ),
      ).toBe(true);
      expect(outputs[3]?.json).toBe(true);
      expect(outputs[3]?.human).toContain(
        "Pause reason: Destination permission revoked",
      );
      expect(outputs[3]?.human).toContain("Next occurrence: none");
    });
  });

  test("list/show/delete preserve response envelopes, page cursors and human output", async () => {
    await fixture(async ({ parse, requests, outputs, respond }) => {
      const page = {
        status: "ok",
        items: [schedule],
        next_cursor: "next-page",
      };
      respond(Response.json(page));
      await parse([
        "--json",
        "schedules",
        "list",
        "--limit",
        "2",
        "--cursor",
        "opaque+cursor/=",
      ]);
      expect(requests[0]?.query).toBe("?limit=2&cursor=opaque%2Bcursor%2F%3D");
      expect(outputs[0]).toMatchObject({ json: true, value: page });
      expect(outputs[0]?.human).toContain("Next cursor: next-page");
      respond(Response.json({ status: "ok", items: [], next_cursor: null }));
      await parse(["schedules", "list"]);
      expect(requests[1]?.query).toBe("?limit=100");
      expect(outputs[1]?.human).toBe("No items.");
      respond(Response.json({ status: "ok", schedule }));
      await parse(["schedules", "show", "schedule_1"]);
      expect(outputs[2]?.human).toContain(`At: ${at}`);
      expect(outputs[2]?.value).toEqual({ status: "ok", schedule });
      respond(Response.json({ status: "ok" }));
      await parse(["schedules", "delete", "schedule_1", "--confirm"]);
      expect(
        requests
          .slice(2)
          .map((request) => [request.method, request.path, request.query]),
      ).toEqual([
        ["GET", "/v1/orgs/org_1/schedules/schedule_1", ""],
        ["DELETE", "/v1/orgs/org_1/schedules/schedule_1", ""],
      ]);
      expect(outputs[3]?.human).toBe("Deleted schedule 'schedule_1'.");
    });
  });

  test("ambiguous time/payload inputs and invalid CLI values send no requests", async () => {
    await fixture(async ({ parse, requests }) => {
      const create = ["create", "--queue", "jobs", "--payload", "{}"];
      for (const args of [
        create,
        [...create, "--at", at, "--recurrence", recurrence],
        [...create, "--at", at, "--timezone", "UTC"],
        [...create, "--recurrence", recurrence, "--timezone", "Europe/Paris"],
        [...create, "--recurrence", recurrence, "--timezone", "Not/AZone"],
        [...create, "--recurrence", "RRULE:FREQ=DAILY"],
        [...create, "--at", "2026-10-11T12:00:00+01:00"],
        [...create, "--at", at, "--payload-file", "unused"],
        ["create", "--queue", "jobs", "--at", at, "--payload", "{"],
        ["create", "--queue", "jobs", "--at", at, "--payload", "[]"],
        [
          "create",
          "--queue",
          "jobs",
          "--at",
          at,
          "--payload-file",
          "/no-such-payload",
        ],
        ["update", "schedule_1"],
        ["update", "schedule_1", "--enabled", "false"],
        ["delete", "schedule_1"],
        ["show", ""],
        ["list", "--limit", "1e2"],
        ["list", "--limit", "101"],
        ["list", "--cursor", ""],
      ])
        await expect(parse(["schedules", ...args])).rejects.toBeInstanceOf(
          CliError,
        );
      expect(requests).toHaveLength(0);
    });
  });

  test("server validation and authorization errors stay nonzero without success output", async () => {
    await fixture(async ({ parse, respond, outputs }) => {
      // Syntax-valid recurrence/payload semantics remain the server's responsibility.
      respond(
        Response.json(
          {
            status: "error",
            error: "SchemaValidationError",
            message: "Invalid schedule recurrence",
          },
          { status: 400 },
        ),
      );
      await expect(
        parse([
          "schedules",
          "create",
          "--queue",
          "jobs",
          "--payload",
          "{}",
          "--recurrence",
          recurrence.replace("COUNT=2", "COUNT=0"),
        ]),
      ).rejects.toThrow("Invalid schedule recurrence");
      for (const [status, message] of [
        [403, "Permission denied"],
        [404, "Schedule not found"],
        [409, "Schedule operation conflicts with current state"],
      ] as const) {
        respond(Response.json({ status: "error", message }, { status }));
        let error: unknown;
        try {
          await parse(["schedules", "resume", "schedule_1"]);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).exitCode).toBe(1);
        expect((error as Error).message).toBe(message);
      }
      respond(Response.json({ status: "error" }, { status: 401 }));
      await expect(
        parse(["schedules", "show", "schedule_1"]),
      ).rejects.toBeInstanceOf(ReauthenticationRequiredError);
      respond(new Response("invalid JSON"));
      await expect(
        parse(["schedules", "show", "schedule_1"]),
      ).rejects.toBeInstanceOf(CliError);
      expect(outputs).toHaveLength(0);
    });
  });
});
