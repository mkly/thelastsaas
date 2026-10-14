import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createTransactionService } from "../../transactions/service";
import {
  parseTransactionRequest,
  transactionTransportError,
} from "../../transactions/transport";
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

export function registerTransactionTools(
  server: McpServer,
  context: McpToolContext,
): void {
  server.registerTool(
    "transactions_execute",
    {
      description:
        "Execute 1–25 ordered record.create {collection,data}, record.update {collection,id,data}, or record.delete {collection,id} operations atomically. Uses current organization and permissions. Maximum 1 MiB; literal IDs/payloads only, no SQL, code or result interpolation. Optional idempotency_key retains the response for seven days; changed content conflicts. Any failure rolls back every operation.",
      // Keep the advertised schema compact and permissive; the frozen strict
      // validator runs in the callback, yielding redacted errors for both transports.
      inputSchema: z.looseObject({
        operations: z.unknown().describe("1–25 ordered transaction operations"),
        idempotency_key: z
          .unknown()
          .optional()
          .describe("Optional nonempty key up to 256 characters"),
      }),
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async (input) => {
      try {
        const orgId = requireOrganization(context);
        const request = parseTransactionRequest(input);
        const { prisma } = context.services;
        const user = await prisma.user.findUnique({
          where: { id: context.userId },
          select: { email: true },
        });
        return result({
          status: "ok",
          ...(await createTransactionService(prisma).execute(
            { orgId, userId: context.userId, userEmail: user?.email ?? "" },
            request,
          )),
        });
      } catch (error) {
        return result({ ...transactionTransportError(error).body }, true);
      }
    },
  );
}
