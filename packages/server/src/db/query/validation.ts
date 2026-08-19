import { z } from "zod";

import type { Where } from "@lastsaas/shared";

const RESERVED_WHERE_KEYS = new Set(["and", "or", "not"]);

const whereOpsSchema = z
  .object({
    eq: z.unknown().optional(),
    not: z.unknown().optional(),
    gt: z.unknown().optional(),
    lt: z.unknown().optional(),
    gte: z.unknown().optional(),
    lte: z.unknown().optional(),
    contains: z.string().optional(),
    in: z.array(z.unknown()).optional(),
    is_null: z.boolean().optional(),
    between: z.tuple([z.unknown(), z.unknown()]).optional(),
    occurs_between: z.tuple([z.string(), z.string()]).optional(),
  })
  .strict();

const whereLeafValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  whereOpsSchema,
]);

const whereLeafSchema: z.ZodType<Where> = z
  .record(z.string(), whereLeafValueSchema)
  .refine(
    (object) =>
      Object.keys(object).every((key) => !RESERVED_WHERE_KEYS.has(key)),
    {
      message:
        "Field names 'and', 'or', 'not' are reserved — wrap in a boolean node",
    },
  );

function whereSchemaAtDepth(depth: number): z.ZodType<Where> {
  if (depth <= 0) return whereLeafSchema;
  const child = whereSchemaAtDepth(depth - 1);
  return z.union([
    z.object({ and: z.array(child).min(1) }).strict(),
    z.object({ or: z.array(child).min(1) }).strict(),
    z.object({ not: child }).strict(),
    whereLeafSchema,
  ]);
}

/** Recursive Where validator capped at eight boolean-composition levels. */
export const whereSchema: z.ZodType<Where> = whereSchemaAtDepth(8);
