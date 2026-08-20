import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { z } from "zod";

import { createAuditWriter } from "../../db/audit";
import type { AppEnvironment } from "../../env";
import { collectionsRouter } from "../../routes/collections";
import { recordsRouter } from "../../routes/records";
import type { McpToolContext } from "../context";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const fieldDefinitionSchema = z.union([
  z.string(),
  z.object({ type: z.string(), description: z.string().optional() }).strict(),
]);
const collectionSchema = z.record(z.string(), fieldDefinitionSchema);
const whereSchema = z.record(z.string(), z.unknown());
const aggregateMetricSchema = z.union([
  z.object({ op: z.literal("count"), as: z.string().optional() }).strict(),
  z
    .object({
      op: z.enum(["sum", "avg", "min", "max"]),
      field: z.string(),
      as: z.string().optional(),
    })
    .strict(),
]);

function pathPart(value: string): string {
  return encodeURIComponent(value);
}

function asStructuredContent(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

async function toToolResult(response: Response): Promise<CallToolResult> {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = response.ok
      ? { status: "ok", value: text }
      : {
          status: "error",
          error: `Http${response.status}`,
          message: text || response.statusText,
        };
  }

  const structuredContent = asStructuredContent(payload);
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(response.ok ? {} : { isError: true }),
  };
}

function createRouteCaller(context: McpToolContext) {
  const app = new Hono<AppEnvironment>();
  app.use("*", async (routeContext, next) => {
    routeContext.set("config", context.config);
    routeContext.set("services", context.services);
    routeContext.set("orgId", context.orgId);
    routeContext.set("userId", context.userId);
    routeContext.set(
      "audit",
      createAuditWriter(context.services.prisma, context.orgId, context.userId),
    );
    await next();
  });
  app.route("/collections", collectionsRouter);
  app.route("/collections/:name/records", recordsRouter);

  return async (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<CallToolResult> => {
    const response = await app.request(`http://mcp.local${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    return toToolResult(response);
  };
}

export function registerDataTools(
  server: McpServer,
  context: McpToolContext,
): void {
  const callRoute = createRouteCaller(context);

  server.registerTool(
    "collections_list",
    {
      description: "List collections visible to the authenticated user.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => callRoute("GET", "/collections"),
  );

  server.registerTool(
    "collections_create",
    {
      description: "Create a collection with a schema.",
      inputSchema: z
        .object({
          name: z.string().min(1),
          schema: collectionSchema,
          description: z.string().optional(),
        })
        .strict(),
      annotations: { openWorldHint: false },
    },
    async ({ name, schema, description }) =>
      callRoute("POST", "/collections", {
        name,
        schema,
        description: description ?? "",
      }),
  );

  server.registerTool(
    "collections_describe",
    {
      description: "Describe a collection and its schema.",
      inputSchema: z.object({ name: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ name }) => callRoute("GET", `/collections/${pathPart(name)}`),
  );

  server.registerTool(
    "collections_update_schema",
    {
      description: "Add, remove, or update fields in a collection schema.",
      inputSchema: z
        .object({
          name: z.string().min(1),
          add_fields: collectionSchema.optional(),
          remove_fields: z.array(z.string()).optional(),
          update_fields: z
            .record(z.string(), z.record(z.string(), z.unknown()))
            .optional(),
        })
        .strict(),
      annotations: { openWorldHint: false },
    },
    async ({ name, add_fields, remove_fields, update_fields }) =>
      callRoute("PATCH", `/collections/${pathPart(name)}/schema`, {
        ...(add_fields === undefined ? {} : { add_fields }),
        ...(remove_fields === undefined ? {} : { remove_fields }),
        ...(update_fields === undefined ? {} : { update_fields }),
      }),
  );

  server.registerTool(
    "collections_delete",
    {
      description:
        "Delete a collection and all of its records. Requires confirm=true.",
      inputSchema: z
        .object({ name: z.string().min(1), confirm: z.literal(true) })
        .strict(),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name }) =>
      callRoute("DELETE", `/collections/${pathPart(name)}?confirm=true`),
  );

  server.registerTool(
    "records_insert",
    {
      description: "Insert a record into a collection.",
      inputSchema: z
        .object({ collection: z.string().min(1), data: jsonObjectSchema })
        .strict(),
      annotations: { openWorldHint: false },
    },
    async ({ collection, data }) =>
      callRoute("POST", `/collections/${pathPart(collection)}/records`, {
        data,
      }),
  );

  server.registerTool(
    "records_get",
    {
      description: "Get a record by collection and ID.",
      inputSchema: z
        .object({ collection: z.string().min(1), id: z.string().min(1) })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ collection, id }) =>
      callRoute(
        "GET",
        `/collections/${pathPart(collection)}/records/${pathPart(id)}`,
      ),
  );

  server.registerTool(
    "records_update",
    {
      description: "Update fields on an existing record.",
      inputSchema: z
        .object({
          collection: z.string().min(1),
          id: z.string().min(1),
          data: jsonObjectSchema,
        })
        .strict(),
      annotations: { openWorldHint: false },
    },
    async ({ collection, id, data }) =>
      callRoute(
        "PATCH",
        `/collections/${pathPart(collection)}/records/${pathPart(id)}`,
        { data },
      ),
  );

  server.registerTool(
    "records_delete",
    {
      description: "Delete a record by collection and ID.",
      inputSchema: z
        .object({ collection: z.string().min(1), id: z.string().min(1) })
        .strict(),
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ collection, id }) =>
      callRoute(
        "DELETE",
        `/collections/${pathPart(collection)}/records/${pathPart(id)}`,
      ),
  );

  server.registerTool(
    "records_query",
    {
      description: "Query records with filters, sorting, and pagination.",
      inputSchema: z
        .object({
          collection: z.string().min(1),
          where: whereSchema.optional(),
          order_by: z.string().optional(),
          limit: z.number().int().min(1).max(1000).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ collection, ...query }) =>
      callRoute(
        "POST",
        `/collections/${pathPart(collection)}/records/query`,
        query,
      ),
  );

  server.registerTool(
    "records_count",
    {
      description: "Count records matching an optional filter.",
      inputSchema: z
        .object({
          collection: z.string().min(1),
          where: whereSchema.optional(),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ collection, where }) =>
      callRoute(
        "POST",
        `/collections/${pathPart(collection)}/records/count`,
        where === undefined ? {} : { where },
      ),
  );

  server.registerTool(
    "records_batch",
    {
      description: "Insert multiple records into a collection.",
      inputSchema: z
        .object({
          collection: z.string().min(1),
          records: z.array(jsonObjectSchema).min(1),
        })
        .strict(),
      annotations: { openWorldHint: false },
    },
    async ({ collection, records }) =>
      callRoute("POST", `/collections/${pathPart(collection)}/records/batch`, {
        records,
      }),
  );

  server.registerTool(
    "records_aggregate",
    {
      description: "Aggregate records with metrics and optional grouping.",
      inputSchema: z
        .object({
          collection: z.string().min(1),
          where: whereSchema.optional(),
          group_by: z.array(z.string()).optional(),
          metrics: z.array(aggregateMetricSchema).min(1),
          having: z.record(z.string(), z.unknown()).optional(),
          order_by: z.string().optional(),
          limit: z.number().int().min(1).max(1000).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ collection, ...aggregate }) =>
      callRoute(
        "POST",
        `/collections/${pathPart(collection)}/records/aggregate`,
        aggregate,
      ),
  );
}
