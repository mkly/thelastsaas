import type { AutomationResponse } from "./automation";
import { z } from "zod";
import {
  AUTOMATION_LIMITS,
  automationIdSchema,
  dynamicSchemaSchema,
  idempotencyKeySchema,
  nonemptyPatch,
  pageRequestSchema,
  payloadSchema,
  resourceNameSchema,
  utcTimestampSchema,
  type AutomationContext,
  type AutomationPage,
  type JsonObject,
  type PageRequest,
} from "./automation";
import type { Schema } from "./types";
import { validateRecordData } from "./validation";
import { whereSchema } from "./where";

export interface Queue {
  id: string;
  organization_id: string;
  name: string;
  schema: Schema;
  schema_version: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}
export interface QueueSubscription {
  id: string;
  queue_id: string;
  name: string;
  enabled: boolean;
  max_attempts: number;
  retry_delay_seconds: number;
  lease_seconds: number;
  retention_days: number;
  created_at: string;
  updated_at: string;
}
export interface QueueEntry {
  id: string;
  queue_id: string;
  payload: JsonObject;
  schema_version: number;
  producer_user_id: string | null;
  available_at: string;
  idempotency_key: string | null;
  created_at: string;
}
export const deliveryStateSchema = z.enum([
  "ready",
  "leased",
  "succeeded",
  "dead",
  "cancelled",
]);
export type DeliveryState = z.infer<typeof deliveryStateSchema>;
/** Public metadata deliberately excludes payload, plaintext token and token hash. */
export interface QueueDelivery {
  id: string;
  entry_id: string;
  subscription_id: string;
  state: DeliveryState;
  attempts: number;
  available_at: string;
  lease_expires_at: string | null;
  last_error: string | null;
  completed_at: string | null;
}

export interface QueueClaim {
  delivery_id: string;
  entry_id: string;
  subscription_id: string;
  payload: JsonObject;
  schema_version: number;
  attempts: number;
  lease_token: string;
  lease_expires_at: string;
}
export interface ClaimResult {
  claims: QueueClaim[];
  has_more: boolean;
}
export type QueueEntryReceipt = Omit<
  QueueEntry,
  "payload" | "producer_user_id" | "idempotency_key"
>;
export interface EnqueueResult {
  entries: QueueEntryReceipt[];
  delivery_count: number;
}
export const queueCreateSchema = z.strictObject({
  name: resourceNameSchema,
  schema: dynamicSchemaSchema,
  enabled: z.boolean().default(true),
});
export const queueUpdateSchema = z
  .strictObject({
    schema: dynamicSchemaSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine(nonemptyPatch, "At least one change is required");
const subscriptionSettings = {
  enabled: z.boolean(),
  max_attempts: z.number().int().min(1).max(AUTOMATION_LIMITS.maxAttempts),
  retry_delay_seconds: z.number().int().min(0).max(3600),
  lease_seconds: z.number().int().min(10).max(AUTOMATION_LIMITS.leaseSeconds),
  retention_days: z.number().int().min(1).max(AUTOMATION_LIMITS.retentionDays),
};
export const subscriptionCreateSchema = z.strictObject({
  name: resourceNameSchema,
  enabled: subscriptionSettings.enabled.default(true),
  max_attempts: subscriptionSettings.max_attempts.default(3),
  retry_delay_seconds: subscriptionSettings.retry_delay_seconds.default(30),
  lease_seconds: subscriptionSettings.lease_seconds.default(60),
  retention_days: subscriptionSettings.retention_days.default(7),
});
export const subscriptionUpdateSchema = z
  .strictObject(subscriptionSettings)
  .partial()
  .refine(nonemptyPatch, "At least one change is required");
export const enqueueEntrySchema = z.strictObject({
  payload: payloadSchema,
  available_at: utcTimestampSchema.optional(),
  idempotency_key: idempotencyKeySchema.optional(),
});
/** Explicit envelope avoids interpreting payload fields as batch control fields. */
export const enqueueRequestSchema = z.strictObject({
  entries: z.array(enqueueEntrySchema).min(1).max(AUTOMATION_LIMITS.batch),
});
export const claimRequestSchema = z.strictObject({
  limit: z.number().int().min(1).max(AUTOMATION_LIMITS.batch).default(1),
});
export const ackRequestSchema = z.strictObject({
  token: z.string().min(1).max(1024),
});
export const nackRequestSchema = ackRequestSchema.extend({
  error: z.string().max(1024).optional(),
});
export const extendRequestSchema = ackRequestSchema;
export const deliveryActionSchema = z.strictObject({});
export const entryListSchema = pageRequestSchema.extend({
  where: whereSchema.optional(),
});
export const deliveryListSchema = pageRequestSchema.extend({
  subscription: resourceNameSchema.optional(),
  state: deliveryStateSchema.optional(),
});
export const deliveryIdSchema = automationIdSchema;
export type QueueCreate = z.infer<typeof queueCreateSchema>;
export type QueueUpdate = z.infer<typeof queueUpdateSchema>;
export type SubscriptionCreate = z.infer<typeof subscriptionCreateSchema>;
export type SubscriptionUpdate = z.infer<typeof subscriptionUpdateSchema>;
export type EnqueueEntry = z.infer<typeof enqueueEntrySchema>;
export type EnqueueRequest = z.infer<typeof enqueueRequestSchema>;
export type ClaimRequest = z.infer<typeof claimRequestSchema>;
export type AckRequest = z.infer<typeof ackRequestSchema>;
export type NackRequest = z.infer<typeof nackRequestSchema>;
export type ExtendRequest = z.infer<typeof extendRequestSchema>;
export type EntryListRequest = z.infer<typeof entryListSchema>;
export type DeliveryListRequest = z.infer<typeof deliveryListSchema>;

/** Queue validation rejects underscore/unknown fields, unlike legacy record metadata. */
export function queuePayloadSchema(schema: Schema) {
  return payloadSchema.superRefine((value, ctx) => {
    for (const field of Object.keys(value)) {
      if (!Object.hasOwn(schema, field))
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: "Unknown payload field",
        });
    }
    for (const message of validateRecordData(value, schema))
      ctx.addIssue({ code: "custom", message });
  });
}

