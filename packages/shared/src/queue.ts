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
export const jobStateSchema = z.enum([
  "ready",
  "leased",
  "succeeded",
  "dead",
  "cancelled",
]);
export type JobState = z.infer<typeof jobStateSchema>;
/** Public metadata deliberately excludes payload, plaintext token and token hash. */
export interface QueueJob extends QueueEntryReceipt {
  state: JobState;
  attempts: number;
  available_at: string;
  lease_expires_at: string | null;
  last_error: string | null;
  completed_at: string | null;
}

export interface QueueJobDetails extends QueueJob {
  payload: JsonObject;
}

export interface QueueClaim {
  job_id: string;
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
  jobs: QueueEntryReceipt[];
}
export const queuePolicyShape = {
  max_attempts: z.number().int().min(1).max(AUTOMATION_LIMITS.maxAttempts),
  retry_delay_seconds: z.number().int().min(0).max(3600),
  lease_seconds: z.number().int().min(10).max(AUTOMATION_LIMITS.leaseSeconds),
  retention_days: z.number().int().min(1).max(AUTOMATION_LIMITS.retentionDays),
};
export const queueCreateSchema = z.strictObject({
  name: resourceNameSchema,
  schema: dynamicSchemaSchema,
  enabled: z.boolean().default(true),
  max_attempts: queuePolicyShape.max_attempts.default(3),
  retry_delay_seconds: queuePolicyShape.retry_delay_seconds.default(30),
  lease_seconds: queuePolicyShape.lease_seconds.default(60),
  retention_days: queuePolicyShape.retention_days.default(7),
});
export const queueUpdateSchema = z
  .strictObject({
    schema: dynamicSchemaSchema.optional(),
    enabled: z.boolean().optional(),
    max_attempts: queuePolicyShape.max_attempts.optional(),
    retry_delay_seconds: queuePolicyShape.retry_delay_seconds.optional(),
    lease_seconds: queuePolicyShape.lease_seconds.optional(),
    retention_days: queuePolicyShape.retention_days.optional(),
  })
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
export const jobActionSchema = z.strictObject({});
export const jobListSchema = pageRequestSchema.extend({
  where: whereSchema.optional(),
  state: jobStateSchema.optional(),
});
export const jobIdSchema = automationIdSchema;
export type QueueCreate = z.input<typeof queueCreateSchema>;
export type QueueUpdate = z.infer<typeof queueUpdateSchema>;
export type EnqueueEntry = z.infer<typeof enqueueEntrySchema>;
export type EnqueueRequest = z.infer<typeof enqueueRequestSchema>;
export type ClaimRequest = z.infer<typeof claimRequestSchema>;
export type AckRequest = z.infer<typeof ackRequestSchema>;
export type NackRequest = z.infer<typeof nackRequestSchema>;
export type ExtendRequest = z.infer<typeof extendRequestSchema>;
export type JobListRequest = z.infer<typeof jobListSchema>;

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
  listJobs(
    context: AutomationContext,
    queue: string,
    input: JobListRequest,
  ): Promise<AutomationPage<QueueJobDetails>>;
  claim(
    context: AutomationContext,
    queue: string,
    input: ClaimRequest,
  ): Promise<ClaimResult>;
  ack(
    context: AutomationContext,
    queue: string,
    job: string,
    input: AckRequest,
  ): Promise<QueueJob>;
  nack(
    context: AutomationContext,
    queue: string,
    job: string,
    input: NackRequest,
  ): Promise<QueueJob>;
  extend(
    context: AutomationContext,
    queue: string,
    job: string,
    input: ExtendRequest,
  ): Promise<QueueJob>;
  cancel(
    context: AutomationContext,
    queue: string,
    job: string,
  ): Promise<QueueJob>;
  redrive(
    context: AutomationContext,
    queue: string,
    job: string,
  ): Promise<QueueJob>;
}

/** Existing Casbin semantics, with inline constraints only on concrete payload gates. */
export const queueGrantSchema = z.strictObject({
  resource: z.string().min(1),
  action: z.enum(["read", "write", "create", "update", "manage", "delete"]),
});
export type QueueGrant = z.infer<typeof queueGrantSchema>;

export type QueueResponse = AutomationResponse<{ queue: Queue }>;

export type QueueListResponse = AutomationResponse<AutomationPage<Queue>>;

export type EnqueueResponse = AutomationResponse<EnqueueResult>;

export type JobResponse = AutomationResponse<{ job: QueueJob }>;
export type JobListResponse = AutomationResponse<
  AutomationPage<QueueJobDetails>
>;

export type ClaimResponse = AutomationResponse<ClaimResult>;
