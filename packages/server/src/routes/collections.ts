import {
  CollectionExistsError,
  CollectionNotFoundError,
  LastSaasError,
  SchemaValidationError,
  errorResponse,
  type Schema,
} from "@lastsaas/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";

import {
  createCollection,
  describeCollection,
  dropCollection,
  listCollections,
  updateCollectionSchema,
} from "../db/collections";
import type { AppEnvironment } from "../env";

const fieldDefinitionSchema = z.union([
  z.string(),
  z.object({ type: z.string(), description: z.string().optional() }).strict(),
]);
const collectionSchema = z.record(z.string(), fieldDefinitionSchema);
const createBodySchema = z
  .object({
    name: z.string().min(1),
    schema: collectionSchema,
    description: z.string().optional().default(""),
  })
  .strict();
const updateBodySchema = z
  .object({
    add_fields: collectionSchema.optional(),
    remove_fields: z.array(z.string()).optional(),
    update_fields: z
      .record(z.string(), z.record(z.string(), z.unknown()))
      .optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.add_fields !== undefined ||
      body.remove_fields !== undefined ||
      body.update_fields !== undefined,
    { message: "at least one schema change is required" },
  );

async function parseJson<T extends z.ZodType>(
  context: Context<AppEnvironment>,
  schema: T,
): Promise<
  { success: true; data: z.output<T> } | { success: false; response: Response }
> {
  const json = await context.req.json().catch(() => undefined);
  const parsed = schema.safeParse(json);
  if (parsed.success) return parsed;
  const message = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
  return {
    success: false,
    response: context.json(errorResponse("ValidationError", message), 400),
  };
}

function collectionError(
  context: Context<AppEnvironment>,
  error: unknown,
): Response {
  if (error instanceof CollectionNotFoundError) {
    return context.json(error.toResponse(), 404);
  }
  if (error instanceof CollectionExistsError) {
    return context.json(error.toResponse(), 409);
  }
  if (error instanceof SchemaValidationError) {
    return context.json(error.toResponse(), 400);
  }
  if (error instanceof LastSaasError) {
    return context.json(error.toResponse(), 400);
  }
  throw error;
}

export const collectionsRouter = new Hono<AppEnvironment>()
  .post("/", async (context) => {
    const body = await parseJson(context, createBodySchema);
    if (!body.success) return body.response;
    try {
      const collection = await createCollection(
        context.get("services").prisma,
        context.get("orgId"),
        body.data.name,
        body.data.schema as Schema,
        body.data.description,
      );
      await context.get("audit")("create_collection", "collection", null, {
        collection: body.data.name,
      });
      return context.json({ status: "ok" as const, ...collection });
    } catch (error) {
      return collectionError(context, error);
    }
  })
  .get("/", async (context) => {
    const collections = await listCollections(
      context.get("services").prisma,
      context.get("orgId"),
    );
    return context.json({ status: "ok" as const, collections });
  })
  .get("/:name", async (context) => {
    try {
      const collection = await describeCollection(
        context.get("services").prisma,
        context.get("orgId"),
        context.req.param("name"),
      );
      return context.json({ status: "ok" as const, ...collection });
    } catch (error) {
      return collectionError(context, error);
    }
  })
  .patch("/:name/schema", async (context) => {
    const body = await parseJson(context, updateBodySchema);
    if (!body.success) return body.response;
    try {
      const collection = await updateCollectionSchema(
        context.get("services").prisma,
        context.get("orgId"),
        context.req.param("name"),
        body.data.add_fields as Schema | undefined,
        body.data.remove_fields,
        body.data.update_fields,
      );
      await context.get("audit")(
        "update_collection_schema",
        "collection",
        null,
        { collection: context.req.param("name") },
      );
      return context.json({ status: "ok" as const, ...collection });
    } catch (error) {
      return collectionError(context, error);
    }
  })
  .delete("/:name", async (context) => {
    if (context.req.query("confirm") !== "true") {
      return context.json(
        errorResponse(
          "ValidationError",
          "confirm: deletion requires confirm=true",
        ),
        400,
      );
    }
    const name = context.req.param("name");
    try {
      await dropCollection(
        context.get("services").prisma,
        context.get("orgId"),
        name,
      );
      await context.get("audit")("delete_collection", "collection", null, {
        collection: name,
      });
      return context.json({
        status: "ok" as const,
        message: `Collection '${name}' deleted.`,
      });
    } catch (error) {
      return collectionError(context, error);
    }
  });
