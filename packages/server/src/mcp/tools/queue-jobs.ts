import {
  AUTOMATION_LIMITS,
  ackRequestSchema,
  claimRequestSchema,
  jobActionSchema,
  jobIdSchema,
  enqueueEntrySchema,
  enqueueRequestSchema,
  extendRequestSchema,
  nackRequestSchema,
  resourceNameSchema,
  type AutomationContext,
} from "@lastsaas/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { transportError } from "../../lib/transport";
import { createQueueClaimService } from "../../queues/claim";
import { parseQueueRequest } from "../../queues/config";
import { createQueueEnqueueService } from "../../queues/enqueue";
import { createQueueSettlementService } from "../../queues/settle";
import { requireOrganization, type McpToolContext } from "../context";

function service(context: McpToolContext) {
  const { prisma } = context.services;
  return {
    ...createQueueEnqueueService(prisma),
    ...createQueueClaimService(prisma),
    ...createQueueSettlementService(prisma),
  };
}

function result(
  payload: Record<string, unknown>,
  isError = false,
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

// Match the REST envelopes; never expose parser diagnostics or database inputs.
export function registerQueueJobTools(
  server: McpServer,
  context: McpToolContext,
): void {
  const queueSelector = z.strictObject({ queue: resourceNameSchema });
  const enqueue = enqueueRequestSchema.extend(queueSelector.shape);
  const claim = claimRequestSchema.extend(queueSelector.shape);
  const jobSelector = queueSelector.extend({ job_id: jobIdSchema });
  const ack = ackRequestSchema.extend(jobSelector.shape);
  const nack = nackRequestSchema.extend(jobSelector.shape);
  const extend = extendRequestSchema.extend(jobSelector.shape);
  const action = jobActionSchema.extend(jobSelector.shape);

  async function execute<T>(
    schema: z.ZodType<T>,
    input: unknown,
    operation: (
      queues: ReturnType<typeof service>,
      principal: AutomationContext,
      parsed: T,
    ) => Promise<Record<string, unknown>>,
  ) {
    try {
      const orgId = requireOrganization(context);
      const parsed = parseQueueRequest(schema, input);
      const user = await context.services.prisma.user.findUnique({
        where: { id: context.userId },
        select: { email: true },
      });
      const principal = {
        orgId,
        userId: context.userId,
        userEmail: user?.email ?? "",
      };
      return result({
        status: "ok",
        ...(await operation(service(context), principal, parsed)),
      });
    } catch (error) {
      return result({ ...transportError(error).body }, true);
    }
  }

  // Keep payload fields and unknown control keys out of SDK diagnostics. The
  // shared strict validator checks them inside execute before calling services.
  server.registerTool(
    "queues_enqueue",
    {
      description:
        "Enqueue an atomic batch of schema-validated messages with queue create permission. Each entry may have available_at (UTC) and an idempotency_key. Returns receipts without payloads; does not process or acknowledge work.",
      inputSchema: enqueue.loose().extend({
        entries: z
          .array(
            enqueueEntrySchema.loose().extend({
              payload: z.record(z.string(), z.unknown()),
            }),
          )
          .min(1)
          .max(AUTOMATION_LIMITS.batch),
      }),
    },
    (input) =>
      execute(
        enqueue,
        input,
        async (queues, principal, { queue, ...request }) => ({
          ...(await queues.enqueue(principal, queue, request)),
        }),
      ),
  );
  server.registerTool(
    "queues_claim",
    {
      description:
        "Lease available work with current queue read/update permission. Only this result returns lease_token. Processing is at least once: explicitly ack after work succeeds, or nack for retry; claims never auto-ack.",
      inputSchema: claim.loose(),
    },
    (input) =>
      execute(
        claim,
        input,
        async (queues, principal, { queue, ...request }) => ({
          ...(await queues.claim(principal, queue, request)),
        }),
      ),
  );
  server.registerTool(
    "queues_ack",
    {
      description:
        "Acknowledge successful processing using the current lease token and current consumer grants. Stale or replayed tokens fail; never call before work succeeds.",
      inputSchema: ack.loose(),
    },
    (input) =>
      execute(
        ack,
        input,
        async (queues, principal, { queue, job_id, ...request }) => ({
          job: await queues.ack(principal, queue, job_id, request),
        }),
      ),
  );
  server.registerTool(
    "queues_nack",
    {
      description:
        "Reject leased work using the current token and consumer grants. Retries with the queue retry backoff, becoming dead at max attempts. Optional error text must omit sensitive payloads.",
      inputSchema: nack.loose(),
    },
    (input) =>
      execute(
        nack,
        input,
        async (queues, principal, { queue, job_id, ...request }) => ({
          job: await queues.nack(principal, queue, job_id, request),
        }),
      ),
  );
  server.registerTool(
    "queues_extend",
    {
      description:
        "Extend a current claim with current consumer grants by the queue lease duration. Returns metadata without a token; the original token remains required for explicit settlement.",
      inputSchema: extend.loose(),
    },
    (input) =>
      execute(
        extend,
        input,
        async (queues, principal, { queue, job_id, ...request }) => ({
          job: await queues.extend(principal, queue, job_id, request),
        }),
      ),
  );
  server.registerTool(
    "queues_cancel",
    {
      description:
        "Cancel unfinished job with queue manage permission. Invalidates any lease without revealing its token or payload.",
      inputSchema: action.loose(),
      annotations: { destructiveHint: true },
    },
    (input) =>
      execute(action, input, async (queues, principal, { queue, job_id }) => ({
        job: await queues.cancel(principal, queue, job_id),
      })),
  );
  server.registerTool(
    "queues_redrive",
    {
      description:
        "Redrive a dead job with queue manage permission. Uses the native retry policy and preserves job identity. Returns metadata without payloads or tokens.",
      inputSchema: action.loose(),
    },
    (input) =>
      execute(action, input, async (queues, principal, { queue, job_id }) => ({
        job: await queues.redrive(principal, queue, job_id),
      })),
  );
}
