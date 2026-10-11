import {
  pageRequestSchema,
  scheduleCreateSchema,
  scheduleIdSchema,
  scheduleUpdateSchema,
  type QueueSchedule,
  type ScheduleListResponse,
  type ScheduleResponse,
} from "@lastsaas/shared";
import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { parseJson, withErrorHandling } from "../api-client";
import { CliError } from "../errors";
import { getGlobalOptions } from "../index";
import {
  defaultOperationsCommandDependencies,
  type OperationsCommandDependencies,
} from "./operations-client";

interface DefinitionOptions {
  queue?: string;
  payload?: string;
  payloadFile?: string;
  at?: string;
  recurrence?: string;
  timezone?: string;
  enabled?: string;
}

function validate<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
  message: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new CliError(message);
  return result.data;
}

async function definition(input: DefinitionOptions) {
  if (input.payload !== undefined && input.payloadFile !== undefined)
    throw new CliError("Supply only one of --payload or --payload-file.");
  if (input.at !== undefined && input.recurrence !== undefined)
    throw new CliError("Supply only one of --at or --recurrence.");
  if (input.timezone !== undefined && input.recurrence === undefined)
    throw new CliError("--timezone requires --recurrence; --at is UTC.");
  if (input.enabled !== undefined && !["on", "off"].includes(input.enabled))
    throw new CliError("--enabled must be on or off.");

  let recurrence = input.recurrence;
  if (recurrence !== undefined && input.timezone !== undefined) {
    const timezone = input.timezone;
    if (!timezone || /[:;\r\n]/.test(timezone))
      throw new CliError("--timezone must be a valid IANA timezone.");
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new CliError("--timezone must be a valid IANA timezone.");
    }
    // The wire format carries timezone in DTSTART, not as a separate field.
    const embedded = /^DTSTART;TZID=([^:]+):/.exec(recurrence)?.[1];
    if (embedded !== undefined && embedded !== timezone)
      throw new CliError(
        "--timezone must match the recurrence's DTSTART;TZID.",
      );
    if (embedded === undefined)
      recurrence = recurrence.replace(/^DTSTART:/, `DTSTART;TZID=${timezone}:`);
  }

  let payload: unknown;
  if (input.payload !== undefined)
    payload = parseJson(input.payload, "--payload");
  if (input.payloadFile !== undefined) {
    let bytes: Buffer;
    try {
      bytes = await readFile(input.payloadFile);
    } catch {
      throw new CliError("Could not read --payload-file.");
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CliError("--payload-file must be valid UTF-8.");
    }
    payload = parseJson(text, "--payload-file");
  }
  return {
    ...(input.queue === undefined ? {} : { queue: input.queue }),
    ...(payload === undefined ? {} : { payload }),
    ...(input.at !== undefined
      ? { timing: { kind: "once" as const, at: input.at } }
      : recurrence !== undefined
        ? { timing: { kind: "recurring" as const, recurrence } }
        : {}),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled === "on" }),
  };
}

function definitionOptions(command: Command): Command {
  return command
    .option("--queue <name>", "Destination queue")
    .option("--payload <json>", "JSON object payload (maximum 64 KiB)")
    .option("--payload-file <path>", "Read the JSON payload from a UTF-8 file")
    .option("--at <timestamp>", "One-time UTC timestamp ending in Z")
    .option(
      "--recurrence <content>",
      "DTSTART, RRULE and optional EXDATE lines",
    )
    .option("--timezone <zone>", "IANA timezone for a local DTSTART")
    .option("--enabled <on|off>", "Enable or pause the schedule");
}

function details(schedule: QueueSchedule): string {
  return [
    `${schedule.id}: ${schedule.queue} (${schedule.status})`,
    schedule.timing.kind === "once"
      ? `At: ${schedule.timing.at}`
      : `Recurrence:\n${schedule.timing.recurrence}`,
    `Timezone: ${schedule.timezone ?? "UTC"}`,
    `Next occurrence: ${schedule.next_occurrence_at ?? "none"}`,
    `Payload: ${JSON.stringify(schedule.payload)}`,
    ...(schedule.pause_reason
      ? [`Pause reason: ${schedule.pause_reason}`]
      : []),
  ].join("\n");
}

const invalidDefinition =
  "Invalid schedule definition. Create requires --queue, a JSON object payload (maximum 64 KiB), and exactly one of --at (UTC ending in Z) or --recurrence (DTSTART;TZID, RRULE and optional EXDATE). Update requires at least one valid change.";

