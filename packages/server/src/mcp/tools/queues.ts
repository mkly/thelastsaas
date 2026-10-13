import {
  jobListSchema,
  nonemptyPatch,
  pageRequestSchema,
  queueCreateSchema,
  queueUpdateSchema,
  resourceNameSchema,
  type AutomationContext,
} from "@lastsaas/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { transportError } from "../../lib/transport";
import {
  createQueueConfigService,
  parseQueueRequest,
} from "../../queues/config";
import { createQueueReadService } from "../../queues/read";
import { requireOrganization, type McpToolContext } from "../context";

function service(context: McpToolContext) {
  const { prisma } = context.services;
  return {
    ...createQueueConfigService(prisma),
    ...createQueueReadService(prisma),
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

// Use the REST error envelopes without exposing parser diagnostics or DB inputs.
export function registerQueueTools(
  server: McpServer,
  context: McpToolContext,
): void {
  const queueSelector = z.strictObject({ queue: resourceNameSchema });
  const queueUpdate = queueSelector
    .extend(queueUpdateSchema.shape)
    .refine(
      ({ queue: _queue, ...patch }) => nonemptyPatch(patch),
      "At least one change is required",
    );
  const jobs = jobListSchema.extend(queueSelector.shape);

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

  // Unknown control keys reach strict parsing inside execute, so SDK diagnostics
  // cannot echo them. Recursive Where stays compact in tools/list; the full shared
  // validator still checks it before any domain service is called.
  server.registerTool(
    "queues_create",
    {
      description:
        "Create an organization queue with a dynamic payload schema.",
      inputSchema: queueCreateSchema.loose(),
    },
    (input) =>
      execute(queueCreateSchema, input, async (queues, principal, parsed) => ({
        queue: await queues.create(principal, parsed),
      })),
  );
  server.registerTool(
    "queues_list",
    {
      description:
        "List readable queue configuration. Does not include entry payloads.",
      inputSchema: pageRequestSchema.loose(),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      execute(pageRequestSchema, input, async (queues, principal, parsed) => ({
        ...(await queues.list(principal, parsed)),
      })),
  );
  server.registerTool(
    "queues_show",
    {
      description: "Show queue configuration with read permission.",
      inputSchema: queueSelector.loose(),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      execute(queueSelector, input, async (queues, principal, { queue }) => ({
        queue: await queues.show(principal, queue),
      })),
  );
  server.registerTool(
    "queues_update",
    {
      description:
        "Update queue configuration with manage permission. Schema edits require no retained entries.",
      inputSchema: queueUpdate.loose(),
    },
    (input) =>
      execute(
        queueUpdate,
        input,
        async (queues, principal, { queue, ...patch }) => ({
          queue: await queues.update(principal, queue, patch),
        }),
      ),
  );
  server.registerTool(
    "queues_delete",
    {
      description:
        "Delete a queue with delete permission, only when it has no unfinished jobs.",
      inputSchema: queueSelector.loose(),
      annotations: { destructiveHint: true },
    },
    (input) =>
      execute(queueSelector, input, async (queues, principal, { queue }) => {
        await queues.delete(principal, queue);
        return {};
      }),
  );
  server.registerTool(
    "queues_jobs",
    {
      description:
        "Inspect jobs, their payloads and processing state with queue read permission. Supports payload Where filters and state filters; never returns lease tokens.",
      inputSchema: jobs
        .loose()
        .extend({ where: z.record(z.string(), z.unknown()).optional() }),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      execute(jobs, input, async (queues, principal, { queue, ...page }) => ({
        ...(await queues.listJobs(principal, queue, page)),
      })),
  );
}
