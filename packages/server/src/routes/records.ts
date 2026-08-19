import {
  CollectionNotFoundError,
  FieldPermissionDeniedError,
  InvalidQueryError,
  LastSaasError,
  RecordNotFoundError,
  SchemaValidationError,
  errorResponse,
  type AggregateRequest,
} from "@lastsaas/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";

import {
  aggregateRecords,
  countRecords,
  deleteRecord,
  getRecord,
  insertRecord,
  insertRecords,
  queryRecords,
  updateRecord,
} from "../db/records";
import { whereSchema } from "../db/query/validation";
import type { AppEnvironment } from "../env";
import {
  InvalidRecurrenceError,
  RecurrenceQueryLimitError,
  RecurrenceRecordLimitError,
  RecurrenceWindowLimitError,
} from "../lib/recurrence";
import { requireCollectionPermission } from "../middleware/permission";

const dataSchema = z.record(z.string(), z.unknown());
const insertSchema = z.object({ data: dataSchema }).strict();
const batchSchema = z.object({ records: z.array(dataSchema).min(1) }).strict();
const querySchema = z
  .object({
    where: whereSchema.optional(),
    order_by: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();
const countSchema = z.object({ where: whereSchema.optional() }).strict();
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
const havingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z
    .object({
      eq: z.unknown().optional(),
      not: z.unknown().optional(),
      gt: z.unknown().optional(),
      lt: z.unknown().optional(),
      gte: z.unknown().optional(),
      lte: z.unknown().optional(),
      in: z.array(z.unknown()).optional(),
      is_null: z.boolean().optional(),
      between: z.tuple([z.unknown(), z.unknown()]).optional(),
    })
    .strict(),
]);
const aggregateSchema = z
  .object({
    where: whereSchema.optional(),
    group_by: z.array(z.string()).optional(),
    metrics: z.array(aggregateMetricSchema).min(1),
    having: z.record(z.string(), havingValueSchema).optional(),
    order_by: z.string().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

async function parseJson<T extends z.ZodType>(
  context: Context<AppEnvironment>,
  schema: T,
): Promise<
  { success: true; data: z.output<T> } | { success: false; response: Response }
> {
  const json = await context.req.json().catch(() => undefined);
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed;
  return {
    success: false,
    response: context.json(
      errorResponse(
        "ValidationError",
        parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
          .join("; "),
      ),
      400,
    ),
  };
}

function recordsError(
  context: Context<AppEnvironment>,
  error: unknown,
): Response {
  if (
    error instanceof CollectionNotFoundError ||
    error instanceof RecordNotFoundError
  ) {
    return context.json(error.toResponse(), 404);
  }
  if (
    error instanceof SchemaValidationError ||
    error instanceof InvalidQueryError
  ) {
    return context.json(error.toResponse(), 400);
  }
  if (error instanceof FieldPermissionDeniedError) {
    return context.json(error.toResponse(), 403);
  }
  if (error instanceof LastSaasError) {
    return context.json(error.toResponse(), 400);
  }
  if (
    error instanceof InvalidRecurrenceError ||
    error instanceof RecurrenceWindowLimitError ||
    error instanceof RecurrenceRecordLimitError ||
    error instanceof RecurrenceQueryLimitError
  ) {
    return context.json(errorResponse(error.code, error.message), 400);
  }
  throw error;
}

export const recordsRouter = new Hono<AppEnvironment>()
  .post("/batch", requireCollectionPermission("write"), async (context) => {
    const body = await parseJson(context, batchSchema);
    if (!body.success) return body.response;
    try {
      const result = await insertRecords(
        context.get("services").prisma,
        context.get("orgId"),
        context.req.param("name")!,
        body.data.records,
        context.get("userId"),
        context.get("fieldFilter"),
      );
      await context.get("audit")("insert_records", "record", null, {
        collection: context.req.param("name")!,
        count: result.inserted,
      });
      return context.json({ status: "ok" as const, ...result });
    } catch (error) {
      return recordsError(context, error);
    }
  })
  .post("/query", requireCollectionPermission("read"), async (context) => {
    const body = await parseJson(context, querySchema);
    if (!body.success) return body.response;
    try {
      const result = await queryRecords(
        context.get("services").prisma,
        context.get("orgId"),
        context.req.param("name")!,
        body.data.where,
        body.data.order_by,
        body.data.limit,
        body.data.offset,
        context.get("rowFilter"),
        context.get("fieldFilter"),
      );
      return context.json({ status: "ok" as const, ...result });
    } catch (error) {
      return recordsError(context, error);
    }
  })
  .post("/count", requireCollectionPermission("read"), async (context) => {
    const body = await parseJson(context, countSchema);
    if (!body.success) return body.response;
    try {
      const count = await countRecords(
        context.get("services").prisma,
        context.get("orgId"),
        context.req.param("name")!,
        body.data.where,
        context.get("rowFilter"),
        context.get("fieldFilter"),
      );
      return context.json({ status: "ok" as const, count });
    } catch (error) {
      return recordsError(context, error);
    }
  })
  .post("/aggregate", requireCollectionPermission("read"), async (context) => {
    const body = await parseJson(context, aggregateSchema);
    if (!body.success) return body.response;
    try {
      const result = await aggregateRecords(
        context.get("services").prisma,
        context.get("orgId"),
        context.req.param("name")!,
        body.data as AggregateRequest,
        context.get("rowFilter"),
        context.get("fieldFilter"),
      );
      return context.json({ status: "ok" as const, ...result });
    } catch (error) {
      return recordsError(context, error);
    }
  })
  .post("/", requireCollectionPermission("write"), async (context) => {
    const body = await parseJson(context, insertSchema);
    if (!body.success) return body.response;
    try {
      const result = await insertRecord(
        context.get("services").prisma,
        context.get("orgId"),
        context.req.param("name")!,
        body.data.data,
        context.get("userId"),
        context.get("fieldFilter"),
      );
      await context.get("audit")("insert_record", "record", result.id, {
        collection: context.req.param("name")!,
      });
      return context.json({ status: "ok" as const, ...result });
    } catch (error) {
      return recordsError(context, error);
    }
  })
  .get("/:id", requireCollectionPermission("read"), async (context) => {
    try {
      const result = await getRecord(
        context.get("services").prisma,
        context.get("orgId"),
        context.req.param("name")!,
        context.req.param("id"),
        context.get("rowFilter"),
        context.get("fieldFilter"),
      );
      return context.json({ status: "ok" as const, ...result });
    } catch (error) {
      return recordsError(context, error);
    }
  })
  .patch("/:id", requireCollectionPermission("write"), async (context) => {
    const body = await parseJson(context, insertSchema);
    if (!body.success) return body.response;
    try {
      const result = await updateRecord(
        context.get("services").prisma,
        context.get("orgId"),
        context.req.param("name")!,
        context.req.param("id"),
        body.data.data,
        context.get("rowFilter"),
        context.get("fieldFilter"),
      );
      await context.get("audit")("update_record", "record", result.id, {
        collection: context.req.param("name")!,
      });
      return context.json({ status: "ok" as const, ...result });
    } catch (error) {
      return recordsError(context, error);
    }
  })
  .delete("/:id", requireCollectionPermission("delete"), async (context) => {
    const id = context.req.param("id");
    try {
      await deleteRecord(
        context.get("services").prisma,
        context.get("orgId"),
        context.req.param("name")!,
        id,
        context.get("rowFilter"),
      );
      await context.get("audit")("delete_record", "record", id, {
        collection: context.req.param("name")!,
      });
      return context.json({
        status: "ok" as const,
        message: `Record '${id}' deleted.`,
      });
    } catch (error) {
      return recordsError(context, error);
    }
  });
