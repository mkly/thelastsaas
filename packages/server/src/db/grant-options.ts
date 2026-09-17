import { InvalidQueryError, type Where, type Schema } from "@lastsaas/shared";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { getCollection } from "./collections";
import { compileWhere, substitute } from "./query/compile";
import { whereSchema } from "./query/validation";

// Keep advertised MCP schemas compact; validate the full Where DSL before storage.
export const grantOptionSchema = {
  where: (z.record(z.string(), z.unknown()) as z.ZodType<Where>).optional(),
  fields: z
    .array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/))
    .max(512)
    .optional(),
};
export interface GrantOptions {
  where?: Where;
  fields?: string[];
}

// Stable serialization makes equivalent option objects safe to list/revoke.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function encodeGrantOptions(options: GrantOptions = {}): string | null {
  const normalized = {
    ...(options.where === undefined ? {} : { where: options.where }),
    ...(options.fields === undefined
      ? {}
      : { fields: [...new Set(options.fields)].sort() }),
  };
  return Object.keys(normalized).length
    ? JSON.stringify(canonical(normalized))
    : null;
}
export function decodeGrantOptions(
  value: string | null | undefined,
): GrantOptions {
  if (!value) return {};
  const parsed = z.object(grantOptionSchema).strict().parse(JSON.parse(value));
  return {
    ...parsed,
    ...(parsed.where === undefined
      ? {}
      : { where: whereSchema.parse(parsed.where) }),
  };
}
export async function validateGrantOptions(
  prisma: PrismaClient,
  orgId: string,
  resource: string,
  action: string,
  options: GrantOptions,
): Promise<void> {
  if (encodeGrantOptions(options) === null) return;
  if (
    !/^\/collections\/[^/*]+$/.test(resource) ||
    !["read", "write", "create", "update", "delete"].includes(action)
  )
    throw new InvalidQueryError(
      "where and fields require a specific collection and a read, create, update, write, or delete action",
    );
  if (action === "delete" && options.fields !== undefined)
    throw new InvalidQueryError(
      "Delete applies to a whole record; fields is not supported",
    );
  const collection = await getCollection(
    prisma,
    orgId,
    resource.slice("/collections/".length),
  );
  const schema = collection.schema as Schema;
  for (const field of options.fields ?? []) {
    if (!Object.hasOwn(schema, field))
      throw new InvalidQueryError(`Unknown collection field '${field}'`);
  }
  if (options.where !== undefined) {
    const parsed = whereSchema.safeParse(options.where);
    if (!parsed.success) throw new InvalidQueryError(parsed.error.message);
    const resolved = substitute(parsed.data, {
      userId: "validation",
      userEmail: "validation@example.com",
      orgId,
    });
    const compiled = compileWhere(resolved, schema, "sqlite");
    if (compiled.postFilters.length)
      throw new InvalidQueryError(
        "Deferred recurrence conditions are not supported in permission grants",
      );
  }
}
