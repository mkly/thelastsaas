import {
  deliveryListSchema,
  entryListSchema,
  nonemptyPatch,
  pageRequestSchema,
  queueCreateSchema,
  queueUpdateSchema,
  resourceNameSchema,
  subscriptionCreateSchema,
  subscriptionUpdateSchema,
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
import { createQueueSubscriptionService } from "../../queues/subscriptions";
import { requireOrganization, type McpToolContext } from "../context";

function service(context: McpToolContext) {
  const { prisma } = context.services;
  return {
    ...createQueueConfigService(prisma),
    ...createQueueSubscriptionService(prisma),
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
  const queuePage = pageRequestSchema.extend(queueSelector.shape);
  const subscriptionSelector = queueSelector.extend({
    subscription: resourceNameSchema,
  });
  const subscriptionCreate = subscriptionCreateSchema.extend(
    queueSelector.shape,
  );
  const queueUpdate = queueSelector
    .extend(queueUpdateSchema.shape)
    .refine(
      ({ queue: _queue, ...patch }) => nonemptyPatch(patch),
      "At least one change is required",
    );
  const subscriptionUpdate = subscriptionSelector
    .extend(subscriptionUpdateSchema.shape)
    .refine(
      ({ queue: _queue, subscription: _subscription, ...patch }) =>
        nonemptyPatch(patch),
      "At least one change is required",
    );
  const entries = entryListSchema.extend(queueSelector.shape);
  const deliveries = deliveryListSchema.extend(queueSelector.shape);

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
        "Delete a queue with delete permission, only when it has no nonterminal deliveries.",
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
    "queues_subscriptions_create",
    {
      description:
        "Create a queue subscription with manage permission. Receives future entries only.",
      inputSchema: subscriptionCreate.loose(),
    },
    (input) =>
      execute(
        subscriptionCreate,
        input,
        async (queues, principal, { queue, ...parsed }) => ({
          subscription: await queues.createSubscription(
            principal,
            queue,
            parsed,
          ),
        }),
      ),
  );
  server.registerTool(
    "queues_subscriptions_list",
    {
      description:
        "List queue subscriptions with manage permission. Does not include payloads.",
      inputSchema: queuePage.loose(),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      execute(
        queuePage,
        input,
        async (queues, principal, { queue, ...page }) => ({
          ...(await queues.listSubscriptions(principal, queue, page)),
        }),
      ),
  );
  server.registerTool(
    "queues_subscriptions_update",
    {
      description: "Update subscription settings with queue manage permission.",
      inputSchema: subscriptionUpdate.loose(),
    },
    (input) =>
      execute(
        subscriptionUpdate,
        input,
        async (queues, principal, { queue, subscription, ...patch }) => ({
          subscription: await queues.updateSubscription(
            principal,
            queue,
            subscription,
            patch,
          ),
        }),
      ),
  );
  server.registerTool(
    "queues_subscriptions_delete",
    {
      description:
        "Delete a subscription with queue manage permission, only when it has no nonterminal deliveries.",
      inputSchema: subscriptionSelector.loose(),
      annotations: { destructiveHint: true },
    },
    (input) =>
      execute(
        subscriptionSelector,
        input,
        async (queues, principal, { queue, subscription }) => {
          await queues.deleteSubscription(principal, queue, subscription);
          return {};
        },
      ),
  );
  server.registerTool(
    "queues_entries",
    {
      description:
        "Inspect entries with current queue read grants, row conditions and field projection. Where uses the shared recursive query DSL.",
      inputSchema: entries
        .loose()
        .extend({ where: z.record(z.string(), z.unknown()).optional() }),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      execute(
        entries,
        input,
        async (queues, principal, { queue, ...page }) => ({
          ...(await queues.listEntries(principal, queue, page)),
        }),
      ),
  );
  server.registerTool(
    "queues_deliveries",
    {
      description:
        "Inspect delivery metadata visible under queue read permission. Never returns payloads or lease tokens.",
      inputSchema: deliveries.loose(),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      execute(
        deliveries,
        input,
        async (queues, principal, { queue, ...page }) => ({
          ...(await queues.listDeliveries(principal, queue, page)),
        }),
      ),
  );
}
