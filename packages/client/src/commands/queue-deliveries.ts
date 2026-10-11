import {
  ackRequestSchema,
  automationIdSchema,
  claimRequestSchema,
  enqueueRequestSchema,
  extendRequestSchema,
  nackRequestSchema,
  resourceNameSchema,
  type ClaimResponse,
  type DeliveryResponse,
  type EnqueueResponse,
} from "@lastsaas/shared";
import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { parseJson, withErrorHandling } from "../api-client";
import { CliError } from "../errors";
import { getGlobalOptions } from "../index";
import type { OperationsCommandDependencies } from "./operations-client";

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
function integer(value: string | undefined): number | undefined {
  return value === undefined
    ? undefined
    : /^\d+$/.test(value)
      ? Number(value)
      : NaN;
}
function queueName(value: string): void {
  validate(resourceNameSchema, value, "Invalid queue or subscription name.");
}

interface EnqueueOptions {
  payload?: string;
  payloadFile?: string;
  availableAt?: string;
  idempotencyKey?: string;
}
async function payload(input: EnqueueOptions): Promise<unknown> {
  if ((input.payload !== undefined) === (input.payloadFile !== undefined))
    throw new CliError("Supply exactly one of --payload or --payload-file.");
  if (input.payload !== undefined) return parseJson(input.payload, "--payload");
  let text: string;
  try {
    text = await readFile(input.payloadFile!, "utf8");
  } catch {
    throw new CliError("Could not read --payload-file.");
  }
  return parseJson(text, "--payload-file");
}

export function registerQueueDeliveries(
  queues: Command,
  dependencies: OperationsCommandDependencies,
): void {
  queues
    .command("enqueue <queue>")
    .description("Enqueue one immutable message (no automatic processing)")
    .option(
      "--payload <json>",
      "Message payload as a JSON object (maximum 64 KiB)",
    )
    .option("--payload-file <path>", "Read the JSON payload from a UTF-8 file")
    .option(
      "--available-at <timestamp>",
      "Earliest availability as a UTC timestamp ending in Z",
    )
    .option(
      "--idempotency-key <key>",
      "Retry key scoped to this queue while the entry is retained",
    )
    .action(
      withErrorHandling(
        async (queue: string, input: EnqueueOptions, command: Command) => {
          queueName(queue);
          const body = validate(
            enqueueRequestSchema,
            {
              entries: [
                {
                  payload: await payload(input),
                  ...(input.availableAt === undefined
                    ? {}
                    : { available_at: input.availableAt }),
                  ...(input.idempotencyKey === undefined
                    ? {}
                    : { idempotency_key: input.idempotencyKey }),
                },
              ],
            },
            "Invalid payload, UTC availability or idempotency key.",
          );
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const result = await dependencies.handleResponse<EnqueueResponse>(
            await client.v1.orgs[":orgId"].queues[":name"].entries.$post({
              param: { orgId, name: queue },
              json: body,
            }),
          );
          dependencies.writeOutput(result, options);
        },
      ),
    );

  queues
    .command("claim <queue> <subscription>")
    .description("Lease work and explicitly print lease tokens; never auto-ack")
    .option("--limit <n>", "Maximum claims (1..100, default 1)")
    .addHelpText(
      "after",
      `
Process each returned payload, then explicitly ack with its delivery_id and
lease_token using --lease-token. Nack failed work; extend before expiry when needed.
Delivery is at least once: consumers must be idempotent. has_more can indicate
availability; poll again. An empty claim does not mean the queue is drained.
`,
    )
    .action(
      withErrorHandling(
        async (
          queue: string,
          subscription: string,
          input: { limit?: string },
          command: Command,
        ) => {
          queueName(queue);
          queueName(subscription);
          const body = validate(
            claimRequestSchema,
            {
              ...(input.limit === undefined
                ? {}
                : { limit: integer(input.limit) }),
            },
            "Use a claim limit from 1 to 100.",
          );
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const result = await dependencies.handleResponse<ClaimResponse>(
            await client.v1.orgs[":orgId"].queues[":name"].subscriptions[
              ":subscription"
            ].claim.$post({
              param: { orgId, name: queue, subscription },
              json: body,
            }),
          );
          dependencies.writeOutput(result, options);
        },
      ),
    );

  for (const operation of [
    "ack",
    "nack",
    "extend",
    "cancel",
    "redrive",
  ] as const) {
    const action = queues
      .command(`${operation} <queue> <delivery>`)
      .description(
        {
          ack: "Acknowledge successful processing using the current lease token",
          nack: "Release failed work for retry using the current lease token",
          extend: "Extend the current lease before expiry",
          cancel: "Cancel delivery (requires manage authority)",
          redrive:
            "Retry a dead or cancelled delivery (requires manage authority)",
        }[operation],
      );
    if (operation === "ack" || operation === "nack" || operation === "extend")
      action.requiredOption(
        "--lease-token <token>",
        "Opaque token from claim (--token is the authentication token)",
      );
    if (operation === "nack")
      action.option(
        "--error <text>",
        "Failure summary (maximum 1024 characters)",
      );
    action.action(
      withErrorHandling(
        async (
          queue: string,
          delivery: string,
          input: {
            leaseToken?: string;
            error?: string;
          },
          command: Command,
        ) => {
          queueName(queue);
          validate(automationIdSchema, delivery, "Invalid delivery ID.");
          const token = input.leaseToken;
          const message =
            "Invalid lease input: token required, error at most 1024 characters.";
          const options = getGlobalOptions(command);
          const { client, orgId } = dependencies.getOrgClient(options);
          const api =
            client.v1.orgs[":orgId"].queues[":name"].deliveries[":id"];
          const param = { orgId, name: queue, id: delivery };
          try {
            const response =
              operation === "ack"
                ? await api.ack.$post({
                    param,
                    json: validate(ackRequestSchema, { token }, message),
                  })
                : operation === "nack"
                  ? await api.nack.$post({
                      param,
                      json: validate(
                        nackRequestSchema,
                        {
                          token,
                          ...(input.error === undefined
                            ? {}
                            : { error: input.error }),
                        },
                        message,
                      ),
                    })
                  : operation === "extend"
                    ? await api.extend.$post({
                        param,
                        json: validate(extendRequestSchema, { token }, message),
                      })
                    : await api[operation].$post({ param, json: {} });
            const result =
              await dependencies.handleResponse<DeliveryResponse>(response);
            dependencies.writeOutput(result, options);
          } catch (error) {
            // Even an upstream error that echoes submitted input must not print a lease token.
            if (
              error instanceof Error &&
              token &&
              error.message.includes(token)
            )
              throw new CliError(
                error.message.split(token).join("[redacted]"),
                error instanceof CliError ? error.exitCode : 1,
              );
            throw error;
          }
        },
      ),
    );
  }
}
