import {
  deliveryListSchema,
  entryListSchema,
  pageRequestSchema,
  queueCreateSchema,
  queueUpdateSchema,
  resourceNameSchema,
  subscriptionCreateSchema,
  subscriptionUpdateSchema,
  type DeliveryListResponse,
  type EntryListResponse,
  type Queue,
  type QueueListResponse,
  type QueueResponse,
  type QueueSubscription,
  type SubscriptionListResponse,
  type SubscriptionResponse,
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
import { registerQueueDeliveries } from "./queue-deliveries";

interface Validator<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

function validate<T>(
  validator: Validator<T>,
  value: unknown,
  message: string,
): T {
  const parsed = validator.safeParse(value);
  if (!parsed.success) throw new CliError(message);
  return parsed.data;
}

function name(value: string): string {
  return validate(
    resourceNameSchema,
    value,
    "Names must start with a letter and contain only letters, digits or underscores (maximum 64 characters).",
  );
}

function integer(value: string | undefined): number | undefined {
  return value === undefined
    ? undefined
    : /^\d+$/.test(value)
      ? Number(value)
      : NaN;
}

function enabled(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "on") return true;
  if (value === "off") return false;
  throw new CliError("--enabled must be on or off.");
}

interface SchemaOptions {
  schema?: string;
  schemaFile?: string;
  enabled?: string;
}
async function schemaInput(input: SchemaOptions): Promise<unknown> {
  if (input.schema !== undefined && input.schemaFile !== undefined)
    throw new CliError("Supply only one of --schema or --schema-file.");
  if (input.schema !== undefined) return parseJson(input.schema, "--schema");
  if (input.schemaFile !== undefined) {
    let text: string;
    try {
      text = await readFile(input.schemaFile, "utf8");
    } catch {
      throw new CliError("Could not read --schema-file.");
    }
    return parseJson(text, "--schema-file");
  }
  return undefined;
}

