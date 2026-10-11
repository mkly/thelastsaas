import {
  pageRequestSchema,
  scheduleCreateSchema,
  scheduleIdSchema,
  scheduleUpdateSchema,
  type AutomationContext,
  type ScheduleService,
} from "@lastsaas/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createScheduleService } from "../../schedules/service";
import {
  parseScheduleRequest,
  scheduleTransportError,
} from "../../schedules/transport";
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

export function registerScheduleTools(
  server: McpServer,
  context: McpToolContext,
): void {
  const idSchema = z.strictObject({ id: scheduleIdSchema });
  const updateSchema = scheduleUpdateSchema.safeExtend({
    id: scheduleIdSchema,
  });
  async function execute(
    operation: (
      service: ScheduleService,
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
        ...(await operation(createScheduleService(prisma), {
          orgId,
          userId: context.userId,
          userEmail: user?.email ?? "",
        })),
      });
    } catch (error) {
      return result({ ...scheduleTransportError(error).body }, true);
    }
  }

  // Validate inside callbacks so malformed private payloads are never echoed by
  // SDK diagnostics. Unknown-valued controls also keep recursive JSON compact.
  const fields = {
    queue: z.unknown().describe("Destination queue name"),
    payload: z
      .unknown()
      .describe("Schema-validated JSON message, at most 64 KiB"),
    timing: z
      .unknown()
      .describe(
        'Exactly {kind:"once",at:<UTC timestamp>} or {kind:"recurring",recurrence:<DTSTART;TZID and RRULE content>}; timezone comes from DTSTART',
      ),
    enabled: z
      .unknown()
      .optional()
      .describe(
        "Defaults true; false pauses, true resumes after creator authority validation",
      ),
  };
  server.registerTool(
    "schedules_create",
    {
      description:
        "Create a schedule that publishes a validated message to a queue at a UTC instant or recurring local time. Requires /schedules write and destination create authority.",
      inputSchema: z.looseObject(fields),
    },
    (input) =>
      execute(async (service, principal) => ({
        schedule: await service.create(
          principal,
          parseScheduleRequest(scheduleCreateSchema, input),
        ),
      })),
  );
  server.registerTool(
    "schedules_list",
    {
      description:
        "List visible schedule definitions and safe active/paused status with bounded cursor pagination.",
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
          parseScheduleRequest(pageRequestSchema, input),
        )),
      })),
  );
  server.registerTool(
    "schedules_show",
    {
      description:
        "Show a schedule definition, next occurrence and safe pause reason. Requires read on /schedules/<id>; never returns delivery or lease internals.",
      inputSchema: z.looseObject({ id: z.unknown().describe("Schedule ID") }),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      execute(async (service, principal) => ({
        schedule: await service.show(
          principal,
          parseScheduleRequest(idSchema, input).id,
        ),
      })),
  );
  server.registerTool(
    "schedules_update",
    {
      description:
        "Edit a schedule, pause with enabled:false or resume with enabled:true. Requires update on /schedules/<id>; merged configuration rechecks the original creator's current authority.",
      inputSchema: z.looseObject({
        ...Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [key, value.optional()]),
        ),
        id: z.unknown().describe("Schedule ID"),
      }),
    },
    (input) =>
      execute(async (service, principal) => {
        const { id, ...patch } = parseScheduleRequest(updateSchema, input);
        return { schedule: await service.update(principal, id, patch) };
      }),
  );
  server.registerTool(
    "schedules_delete",
    {
      description:
        "Delete a schedule with delete permission on /schedules/<id>.",
      inputSchema: z.looseObject({ id: z.unknown().describe("Schedule ID") }),
      annotations: { destructiveHint: true },
    },
    (input) =>
      execute(async (service, principal) => {
        await service.delete(
          principal,
          parseScheduleRequest(idSchema, input).id,
        );
        return {};
      }),
  );
}
