import {
  AUTOMATION_ERROR_STATUS,
  LastSaasError,
  SchemaValidationError,
  errorResponse,
} from "@lastsaas/shared";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { log } from "../logger";

/** Paths and issue codes help clients repair input without returning submitted values. */
class RequestValidationError extends SchemaValidationError {}
export function parseRequest<T>(
  schema: z.ZodType<T>,
  input: unknown,
  hint?: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success) throw validationError(result.error.issues, hint);
  return result.data;
}
function validationError(
  issues: readonly { path: PropertyKey[]; code: string }[],
  hint?: string,
) {
  return new RequestValidationError([
    ...issues.map(
      (issue) => `${issue.path.join(".") || "request"}: ${issue.code}`,
    ),
    ...(hint ? [hint] : []),
  ]);
}
export function errorKind(error: unknown) {
  if (!(error instanceof Error)) return "UnknownError";
  return "code" in error ? `${error.name} ${String(error.code)}` : error.name;
}
export function transportError(error: unknown) {
  if (
    error instanceof LastSaasError &&
    Object.hasOwn(AUTOMATION_ERROR_STATUS, error.code)
  ) {
    const code = error.code as keyof typeof AUTOMATION_ERROR_STATUS;
    const message =
      error instanceof RequestValidationError
        ? error.message
        : error instanceof SchemaValidationError
          ? "Invalid request"
          : code === "InvalidQueryError"
            ? "Invalid query"
            : error.message;
    return {
      body: errorResponse(code, message),
      status: AUTOMATION_ERROR_STATUS[code],
    };
  }
  log.error("api", `Operation failed (${errorKind(error)})`);
  return {
    body: errorResponse("InternalError", "Internal server error"),
    status: 500 as const,
  };
}
export function jsonRequest<S extends z.ZodType>(schema: S, hint?: string) {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) {
      const { body, status } = transportError(
        validationError(result.error.issues, hint),
      );
      return c.json(body, status);
    }
  });
}
export function queryRequest<T>(schema: z.ZodType<T>) {
  const query = z
    .record(z.string(), z.string())
    .transform((raw, ctx): unknown => {
      try {
        return {
          ...raw,
          ...(raw.limit === undefined
            ? {}
            : { limit: /^\d+$/.test(raw.limit) ? Number(raw.limit) : NaN }),
          ...(raw.where === undefined ? {} : { where: JSON.parse(raw.where) }),
        };
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["where"],
          message: "Invalid JSON query",
        });
        return z.NEVER;
      }
    })
    .pipe(schema);
  return zValidator("query", query, (result, c) => {
    if (!result.success) {
      const { body, status } = transportError(
        validationError(result.error.issues),
      );
      return c.json(body, status);
    }
  });
}
