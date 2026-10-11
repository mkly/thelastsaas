import {
  pageRequestSchema,
  triggerCreateSchema,
  triggerIdSchema,
  triggerUpdateSchema,
  type CollectionTrigger,
  type TriggerListResponse,
  type TriggerResponse,
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
  collection?: string;
  queue?: string;
  events?: string;
  watchFields?: string;
  where?: string;
  whereFile?: string;
  mappingFile?: string;
  enabled?: string;
}

function validate<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CliError(message);
  return parsed.data;
}

async function jsonFile(path: string, option: string): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new CliError(`Could not read ${option}.`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CliError(`${option} must be valid UTF-8.`);
  }
  return parseJson(text, option);
}

async function definition(input: DefinitionOptions) {
  if (input.where !== undefined && input.whereFile !== undefined)
    throw new CliError("Supply only one of --where or --where-file.");
  if (
    input.enabled !== undefined &&
    input.enabled !== "on" &&
    input.enabled !== "off"
  )
    throw new CliError("--enabled must be on or off.");
  return {
    ...(input.collection === undefined ? {} : { collection: input.collection }),
    ...(input.queue === undefined ? {} : { queue: input.queue }),
    ...(input.events === undefined
      ? {}
      : { events: input.events.split(",").map((event) => event.trim()) }),
    ...(input.watchFields === undefined
      ? {}
      : {
          watched_fields: input.watchFields
            .split(",")
            .map((field) => field.trim()),
        }),
    ...(input.where === undefined
      ? input.whereFile === undefined
        ? {}
        : { where: await jsonFile(input.whereFile, "--where-file") }
      : { where: parseJson(input.where, "--where") }),
    ...(input.mappingFile === undefined
      ? {}
      : { mapping: await jsonFile(input.mappingFile, "--mapping-file") }),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled === "on" }),
  };
}

function definitionOptions(command: Command): Command {
  return command
    .option("--collection <name>", "Source collection")
    .option("--queue <name>", "Destination queue")
    .option("--events <list>", "Comma-separated create,update,delete events")
    .option(
      "--watch-fields <list>",
      "Comma-separated source fields (update only)",
    )
    .option("--where <json>", "Source predicate using the Where DSL")
    .option("--where-file <file>", "Read the source Where predicate from JSON")
    .option(
      "--mapping-file <file>",
      "Read an explicitly tagged payload mapping from JSON",
    )
    .option("--enabled <on|off>", "Enable or pause the trigger");
}

function details(trigger: CollectionTrigger): string {
  return [
    `${trigger.id}: ${trigger.collection} -> ${trigger.queue} (${trigger.status})`,
    `Events: ${trigger.events.join(", ")}`,
    `Watched fields: ${trigger.watched_fields?.join(", ") ?? "any changed field"}`,
    `Where: ${JSON.stringify(trigger.where)}`,
    `Mapping: ${JSON.stringify(trigger.mapping, null, 2)}`,
    `Creator: ${trigger.created_by}`,
    ...(trigger.pause_reason ? [`Pause reason: ${trigger.pause_reason}`] : []),
  ].join("\n");
}

const invalidDefinition =
  "Invalid trigger definition. Use a source collection, destination queue, distinct create/update/delete events, valid watched fields and Where predicate, and explicitly tagged mappings. Watched fields require update; before mappings cannot use create and after mappings cannot use delete.";

// Keep HTTP rejection separate from response handling to preserve API errors.
async function request(send: () => Promise<Response>): Promise<Response> {
  try {
    return await send();
  } catch {
    throw new CliError("Could not connect to The Last SaaS server.");
  }
}

