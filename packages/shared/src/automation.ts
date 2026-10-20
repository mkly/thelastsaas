import { z } from "zod";
import { isValidFieldName, validateSchema } from "./validation";

export const AUTOMATION_LIMITS = {
  page: 100,
  payloadBytes: 64 * 1024,
  batch: 100,
  maxAttempts: 100,
  leaseSeconds: 3600,
  retentionDays: 365,
  nackDelaySeconds: 86400,
  triggersPerCollection: 25,
  materializePerTick: 100,
  transactionOperations: 25,
  transactionBytes: 1024 * 1024,
  transactionRetentionDays: 7,
  claimScan: 1000,
  retryBaseSeconds: 30,
  retryMaxSeconds: 3600,
} as const;

/** Same identity shape as the existing query Principal, including substitutions. */
export interface AutomationContext {
  orgId: string;
  userId: string;
  userEmail: string;
}
export interface AutomationPage<T> {
  items: T[];
  next_cursor: string | null;
}
export interface AutomationOk {
  status: "ok";
}
export type AutomationResponse<T> = AutomationOk & T;

export const resourceNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/);
// Existing collections accept any nonempty name; new resource rules must not narrow selectors.
export const collectionNameSchema = z.string().min(1);
export const automationIdSchema = z.string().min(1).max(128);
export const utcTimestampSchema = z.iso.datetime();
export const idempotencyKeySchema = z.string().min(1).max(256);
export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export type JsonObject = z.infer<typeof jsonObjectSchema>;
export function jsonByteLength(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
export const payloadSchema = jsonObjectSchema.refine(
  (value) => jsonByteLength(value) <= AUTOMATION_LIMITS.payloadBytes,
  "Payload exceeds 64 KiB of UTF-8 JSON",
);
export const pageRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(AUTOMATION_LIMITS.page).default(100),
  cursor: z.string().min(1).max(2048).optional(),
});
export type PageRequest = z.infer<typeof pageRequestSchema>;
export const dynamicSchemaSchema = z
  .record(
    z.string(),
    z.union([
      z.string(),
      z.strictObject({ type: z.string(), description: z.string().optional() }),
    ]),
  )
  .superRefine((value, ctx) => {
    for (const message of validateSchema(value))
      ctx.addIssue({ code: "custom", message });
  });
export const fieldNameSchema = z
  .string()
  .refine(isValidFieldName, "Invalid field name");
export const nonemptyPatch = (value: object): boolean =>
  Object.keys(value).length > 0;

/** Adapters preserve the common error envelope and these status codes. */
export const AUTOMATION_ERROR_STATUS = {
  InvalidRequest: 400,
  SchemaValidationError: 400,
  InvalidQueryError: 400,
  RelationshipConflictError: 409,
  Unauthorized: 401,
  PermissionDeniedError: 403,
  FieldPermissionDeniedError: 403,
  AutomationNotFoundError: 404,
  CollectionNotFoundError: 404,
  RecordNotFoundError: 404,
  FileMissingError: 404,
  AutomationConflictError: 409,
  RequestTooLarge: 413,
  AutomationUnavailableError: 503,
} as const;
