import type { AutomationResponse } from "./automation";
import { z } from "zod";
import {
  AUTOMATION_LIMITS,
  automationIdSchema,
  collectionNameSchema,
  idempotencyKeySchema,
  jsonByteLength,
  jsonObjectSchema,
  type AutomationContext,
  type JsonValue,
} from "./automation";
import type { CollectionRecord } from "./types";

export const TRANSACTION_OPERATIONS_HINT =
  "Transaction operations must be record.create, record.update, or record.delete";

export const transactionOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("record.create"),
    collection: collectionNameSchema,
    data: jsonObjectSchema,
  }),
  z.strictObject({
    op: z.literal("record.update"),
    collection: collectionNameSchema,
    id: automationIdSchema,
    data: jsonObjectSchema,
  }),
  z.strictObject({
    op: z.literal("record.delete"),
    collection: collectionNameSchema,
    id: automationIdSchema,
  }),
]);
export const transactionRequestSchema = z
  .strictObject({
    operations: z
      .array(transactionOperationSchema)
      .min(1)
      .max(AUTOMATION_LIMITS.transactionOperations),
    idempotency_key: idempotencyKeySchema.optional(),
  })
  .refine(
    (value) => jsonByteLength(value) <= AUTOMATION_LIMITS.transactionBytes,
    "Transaction exceeds 1 MiB of UTF-8 JSON",
  );
export type TransactionOperation = z.infer<typeof transactionOperationSchema>;
export type TransactionRequest = z.infer<typeof transactionRequestSchema>;
export type TransactionOperationResult =
  | { op: "record.create" | "record.update"; record: CollectionRecord }
  | { op: "record.delete"; id: string };
export interface TransactionResult {
  results: TransactionOperationResult[];
}
/** Persist canonical hash + full response atomically with all writes. */
export interface TransactionIdempotency {
  organization_id: string;
  principal_id: string;
  key: string;
  request_hash: string;
  response: JsonValue;
  expires_at: string;
}
export interface TransactionService {
  execute(
    context: AutomationContext,
    input: TransactionRequest,
  ): Promise<TransactionResult>;
}

export type TransactionResponse = AutomationResponse<TransactionResult>;