interface PageOptions {
  limit?: string;
  cursor?: string;
}
function page(input: PageOptions) {
  return validate(
    pageRequestSchema,
    {
      ...(input.limit === undefined ? {} : { limit: integer(input.limit) }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    },
    "Use a limit from 1 to 100 and a nonempty cursor of at most 2048 characters.",
  );
}
function pageQuery(input: { limit: number; cursor?: string }) {
  return {
    limit: String(input.limit),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  };
}
function pageOptions(command: Command): Command {
  return command
    .option("--limit <n>", "Maximum items (1..100)")
    .option("--cursor <cursor>", "Continue from next_cursor");
}
function queueDetails(queue: Queue): string {
  return `${queue.name} (${queue.id})\n  Enabled: ${queue.enabled}\n  Schema version: ${queue.schema_version}\n  Schema: ${JSON.stringify(queue.schema)}`;
}
function subscriptionDetails(subscription: QueueSubscription): string {
  return `${subscription.name} (${subscription.id})\n  Enabled: ${subscription.enabled}\n  Max attempts: ${subscription.max_attempts}\n  Lease seconds: ${subscription.lease_seconds}\n  Retry delay seconds: ${subscription.retry_delay_seconds}\n  Retention days: ${subscription.retention_days}`;
}
function pageDetails<T>(
  result: { items: T[]; next_cursor: string | null },
  render: (item: T) => string,
): string {
  return [
    result.items.length ? result.items.map(render).join("\n\n") : "No items.",
    ...(result.next_cursor ? [`Next cursor: ${result.next_cursor}`] : []),
  ].join("\n");
}

interface SettingsOptions {
  enabled?: string;
  maxAttempts?: string;
  leaseSeconds?: string;
  retryDelaySeconds?: string;
  retentionDays?: string;
}
function settingsOptions(command: Command): Command {
  return command
    .option("--enabled <on/off>", "Enable or disable the subscription")
    .option("--max-attempts <n>", "Attempt limit (1..100, default 3)")
    .option("--lease-seconds <n>", "Lease duration (10..3600, default 60)")
    .option(
      "--retry-delay-seconds <n>",
      "Initial retry delay (0..3600, default 30)",
    )
    .option("--retention-days <n>", "Terminal retention (1..365, default 7)");
}
function settings(input: SettingsOptions) {
  return {
    ...(input.enabled === undefined ? {} : { enabled: enabled(input.enabled) }),
    ...(input.maxAttempts === undefined
      ? {}
      : { max_attempts: integer(input.maxAttempts) }),
    ...(input.retryDelaySeconds === undefined
      ? {}
      : { retry_delay_seconds: integer(input.retryDelaySeconds) }),
    ...(input.leaseSeconds === undefined
      ? {}
      : { lease_seconds: integer(input.leaseSeconds) }),
    ...(input.retentionDays === undefined
      ? {}
      : { retention_days: integer(input.retentionDays) }),
  };
}

export function registerQueues(
  program: Command,
  dependencies: OperationsCommandDependencies = defaultOperationsCommandDependencies,
): void {
  const queues = program
    .command("queues")
    .description("Manage queues, subscriptions and delivery processing");
  queues.addHelpText(
    "after",
    `
Queue create requires write on /queues. Configuration and subscriptions require
manage on /queues/<name>; queue deletion requires delete. Inspection requires
current read authority. Manage alone does not grant payload access.
Schema edits require zero retained entries. New subscriptions receive future
entries only. Separate subscriptions broadcast; workers on one share work.
Lists return one page; use next_cursor with --cursor to continue.
Enqueue requires create on the queue. Claim/ack/nack/extend require current read
and update on the queue plus update on the subscription. Cancel/redrive require
manage. Claim explicitly prints lease tokens; use --lease-token for settlement
after processing. --token authenticates the client. No command auto-acks work.
`,
  );

  for (const operation of ["create", "update"] as const) {
    queues
      .command(`${operation} <queue>`)
      .description(
        operation === "create"
          ? "Create a queue"
          : "Change schema or enabled state",
      )
      .option("-s, --schema <json>", "Queue schema as JSON")
      .option("--schema-file <path>", "Read a JSON queue schema from a file")
      .option("--enabled <on/off>", "Enable or disable the queue")
      .action(
        withErrorHandling(
          async (queue: string, input: SchemaOptions, command: Command) => {
            name(queue);
            const schema = await schemaInput(input);
            if (operation === "create" && schema === undefined)
              throw new CliError(
                "Supply --schema or --schema-file to create a queue.",
              );
            const changes = {
              ...(schema === undefined ? {} : { schema }),
              ...(input.enabled === undefined
                ? {}
                : { enabled: enabled(input.enabled) }),
            };
            const options = getGlobalOptions(command);
            const { client, orgId } = dependencies.getOrgClient(options);
            const api = client.v1.orgs[":orgId"].queues;
            const response =
              operation === "create"
                ? await api.$post({
                    param: { orgId },
                    json: validate(
                      queueCreateSchema,
                      { name: queue, ...changes },
                      "Invalid queue schema or settings.",
                    ),
                  })
                : await api[":name"].$patch({
                    param: { orgId, name: queue },
                    json: validate(
                      queueUpdateSchema,
                      changes,
                      "Supply a valid --schema, --schema-file or --enabled change.",
                    ),
                  });
            const result =
              await dependencies.handleResponse<QueueResponse>(response);
            dependencies.writeOutput(
              result,
              options,
              queueDetails(result.queue),
            );
          },
        ),
      );
  }
  pageOptions(
    queues.command("list").description("List visible queue metadata"),
  ).action(
    withErrorHandling(async (input: PageOptions, command: Command) => {
      const query = pageQuery(page(input));
      const options = getGlobalOptions(command);
      const { client, orgId } = dependencies.getOrgClient(options);
      const result = await dependencies.handleResponse<QueueListResponse>(
        await client.v1.orgs[":orgId"].queues.$get({ param: { orgId }, query }),
      );
      dependencies.writeOutput(
        result,
        options,
        pageDetails(result, queueDetails),
      );
    }),
  );
  queues
    .command("show <queue>")
    .description("Show queue metadata and schema")
    .action(
      withErrorHandling(async (queue: string, _input, command: Command) => {
        name(queue);
        const options = getGlobalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const result = await dependencies.handleResponse<QueueResponse>(
          await client.v1.orgs[":orgId"].queues[":name"].$get({
            param: { orgId, name: queue },
          }),
        );
        dependencies.writeOutput(result, options, queueDetails(result.queue));
      }),
    );
  queues
    .command("delete <queue>")
    .description("Delete a queue with no unfinished deliveries")
    .option("--confirm", "Confirm deletion (required)")
    .action(
      withErrorHandling(
        async (
          queue: string,
          input: { confirm?: boolean },
          command: Command,
        ) => {
          name(queue);
          if (!input.confirm)
            throw new CliError("Pass --confirm to delete this queue.");
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const result = await dependencies.handleResponse(
            await client.v1.orgs[":orgId"].queues[":name"].$delete({
              param: { orgId, name: queue },
            }),
          );
          dependencies.writeOutput(
            result,
            options,
            `Deleted queue '${queue}'.`,
          );
        },
      ),
    );

  const subscriptions = queues
    .command("subscriptions")
    .description("Manage independent queue subscriptions");
  for (const operation of ["create", "update"] as const) {
    settingsOptions(
      subscriptions
        .command(`${operation} <queue> <subscription>`)
        .description(
          `${operation === "create" ? "Create" : "Update"} a subscription`,
        ),
    ).action(
      withErrorHandling(
        async (
          queue: string,
          subscription: string,
          input: SettingsOptions,
          command: Command,
        ) => {
          name(queue);
          name(subscription);
          const changes = settings(input);
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const api = client.v1.orgs[":orgId"].queues[":name"].subscriptions;
          const response =
            operation === "create"
              ? await api.$post({
                  param: { orgId, name: queue },
                  json: validate(
                    subscriptionCreateSchema,
                    { name: subscription, ...changes },
                    "Invalid subscription settings: attempts 1..100, lease 10..3600, retry delay 0..3600, retention 1..365.",
                  ),
                })
              : await api[":subscription"].$patch({
                  param: { orgId, name: queue, subscription },
                  json: validate(
                    subscriptionUpdateSchema,
                    changes,
                    "Supply at least one valid subscription setting: attempts 1..100, lease 10..3600, retry delay 0..3600, retention 1..365.",
                  ),
                });
          const result =
            await dependencies.handleResponse<SubscriptionResponse>(response);
          dependencies.writeOutput(
            result,
            options,
            subscriptionDetails(result.subscription),
          );
        },
      ),
    );
  }
  pageOptions(
    subscriptions
      .command("list <queue>")
      .description("List subscription configuration"),
  ).action(
    withErrorHandling(
      async (queue: string, input: PageOptions, command: Command) => {
        name(queue);
        const query = pageQuery(page(input));
        const options = getGlobalOptions(command);
        const { client, orgId } = dependencies.getOrgClient(options);
        const result =
          await dependencies.handleResponse<SubscriptionListResponse>(
            await client.v1.orgs[":orgId"].queues[":name"].subscriptions.$get({
              param: { orgId, name: queue },
              query,
            }),
          );
        dependencies.writeOutput(
          result,
          options,
          pageDetails(result, subscriptionDetails),
        );
      },
    ),
  );
  subscriptions
    .command("delete <queue> <subscription>")
    .description("Delete a subscription with no unfinished deliveries")
    .option("--confirm", "Confirm deletion (required)")
    .action(
      withErrorHandling(
        async (
          queue: string,
          subscription: string,
          input: { confirm?: boolean },
          command: Command,
        ) => {
          name(queue);
          name(subscription);
          if (!input.confirm)
            throw new CliError("Pass --confirm to delete this subscription.");
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const result = await dependencies.handleResponse(
            await client.v1.orgs[":orgId"].queues[":name"].subscriptions[
              ":subscription"
            ].$delete({ param: { orgId, name: queue, subscription } }),
          );
          dependencies.writeOutput(
            result,
            options,
            `Deleted subscription '${subscription}' from '${queue}'.`,
          );
        },
      ),
    );

  pageOptions(
    queues
      .command("entries <queue>")
      .description("Inspect entries with whole-queue read access"),
  )
    .option("--where <json>", "Filter payloads with the Where DSL")
    .action(
      withErrorHandling(
        async (
          queue: string,
          input: PageOptions & { where?: string },
          command: Command,
        ) => {
          name(queue);
          const parsed = validate(
            entryListSchema,
            {
              ...page(input),
              ...(input.where === undefined
                ? {}
                : { where: parseJson(input.where, "--where") }),
            },
            "Invalid queue entry filter.",
          );
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const result = await dependencies.handleResponse<EntryListResponse>(
            await client.v1.orgs[":orgId"].queues[":name"].entries.$get({
              param: { orgId, name: queue },
              query: {
                ...pageQuery(parsed),
                ...(parsed.where === undefined
                  ? {}
                  : { where: JSON.stringify(parsed.where) }),
              },
            }),
          );
          dependencies.writeOutput(
            result,
            options,
            pageDetails(result, (entry) => JSON.stringify(entry, null, 2)),
          );
        },
      ),
    );
  pageOptions(
    queues
      .command("deliveries <queue>")
      .description("Inspect visible delivery metadata"),
  )
    .option("--subscription <name>", "Filter by subscription name")
    .option("--state <state>", "ready, leased, succeeded, dead or cancelled")
    .action(
      withErrorHandling(
        async (
          queue: string,
          input: PageOptions & { subscription?: string; state?: string },
          command: Command,
        ) => {
          name(queue);
          const parsed = validate(
            deliveryListSchema,
            {
              ...page(input),
              ...(input.subscription === undefined
                ? {}
                : { subscription: input.subscription }),
              ...(input.state === undefined ? {} : { state: input.state }),
            },
            "Invalid subscription name or delivery state.",
          );
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const result =
            await dependencies.handleResponse<DeliveryListResponse>(
              await client.v1.orgs[":orgId"].queues[":name"].deliveries.$get({
                param: { orgId, name: queue },
                query: {
                  ...pageQuery(parsed),
                  ...(parsed.subscription === undefined
                    ? {}
                    : { subscription: parsed.subscription }),
                  ...(parsed.state === undefined
                    ? {}
                    : { state: parsed.state }),
                },
              }),
            );
          dependencies.writeOutput(
            result,
            options,
            pageDetails(result, (delivery) =>
              JSON.stringify(delivery, null, 2),
            ),
          );
        },
      ),
    );
  registerQueueDeliveries(queues, dependencies);
}
