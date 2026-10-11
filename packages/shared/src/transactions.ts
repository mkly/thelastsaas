import type { AutomationResponse } from "./automation";
import { z } from "zod";
import {
  AUTOMATION_LIMITS,
  automationIdSchema,
  collectionNameSchema,
  idempotencyKeySchema,
  jsonByteLength,
  jsonObjectSchema,
  resourceNameSchema,
  type AutomationContext,
  type JsonValue,
} from "./automation";
import { enqueueEntrySchema, type EnqueueResult } from "./queue";
import type { CollectionRecord } from "./types";

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
  z.strictObject({
    op: z.literal("queue.enqueue"),
    queue: resourceNameSchema,
    entry: enqueueEntrySchema,
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
  | { op: "record.delete"; id: string }
  | { op: "queue.enqueue"; result: EnqueueResult };
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
