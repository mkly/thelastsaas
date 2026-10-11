import {
  pageRequestSchema,
  resourceNameSchema,
  secretCreateSchema,
  secretReplaceSchema,
  type AutomationContext,
} from "@lastsaas/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createSecretService } from "../../secrets/service";
import {
  parseSecretRequest,
  secretTransportError,
} from "../../secrets/transport";
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

export function registerSecretTools(
  server: McpServer,
  context: McpToolContext,
): void {
  const nameSchema = z.strictObject({ name: resourceNameSchema });
  const replaceSchema = secretReplaceSchema.extend({
    name: resourceNameSchema,
  });
  async function execute(
    operation: (
      service: ReturnType<typeof createSecretService>,
      principal: AutomationContext,
    ) => Promise<Record<string, unknown>>,
  ) {
    try {
      const orgId = requireOrganization(context);
      const user = await context.services.prisma.user.findUnique({
        where: { id: context.userId },
        select: { email: true },
      });
      const principal = {
        orgId,
        userId: context.userId,
        userEmail: user?.email ?? "",
      };
      const service = createSecretService(
        context.services.prisma,
        context.config.secretKeyring,
      );
      return result({ status: "ok", ...(await operation(service, principal)) });
    } catch (error) {
      return result({ ...secretTransportError(error).body }, true);
    }
  }

  // Advertise permissive objects, then validate strictly inside execute so SDK
  // validation cannot echo attacker-controlled unknown keys into error messages.
  server.registerTool(
    "secrets_create",
    {
      description:
        "Create an encrypted organization secret. Returns metadata only.",
      inputSchema: secretCreateSchema.loose(),
    },
    (input) =>
      execute(async (service, principal) => ({
        secret: await service.create(
          principal,
          parseSecretRequest(secretCreateSchema, input),
        ),
      })),
  );
  server.registerTool(
    "secrets_list",
    {
      description: "List visible secret metadata. Never returns secret values.",
      inputSchema: pageRequestSchema.loose(),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      execute(async (service, principal) => ({
        ...(await service.list(
          principal,
          parseSecretRequest(pageRequestSchema, input),
        )),
      })),
  );
  server.registerTool(
    "secrets_show",
    {
      description:
        "Show secret metadata. Value access requires explicit secrets_reveal.",
      inputSchema: nameSchema.loose(),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      execute(async (service, principal) => ({
        secret: await service.show(
          principal,
          parseSecretRequest(nameSchema, input).name,
        ),
      })),
  );
  server.registerTool(
    "secrets_replace",
    {
      description:
        "Replace an encrypted secret value with manage permission. Returns metadata only.",
      inputSchema: replaceSchema.loose(),
    },
    (input) =>
      execute(async (service, principal) => {
        const { name, value } = parseSecretRequest(replaceSchema, input);
        return { secret: await service.replace(principal, name, { value }) };
      }),
  );
  server.registerTool(
    "secrets_delete",
    {
      description: "Delete one secret with delete permission.",
      inputSchema: nameSchema.loose(),
      annotations: { destructiveHint: true },
    },
    (input) =>
      execute(async (service, principal) => {
        await service.delete(
          principal,
          parseSecretRequest(nameSchema, input).name,
        );
        return {};
      }),
  );
  server.registerTool(
    "secrets_reveal",
    {
      description:
        "Explicitly reveal a secret value. Requires read on /secrets/<name>/value; metadata read alone does not authorize reveal. The response contains sensitive plaintext.",
      inputSchema: nameSchema.loose(),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      execute(async (service, principal) => ({
        secret: await service.reveal(
          principal,
          parseSecretRequest(nameSchema, input).name,
        ),
      })),
  );
}