export function registerTriggers(
  program: Command,
  dependencies: OperationsCommandDependencies = defaultOperationsCommandDependencies,
): void {
  const triggers = program
    .command("triggers")
    .description("Configure collection events that enqueue queue messages");
  const help = `
Triggers enqueue messages; they do not execute code.
Supply --collection, --queue, --events and --mapping-file when creating.
Use --watch-fields for changed fields and --where or --where-file for predicates.
Mapping JSON is {"destination_field":{"kind":"after","field":"source_field"}}.
Other tags are {"kind":"before","field":"source_field"},
{"kind":"literal","value":...} and {"kind":"metadata","key":"recordId"}.
Metadata keys: recordId, collectionName, event, occurredAt. No code or secret reads.
Before is unavailable for create; after is unavailable for delete.
Watched fields apply to update; no-op updates never fire.
Predicates inspect after for create/update and before for delete.
Updates revalidate the complete definition and the creator's current authority.
List returns one page; continue with --cursor using next_cursor.
`;
  triggers.addHelpText("after", help);

  async function save(input: DefinitionOptions, command: Command, id?: string) {
    if (id !== undefined) validate(triggerIdSchema, id, "Invalid trigger ID.");
    const value = await definition(input);
    // Shared create validation checks event/snapshot combinations. Patches
    // are validated against the stored definition by the server.
    const operation =
      id === undefined
        ? {
            kind: "create" as const,
            body: validate(triggerCreateSchema, value, invalidDefinition),
          }
        : {
            kind: "update" as const,
            id,
            body: validate(triggerUpdateSchema, value, invalidDefinition),
          };
    const options = getGlobalOptions(command);
    const { client, orgId } = dependencies.getOrgClient(options);
    const api = client.v1.orgs[":orgId"].triggers;
    const response = await request(() =>
      operation.kind === "create"
        ? api.$post({ param: { orgId }, json: operation.body })
        : api[":id"].$patch({
            param: { orgId, id: operation.id },
            json: operation.body,
          }),
    );
    const result = await dependencies.handleResponse<TriggerResponse>(response);
    dependencies.writeOutput(result, options, details(result.trigger));
  }

  definitionOptions(
    triggers.command("create").description("Create a trigger definition"),
  )
    .addHelpText("after", help)
    .action(
      withErrorHandling(async (input: DefinitionOptions, command: Command) =>
        save(input, command),
      ),
    );
  definitionOptions(
    triggers.command("update <id>").description("Update a trigger definition"),
  )
    .addHelpText("after", help)
    .action(
      withErrorHandling(
        async (id: string, input: DefinitionOptions, command: Command) =>
          save(input, command, id),
      ),
    );

  triggers
    .command("list")
    .description("List visible trigger definitions")
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
          const result = await dependencies.handleResponse<TriggerListResponse>(
            await request(() =>
              client.v1.orgs[":orgId"].triggers.$get({
                param: { orgId },
                query: {
                  limit: String(page.limit),
                  ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
                },
              }),
            ),
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
    const command = triggers
      .command(`${action} <id>`)
      .description(`${action[0]!.toUpperCase()}${action.slice(1)} a trigger`);
    if (action === "delete")
      command.option("--confirm", "Confirm deletion (required)");
    command.action(
      withErrorHandling(
        async (id: string, input: { confirm?: boolean }, command: Command) => {
          validate(triggerIdSchema, id, "Invalid trigger ID.");
          if (action === "delete" && !input.confirm)
            throw new CliError("Pass --confirm to delete this trigger.");
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const api = client.v1.orgs[":orgId"].triggers[":id"];
          const param = { orgId, id };
          const response = await request(() =>
            action === "delete"
              ? api.$delete({ param })
              : action === "show"
                ? api.$get({ param })
                : api.$patch({ param, json: { enabled: action === "resume" } }),
          );
          if (action === "delete") {
            const result = await dependencies.handleResponse(response);
            dependencies.writeOutput(
              result,
              options,
              `Deleted trigger '${id}'.`,
            );
          } else {
            const result =
              await dependencies.handleResponse<TriggerResponse>(response);
            dependencies.writeOutput(result, options, details(result.trigger));
          }
        },
      ),
    );
  }
}