/** Implementations own outer transactions; nested producers use the supplied unit of work. */
export interface QueueService<UnitOfWork> {
  create(context: AutomationContext, input: QueueCreate): Promise<Queue>;
  list(
    context: AutomationContext,
    input: PageRequest,
  ): Promise<AutomationPage<Queue>>;
  show(context: AutomationContext, queue: string): Promise<Queue>;
  update(
    context: AutomationContext,
    queue: string,
    input: QueueUpdate,
  ): Promise<Queue>;
  delete(context: AutomationContext, queue: string): Promise<void>;
  createSubscription(
    context: AutomationContext,
    queue: string,
    input: SubscriptionCreate,
  ): Promise<QueueSubscription>;
  listSubscriptions(
    context: AutomationContext,
    queue: string,
    input: PageRequest,
  ): Promise<AutomationPage<QueueSubscription>>;
  updateSubscription(
    context: AutomationContext,
    queue: string,
    subscription: string,
    input: SubscriptionUpdate,
  ): Promise<QueueSubscription>;
  deleteSubscription(
    context: AutomationContext,
    queue: string,
    subscription: string,
  ): Promise<void>;
  enqueue(
    context: AutomationContext,
    queue: string,
    input: EnqueueRequest,
  ): Promise<EnqueueResult>;
  enqueueInTransaction(
    context: AutomationContext,
    unitOfWork: UnitOfWork,
    queue: string,
    input: EnqueueRequest,
  ): Promise<EnqueueResult>;
  listEntries(
    context: AutomationContext,
    queue: string,
    input: EntryListRequest,
  ): Promise<AutomationPage<QueueEntry>>;
  listDeliveries(
    context: AutomationContext,
    queue: string,
    input: DeliveryListRequest,
  ): Promise<AutomationPage<QueueDelivery>>;
  claim(
    context: AutomationContext,
    queue: string,
    subscription: string,
    input: ClaimRequest,
  ): Promise<ClaimResult>;
  ack(
    context: AutomationContext,
    queue: string,
    delivery: string,
    input: AckRequest,
  ): Promise<QueueDelivery>;
  nack(
    context: AutomationContext,
    queue: string,
    delivery: string,
    input: NackRequest,
  ): Promise<QueueDelivery>;
  extend(
    context: AutomationContext,
    queue: string,
    delivery: string,
    input: ExtendRequest,
  ): Promise<QueueDelivery>;
  cancel(
    context: AutomationContext,
    queue: string,
    delivery: string,
  ): Promise<QueueDelivery>;
  redrive(
    context: AutomationContext,
    queue: string,
    delivery: string,
  ): Promise<QueueDelivery>;
}

/** Existing Casbin semantics, with inline constraints only on concrete payload gates. */
export const queueGrantSchema = z.strictObject({
  resource: z.string().min(1),
  action: z.enum(["read", "write", "create", "update", "manage", "delete"]),
});
export type QueueGrant = z.infer<typeof queueGrantSchema>;

export type QueueResponse = AutomationResponse<{ queue: Queue }>;

export type QueueListResponse = AutomationResponse<AutomationPage<Queue>>;

export type SubscriptionResponse = AutomationResponse<{
  subscription: QueueSubscription;
}>;

export type SubscriptionListResponse = AutomationResponse<
  AutomationPage<QueueSubscription>
>;

export type EnqueueResponse = AutomationResponse<EnqueueResult>;

export type EntryListResponse = AutomationResponse<AutomationPage<QueueEntry>>;

export type DeliveryResponse = AutomationResponse<{ delivery: QueueDelivery }>;

export type DeliveryListResponse = AutomationResponse<
  AutomationPage<QueueDelivery>
>;

export type ClaimResponse = AutomationResponse<ClaimResult>;
