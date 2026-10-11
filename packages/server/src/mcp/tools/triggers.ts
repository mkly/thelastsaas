import {
  pageRequestSchema,
  triggerCreateSchema,
  triggerIdSchema,
  triggerUpdateSchema,
  type AutomationContext,
  type TriggerService,
} from "@lastsaas/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createTriggerService } from "../../triggers/service";
import {
  parseTriggerRequest,
  triggerTransportError,
} from "../../triggers/transport";
import { requireOrganization, type McpToolContext } from "../context";

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

export function registerTriggerTools(
  server: McpServer,
  context: McpToolContext,
): void {
  const idSchema = z.strictObject({ id: triggerIdSchema });
  const updateSchema = triggerUpdateSchema.safeExtend({ id: triggerIdSchema });
  async function execute(
    operation: (
      service: TriggerService,
      principal: AutomationContext,
    ) => Promise<Record<string, unknown>>,
  ) {
    try {
      const orgId = requireOrganization(context);
      const { prisma } = context.services;
      const user = await prisma.user.findUnique({
        where: { id: context.userId },
        select: { email: true },
      });
      return result({
        status: "ok",
        ...(await operation(createTriggerService(prisma), {
          orgId,
          userId: context.userId,
          userEmail: user?.email ?? "",
        })),
      });
    } catch (error) {
      return result({ ...triggerTransportError(error).body }, true);
    }
  }

  // Compact schemas avoid expanding recursive Where/JSON definitions. Validate
  // every control in the callback so SDK diagnostics cannot expose literals.
  const fields = {
    collection: z.unknown().describe("Source collection name"),
    queue: z.unknown().describe("Destination queue name"),
    events: z
      .unknown()
      .describe("Nonempty distinct array of create, update, delete"),
    mapping: z
      .unknown()
      .describe(
        "Destination fields mapped to tagged literal {value}, before/after {field}, or metadata {key: recordId|collectionName|event|occurredAt}",
      ),
    watched_fields: z
      .unknown()
      .optional()
      .describe("Source fields to watch, update events only"),
    where: z
      .unknown()
      .optional()
      .describe("Existing Where predicate on the event snapshot"),
    enabled: z
      .unknown()
      .optional()
      .describe("Defaults true; false pauses, true resumes after validation"),
  };
  server.registerTool(
    "triggers_create",
    {
      description:
        "Create a collection trigger that atomically publishes explicit mapped fields to a queue. Requires /triggers write, source read and destination create authority.",
      inputSchema: z.looseObject(fields),
    },
    (input) =>
      execute(async (service, principal) => ({
        trigger: await service.create(
          principal,
          parseTriggerRequest(triggerCreateSchema, input),
        ),
      })),
  );
  server.registerTool(
    "triggers_list",
    {
      description:
        "List visible trigger definitions and safe active/paused status with bounded cursor pagination.",
      inputSchema: z.looseObject({
        limit: z.unknown().optional(),
        cursor: z.unknown().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      execute(async (service, principal) => ({
        ...(await service.list(
          principal,
          parseTriggerRequest(pageRequestSchema, input),
        )),
      })),
  );
  server.registerTool(
    "triggers_show",
    {
      description:
        "Show a trigger definition and pause reason. Requires read on /triggers/<id>; never returns record snapshots or queued payloads.",
      inputSchema: z.looseObject({ id: z.unknown().describe("Trigger ID") }),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      execute(async (service, principal) => ({
        trigger: await service.show(
          principal,
          parseTriggerRequest(idSchema, input).id,
        ),
      })),
  );
  server.registerTool(
    "triggers_update",
    {
      description:
        "Edit a trigger, pause with enabled:false or resume with enabled:true. Requires update on /triggers/<id>; merged configuration rechecks the original creator's current authority.",
      inputSchema: z.looseObject({
        ...Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [key, value.optional()]),
        ),
        id: z.unknown().describe("Trigger ID"),
      }),
    },
    (input) =>
      execute(async (service, principal) => {
        const { id, ...patch } = parseTriggerRequest(updateSchema, input);
        return { trigger: await service.update(principal, id, patch) };
      }),
  );
  server.registerTool(
    "triggers_delete",
    {
      description: "Delete a trigger with delete permission on /triggers/<id>.",
      inputSchema: z.looseObject({ id: z.unknown().describe("Trigger ID") }),
      annotations: { destructiveHint: true },
    },
    (input) =>
      execute(async (service, principal) => {
        await service.delete(
          principal,
          parseTriggerRequest(idSchema, input).id,
        );
        return {};
      }),
  );
}