export function registerSchedules(
  program: Command,
  dependencies: OperationsCommandDependencies = defaultOperationsCommandDependencies,
): void {
  const schedules = program
    .command("schedules")
    .description("Schedule queue messages");
  const help = `
Create with --queue, --payload or --payload-file, and --at or --recurrence.
Recurring content uses local DTSTART;TZID=<IANA zone>:YYYYMMDDTHHMMSS,
then RRULE and optional EXDATE on separate lines. --timezone supplies TZID for
a bare local DTSTART, or must match an existing TZID. It cannot accompany --at.
Creation requires write on /schedules and current enqueue authority on the queue.
Show/list require read, edits/pause/resume require update, deletion requires delete.
The creator's queue authority is rechecked on edits and at fire time.
List returns one page; continue with --cursor using next_cursor.
`;
  schedules.addHelpText("after", help);

  async function save(input: DefinitionOptions, command: Command, id?: string) {
    if (id !== undefined)
      validate(scheduleIdSchema, id, "Invalid schedule ID.");
    const value = await definition(input);
    const operation =
      id === undefined
        ? {
            kind: "create" as const,
            body: validate(scheduleCreateSchema, value, invalidDefinition),
          }
        : {
            kind: "update" as const,
            id,
            body: validate(scheduleUpdateSchema, value, invalidDefinition),
          };
    const options = getGlobalOptions(command);
    const { client, orgId } = dependencies.getOrgClient(options);
    const api = client.v1.orgs[":orgId"].schedules;
    const response =
      operation.kind === "create"
        ? await api.$post({ param: { orgId }, json: operation.body })
        : await api[":id"].$patch({
            param: { orgId, id: operation.id },
            json: operation.body,
          });
    const result =
      await dependencies.handleResponse<ScheduleResponse>(response);
    dependencies.writeOutput(result, options, details(result.schedule));
  }

  definitionOptions(
    schedules.command("create").description("Create a queue schedule"),
  )
    .addHelpText("after", help)
    .action(
      withErrorHandling(async (input: DefinitionOptions, command: Command) =>
        save(input, command),
      ),
    );
  definitionOptions(
    schedules.command("update <id>").description("Update a queue schedule"),
  )
    .addHelpText("after", help)
    .action(
      withErrorHandling(
        async (id: string, input: DefinitionOptions, command: Command) =>
          save(input, command, id),
      ),
    );

  schedules
    .command("list")
    .description("List visible queue schedules")
    .option("--limit <n>", "Page size (1..100)")
    .option("--cursor <cursor>", "Continue from next_cursor")
    .action(
      withErrorHandling(
        async (
          input: { limit?: string; cursor?: string },
          command: Command,
        ) => {
          const page = validate(
            pageRequestSchema,
            {
              ...(input.limit === undefined
                ? {}
                : {
                    limit: /^\d+$/.test(input.limit)
                      ? Number(input.limit)
                      : NaN,
                  }),
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            },
            "Use a limit from 1 to 100 and a nonempty cursor of at most 2048 characters.",
          );
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const result =
            await dependencies.handleResponse<ScheduleListResponse>(
              await client.v1.orgs[":orgId"].schedules.$get({
                param: { orgId },
                query: {
                  limit: String(page.limit),
                  ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
                },
              }),
            );
          dependencies.writeOutput(
            result,
            options,
            [
              result.items.length
                ? result.items.map(details).join("\n\n")
                : "No items.",
              ...(result.next_cursor
                ? [`Next cursor: ${result.next_cursor}`]
                : []),
            ].join("\n"),
          );
        },
      ),
    );

  for (const action of ["show", "pause", "resume", "delete"] as const) {
    const command = schedules
      .command(`${action} <id>`)
      .description(
        `${action[0]!.toUpperCase()}${action.slice(1)} a queue schedule`,
      );
    if (action === "delete")
      command.option("--confirm", "Confirm deletion (required)");
    command.action(
      withErrorHandling(
        async (id: string, input: { confirm?: boolean }, command: Command) => {
          validate(scheduleIdSchema, id, "Invalid schedule ID.");
          if (action === "delete" && !input.confirm)
            throw new CliError("Pass --confirm to delete this schedule.");
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const api = client.v1.orgs[":orgId"].schedules[":id"];
          const param = { orgId, id };
          const response =
            action === "delete"
              ? await api.$delete({ param })
              : action === "show"
                ? await api.$get({ param })
                : await api.$patch({
                    param,
                    json: { enabled: action === "resume" },
                  });
          if (action === "delete") {
            const result = await dependencies.handleResponse(response);
            dependencies.writeOutput(
              result,
              options,
              `Deleted schedule '${id}'.`,
            );
          } else {
            const result =
              await dependencies.handleResponse<ScheduleResponse>(response);
            dependencies.writeOutput(result, options, details(result.schedule));
          }
        },
      ),
    );
  }
}
